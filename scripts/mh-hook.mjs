#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { sendFaceEvent } from './codex-notify-to-face.mjs';

const CANONICAL_EVENTS = new Set(['permission_required', 'idle_after_response']);
const KNOWN_RUNTIMES = new Set(['claude', 'codex', 'antigravity']);
const STDOUT_MODES = new Set(['silent', 'antigravity-flow']);

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function parseArgs(argv = []) {
  const out = { runtime: null, event: null, stdoutMode: null };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--runtime' && i + 1 < argv.length) {
      out.runtime = argv[++i];
    } else if (tok === '--event' && i + 1 < argv.length) {
      out.event = argv[++i];
    } else if (tok === '--stdout-mode' && i + 1 < argv.length) {
      out.stdoutMode = argv[++i];
    } else if (tok.startsWith('--runtime=')) {
      out.runtime = tok.slice('--runtime='.length);
    } else if (tok.startsWith('--event=')) {
      out.event = tok.slice('--event='.length);
    } else if (tok.startsWith('--stdout-mode=')) {
      out.stdoutMode = tok.slice('--stdout-mode='.length);
    }
  }
  return out;
}

async function readStdinText(stream) {
  if (!stream || stream.isTTY) {
    return null;
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  }
  const text = chunks.join('').trim();
  return text === '' ? null : text;
}

