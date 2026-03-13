import { pathToFileURL } from 'node:url';

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

async function readTextFromStream(stream) {
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

export function parseNotifyPayload(text) {
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

export function resolveNotifyEventName(payload) {
  if (typeof payload === 'string') {
    return asNonEmptyString(payload);
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  return (
    asNonEmptyString(payload.event) ??
    asNonEmptyString(payload.type) ??
    asNonEmptyString(payload.trigger) ??
    asNonEmptyString(payload.name) ??
    asNonEmptyString(payload.event?.name) ??
    asNonEmptyString(payload.event?.type)
  );
}

export function buildPromptIdleFaceEvent(notifyPayload, options = {}) {
  const eventName = resolveNotifyEventName(notifyPayload);
  if (eventName !== 'agent-turn-complete') {
    return null;
  }
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const sessionId =
    asNonEmptyString(options.sessionId) ??
    asNonEmptyString(options.env?.MH_BRIDGE_SESSION_ID) ??
    asNonEmptyString(options.env?.MH_OPERATOR_SESSION_ID) ??
    'default';
  const summary =
    asNonEmptyString(notifyPayload?.summary) ??
    asNonEmptyString(notifyPayload?.title) ??
    asNonEmptyString(notifyPayload?.message);

  return {
    v: 1,
    type: 'event',
    session_id: sessionId,
    ts: now,
    name: 'prompt_idle',
    severity: 0.2,
    meta: {
      source: 'codex_notify',
      notify_event: eventName,
      ...(summary ? { summary } : {})
    }
  };
}

export async function sendFaceEvent(faceWsUrl, payload, options = {}) {
  const WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
  if (typeof WebSocketCtor !== 'function') {
    throw new Error('WebSocket API is unavailable');
  }
  return await new Promise((resolve, reject) => {
    const socket = new WebSocketCtor(faceWsUrl);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(250, options.timeoutMs) : 2_000;
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // no-op
      }
      reject(new Error('notify websocket timeout'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
    }

    socket.addEventListener(
      'open',
      () => {
        try {
          socket.send(JSON.stringify(payload));
          socket.close();
          cleanup();
          resolve(true);
        } catch (error) {
          cleanup();
          reject(error);
        }
      },
      { once: true }
    );

    socket.addEventListener(
      'error',
      () => {
        cleanup();
        reject(new Error('notify websocket error'));
      },
      { once: true }
    );
  });
}

export async function runNotifyCli(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv.slice(2);
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const inputText =
    asNonEmptyString(options.inputText) ??
    asNonEmptyString(argv[0]) ??
    (await readTextFromStream(options.stdin ?? process.stdin));

  const notifyPayload = parseNotifyPayload(inputText);
  if (!notifyPayload) {
    return { emitted: false, reason: 'invalid_or_missing_payload' };
  }

  const facePayload = buildPromptIdleFaceEvent(notifyPayload, { env, now: options.now });
  if (!facePayload) {
    return { emitted: false, reason: 'ignored_event' };
  }

  const faceWsUrl = asNonEmptyString(options.faceWsUrl) ?? asNonEmptyString(env.FACE_WS_URL) ?? 'ws://127.0.0.1:8765/ws';
  try {
    await sendFaceEvent(faceWsUrl, facePayload, options);
    return { emitted: true, payload: facePayload };
  } catch (error) {
    stderr.write(`[codex-notify-to-face] ${error.message}\n`);
    return { emitted: false, reason: 'send_failed', payload: facePayload };
  }
}

async function main() {
  await runNotifyCli();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[codex-notify-to-face] ${error.message}\n`);
  });
}