export function parseStdinPayload(text) {
  const normalized = asNonEmptyString(text);
  if (!normalized) {
    return null;
  }
  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

export function detectCanonicalEvent({ payload, explicitEvent }) {
  if (explicitEvent) {
    if (CANONICAL_EVENTS.has(explicitEvent)) {
      return { event: explicitEvent, source: 'argv' };
    }
    return { event: null, source: 'argv', reason: 'unknown_event' };
  }
  if (!payload || typeof payload !== 'object') {
    return { event: null, source: 'none', reason: 'no_payload' };
  }
  const hookEventName = asNonEmptyString(payload.hook_event_name);
  if (hookEventName) {
    if (hookEventName === 'Notification' || hookEventName === 'PermissionRequest') {
      return { event: 'permission_required', source: 'hook_event_name' };
    }
    if (hookEventName === 'Stop') {
      return { event: 'idle_after_response', source: 'hook_event_name' };
    }
    return { event: null, source: 'hook_event_name', reason: `unhandled_${hookEventName}` };
  }
  const legacyEvent =
    asNonEmptyString(payload.event) ??
    asNonEmptyString(payload.type) ??
    asNonEmptyString(payload.trigger) ??
    asNonEmptyString(payload.name);
  if (legacyEvent === 'agent-turn-complete') {
    return { event: 'idle_after_response', source: 'legacy_notify' };
  }
  return { event: null, source: 'unrecognized', reason: 'no_known_field' };
}

export function withAuthTokenUrl(rawUrl, token) {
  const tok = asNonEmptyString(token);
  if (!tok) {
    return rawUrl;
  }
  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has('auth_token') && !url.searchParams.has('token')) {
      url.searchParams.set('auth_token', tok);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function buildHookFacePayload({ agentId, event, runtime, sessionId, now }) {
  return {
    v: 1,
    type: 'hook',
    session_id: sessionId,
    agent_id: agentId,
    ts: now(),
    event,
    runtime: runtime ?? 'unknown',
    meta: { source: 'mh_hook' }
  };
}

function buildRuntimeStdoutPayload({ stdoutMode, event }) {
  if (stdoutMode !== 'antigravity-flow') {
    return null;
  }
  if (event === 'permission_required') {
    return { decision: 'ask' };
  }
  if (event === 'idle_after_response') {
    return { decision: '' };
  }
  return {};
}

export async function runHookCli(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv.slice(2);
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const baseFaceWsUrl = asNonEmptyString(options.faceWsUrl) ?? asNonEmptyString(env.FACE_WS_URL) ?? 'ws://127.0.0.1:8765/ws';
  const faceWsUrl = withAuthTokenUrl(baseFaceWsUrl, env.MH_FACE_AUTH_TOKEN);
  const sender = typeof options.send === 'function' ? options.send : sendFaceEvent;

  const args = parseArgs(argv);
  const explicitRuntime = asNonEmptyString(args.runtime);
  if (explicitRuntime && !KNOWN_RUNTIMES.has(explicitRuntime)) {
    stderr.write(`[mh-hook] unknown runtime ${explicitRuntime}; ignoring\n`);
  }
  const runtime = explicitRuntime && KNOWN_RUNTIMES.has(explicitRuntime) ? explicitRuntime : null;
  const explicitStdoutMode = asNonEmptyString(args.stdoutMode);
  if (explicitStdoutMode && !STDOUT_MODES.has(explicitStdoutMode)) {
    stderr.write(`[mh-hook] unknown stdout mode ${explicitStdoutMode}; using runtime default\n`);
  }
  const stdoutMode =
    explicitStdoutMode && STDOUT_MODES.has(explicitStdoutMode)
      ? explicitStdoutMode
      : runtime === 'antigravity'
        ? 'antigravity-flow'
        : 'silent';

  const inputText =
    asNonEmptyString(options.inputText) ?? (await readStdinText(stdin));
  const payload = parseStdinPayload(inputText);

  const detection = detectCanonicalEvent({ payload, explicitEvent: asNonEmptyString(args.event) });
  const stdoutPayload = buildRuntimeStdoutPayload({ stdoutMode, event: detection.event });
  if (stdoutPayload && stdout && typeof stdout.write === "function") {
    stdout.write(`${JSON.stringify(stdoutPayload)}\n`);
  }
  if (!detection.event) {
    stderr.write(`[mh-hook] no canonical event detected (${detection.reason ?? detection.source}); exiting cleanly\n`);
    return { delivered: false, reason: detection.reason ?? 'no_event' };
  }

  // Per-agent suppression: MH_HOOK_SUPPRESS_EVENTS is a comma-separated list of
  // canonical events to drop without forwarding. The runtime stdout payload
  // (e.g. antigravity's {decision: ""}) has already been emitted above, so the
  // host runtime still sees a clean handoff. Used by RMH voice-first mode to
  // silence the idle_after_response phrase when the agent itself speaks every
  // turn end via face_say.
  const suppressedEvents = new Set(
    asNonEmptyString(env.MH_HOOK_SUPPRESS_EVENTS)
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  );
  if (suppressedEvents.has(detection.event)) {
    stderr.write(`[mh-hook] event ${detection.event} suppressed by MH_HOOK_SUPPRESS_EVENTS\n`);
    return { delivered: false, reason: 'suppressed_by_env', stdout_payload: stdoutPayload };
  }

  const agentId = asNonEmptyString(env.MH_FACE_AGENT_ID);
  if (!agentId) {
    stderr.write('[mh-hook] MH_FACE_AGENT_ID is not set; exiting cleanly\n');
    return { delivered: false, reason: 'missing_agent_id' };
  }

  const sessionId =
    asNonEmptyString(payload?.session_id) ??
    asNonEmptyString(env.MH_BRIDGE_SESSION_ID) ??
    asNonEmptyString(env.MH_OPERATOR_SESSION_ID) ??
    'hook';

  const facePayload = buildHookFacePayload({
    agentId,
    event: detection.event,
    runtime,
    sessionId,
    now
  });

  try {
    await sender(faceWsUrl, facePayload, { stderr });
    return { delivered: true, payload: facePayload, stdout_payload: stdoutPayload };
  } catch (error) {
    stderr.write(`[mh-hook] send failed: ${error.message}\n`);
    return { delivered: false, reason: 'send_failed', payload: facePayload, stdout_payload: stdoutPayload };
  }
}

async function main() {
  try {
    await runHookCli();
  } catch (error) {
    process.stderr.write(`[mh-hook] unexpected error: ${error?.message ?? error}\n`);
  }
  // Always exit 0 — hook runtimes (especially Antigravity Stop) treat exit 2
  // as "retry" and any non-zero as "warning/block".
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
