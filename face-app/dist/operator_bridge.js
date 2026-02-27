#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OPERATOR_PROMPT_STATES = new Set(['awaiting_input', 'awaiting_approval']);
const OPERATOR_INPUT_KINDS = new Set(['text', 'choice_single', 'key']);
const OPERATOR_RESPONSE_KINDS = new Set(['text', 'choice_single', 'key', 'restart']);
const MAX_TRACKED_SPEECH_IDS = 256;
const MAX_TRACKED_SNAPSHOTS = 32;

const KEY_TOKEN_MAP = new Map([
  ['esc', 'Escape'],
  ['escape', 'Escape'],
  ['enter', 'C-m'],
  ['return', 'C-m'],
  ['c-m', 'C-m'],
  ['up', 'Up'],
  ['arrowup', 'Up'],
  ['down', 'Down'],
  ['arrowdown', 'Down'],
  ['left', 'Left'],
  ['arrowleft', 'Left'],
  ['right', 'Right'],
  ['arrowright', 'Right'],
  ['y', 'y'],
  ['n', 'n']
]);

function toLogger(log) {
  if (!log) {
    return { info: () => {}, warn: () => {}, error: () => {} };
  }
  return {
    info: typeof log.info === 'function' ? log.info.bind(log) : console.log.bind(console),
    warn: typeof log.warn === 'function' ? log.warn.bind(log) : console.warn.bind(console),
    error: typeof log.error === 'function' ? log.error.bind(log) : console.error.bind(console)
  };
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asTimestamp(value, fallbackNow) {
  if (Number.isFinite(value)) {
    return Math.floor(value);
  }
  return fallbackNow();
}

function clampInteger(value, fallback, minValue, maxValue) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.max(minValue, Math.min(maxValue, parsed));
}

function reasonError(reason, message, cause = null) {
  const error = new Error(message);
  error.reason = reason;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

export function normalizeSessionId(value, fallback = 'default') {
  return asNonEmptyString(value) ?? fallback;
}

export function normalizeOperatorKeyToken(value) {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  return KEY_TOKEN_MAP.get(normalized) ?? null;
}

export function normalizeResponseKind(value) {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized || !OPERATOR_RESPONSE_KINDS.has(normalized)) {
    return null;
  }
  return normalized;
}

export function parseRestartPreKeys(value) {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function runProcess(command, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(100, Math.floor(options.timeoutMs)) : 8000;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(reasonError('tmux_timeout', `command timed out: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(reasonError('tmux_spawn_failed', `failed to start ${command}: ${error.message}`, error));
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(
        reasonError(
          'tmux_exit_nonzero',
          `command failed (${code}): ${command} ${args.join(' ')}${stderr ? ` (${stderr.trim()})` : ''}`
        )
      );
    });

    if (options.input !== undefined && options.input !== null) {
      child.stdin.end(String(options.input));
    } else {
      child.stdin.end();
    }
  });
}

export function createTmuxController(options = {}) {
  const pane = asNonEmptyString(options.pane);
  if (!pane) {
    throw new Error('tmux pane is required');
  }

  const log = toLogger(options.log ?? console);
  const timeoutMs = clampInteger(options.timeoutMs, 8000, 200, 120_000);
  const restartCommand = asNonEmptyString(options.restartCommand);
  const restartPreKeys = Array.isArray(options.restartPreKeys) ? options.restartPreKeys : [];
  const runCommand = typeof options.runCommand === 'function' ? options.runCommand : runProcess;
  const submitReinforceDelayMs = clampInteger(options.submitReinforceDelayMs, 90, 20, 1000);

  async function runTmux(args, input = null) {
    return runCommand('tmux', args, {
      input,
      timeoutMs
    });
  }

  async function sendRawKeyToken(token) {
    await runTmux(['send-keys', '-t', pane, token]);
  }

  async function sendRawTextLiteral(text) {
    await runTmux(['send-keys', '-t', pane, '-l', '--', text]);
  }

  async function delayMs(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  return {
    pane,
    async sendKey(tokenOrValue) {
      const token = normalizeOperatorKeyToken(tokenOrValue);
      if (!token) {
        throw reasonError('unsupported_key', `unsupported key token: ${tokenOrValue}`);
      }
      await sendRawKeyToken(token);
    },
    async sendText(value, options = {}) {
      const text = asNonEmptyString(value);
      if (!text) {
        throw reasonError('empty_text', 'text input is empty');
      }
      const submit = options.submit !== false;
      const reinforceSubmit = options.reinforceSubmit === true;

      await sendRawTextLiteral(text);
      if (submit) {
        await sendRawKeyToken('C-m');
        if (reinforceSubmit) {
          try {
            await delayMs(submitReinforceDelayMs);
            await sendRawKeyToken('C-m');
          } catch (error) {
            log.warn(`[operator-bridge] submit reinforcement failed: ${error.message}`);
          }
        }
      }
    },
    async restart() {
      if (!restartCommand) {
        throw reasonError('restart_not_configured', 'restart command is not configured');
      }
      for (const token of restartPreKeys) {
        await sendRawKeyToken(token);
      }
      await sendRawTextLiteral(restartCommand);
      await sendRawKeyToken('C-m');
    },
    async captureTail(lines) {
      const lineCount = clampInteger(lines, 200, 1, 2000);
      const result = await runTmux(['capture-pane', '-t', pane, '-p', '-e', '-S', `-${lineCount}`]);
      const normalized = result.stdout.replace(/\r/g, '');
      const split = normalized.split('\n');
      if (split.length > 0 && split[split.length - 1] === '') {
        split.pop();
      }
      return {
        pane,
        lines: split,
        truncated: split.length >= lineCount
      };
    },
    async probe() {
      try {
        await runTmux(['display-message', '-p', '-t', pane, '#{pane_id}']);
        return true;
      } catch (error) {
        log.warn(`[operator-bridge] tmux probe failed: ${error.message}`);
        return false;
      }
    }
  };
}

function normalizeChoiceValue(rawValue) {
  const value = asNonEmptyString(rawValue);
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  if (normalized === 'approve' || normalized === 'yes') {
    return 'y';
  }
  if (normalized === 'deny' || normalized === 'no') {
    return 'n';
  }
  return value;
}

export function createOperatorBridgeRuntime(options = {}) {
  const log = toLogger(options.log ?? console);
  const defaultSessionId = normalizeSessionId(options.sessionId, 'default');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const mirrorLines = clampInteger(options.mirrorLines, 200, 10, 2000);
  const enforceSpeechBeforePrompt = options.enforceSpeechBeforePrompt !== false;
  const tmuxController = options.tmuxController;
  const sendPayload = typeof options.sendPayload === 'function' ? options.sendPayload : () => false;

  if (!tmuxController) {
    throw new Error('tmuxController is required');
  }

  const activeRequestBySession = new Map();
  const spokenSayResultBySession = new Map();
  const sessionStateBySession = new Map();
  const terminalSnapshotHashBySession = new Map();

  function emit(payload) {
    const withDefaults = {
      v: 1,
      ts: now(),
      ...payload
    };
    try {
      sendPayload(withDefaults);
    } catch (error) {
      log.error(`[operator-bridge] send payload failed: ${error.message}`);
    }
    return withDefaults;
  }

  function getSessionState(sessionId) {
    const existing = sessionStateBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    const initial = {
      bridge_online: true,
      tmux_online: true,
      recovery_mode: false,
      no_response: false,
      reason: null
    };
    sessionStateBySession.set(sessionId, initial);
    return initial;
  }

  function updateSessionState(sessionId, patch) {
    const current = getSessionState(sessionId);
    const next = {
      ...current,
      ...patch
    };
    sessionStateBySession.set(sessionId, next);
    return next;
  }

  function emitState(sessionId, patch = null) {
    const effectiveSessionId = normalizeSessionId(sessionId, defaultSessionId);
    if (patch && typeof patch === 'object') {
      updateSessionState(effectiveSessionId, patch);
    }
    const base = getSessionState(effectiveSessionId);
    const active = activeRequestBySession.get(effectiveSessionId) ?? null;
    emit({
      type: 'operator_state',
      session_id: effectiveSessionId,
      bridge_online: base.bridge_online,
      tmux_online: base.tmux_online,
      recovery_mode: base.recovery_mode,
      no_response: base.no_response,
      awaiting: Boolean(active),
      request_id: active ? active.request_id : null,
      reason: base.reason ?? null
    });
  }

  function emitAck(sessionId, requestId, ok, stage, reason = null, detail = null) {
    emit({
      type: 'operator_ack',
      session_id: normalizeSessionId(sessionId, defaultSessionId),
      request_id: requestId ?? null,
      ok,
      stage,
      reason: reason ?? null,
      detail: detail ?? null
    });
  }

  function trackSpokenSayResult(payload) {
    if (payload.spoken !== true) {
      return;
    }
    const messageId = asNonEmptyString(payload.message_id);
    if (!messageId) {
      return;
    }

    const sessionId = normalizeSessionId(payload.session_id, defaultSessionId);
    const map = spokenSayResultBySession.get(sessionId) ?? new Map();
    map.set(messageId, asTimestamp(payload.ts, now));
    while (map.size > MAX_TRACKED_SPEECH_IDS) {
      const oldest = map.keys().next().value;
      map.delete(oldest);
    }
    spokenSayResultBySession.set(sessionId, map);
  }

  function validatePrompt(payload, sessionId) {
    const requestId = asNonEmptyString(payload.request_id);
    if (!requestId) {
      return { ok: false, reason: 'invalid_prompt', detail: 'missing request_id' };
    }

    const state = asNonEmptyString(payload.state);
    if (!state || !OPERATOR_PROMPT_STATES.has(state)) {
      return { ok: false, reason: 'invalid_prompt', detail: 'invalid state' };
    }

    const inputKind = asNonEmptyString(payload.input_kind);
    if (!inputKind || !OPERATOR_INPUT_KINDS.has(inputKind)) {
      return { ok: false, reason: 'invalid_prompt', detail: 'invalid input_kind' };
    }

    const speechMessageId = asNonEmptyString(payload.speech_message_id);
    if (!speechMessageId) {
      return { ok: false, reason: 'speech_order_violation', detail: 'missing speech_message_id' };
    }

    if (enforceSpeechBeforePrompt) {
      const spoken = spokenSayResultBySession.get(sessionId);
      const spokenTs = spoken?.get(speechMessageId);
      if (!Number.isFinite(spokenTs)) {
        return { ok: false, reason: 'speech_not_confirmed', detail: speechMessageId };
      }
      const promptTs = asTimestamp(payload.ts, now);
      if (promptTs < spokenTs) {
        return { ok: false, reason: 'speech_order_violation', detail: 'prompt ts earlier than speech ts' };
      }
    }

    return {
      ok: true,
      requestId,
      state,
      inputKind,
      speechMessageId
    };
  }

  async function handleOperatorPrompt(payload) {
    const sessionId = normalizeSessionId(payload.session_id, defaultSessionId);
    const validated = validatePrompt(payload, sessionId);
    if (!validated.ok) {
      emitAck(sessionId, asNonEmptyString(payload.request_id), false, 'rejected', validated.reason, validated.detail);
      return;
    }

    activeRequestBySession.set(sessionId, {
      request_id: validated.requestId,
      state: validated.state,
      input_kind: validated.inputKind,
      prompt: asNonEmptyString(payload.prompt) ?? '',
      choices: Array.isArray(payload.choices) ? payload.choices.map((item) => String(item)) : null
    });

    emitAck(sessionId, validated.requestId, true, 'accepted', null, null);
    emitState(sessionId);
  }

  async function handleOperatorResponse(payload) {
    const sessionId = normalizeSessionId(payload.session_id, defaultSessionId);
    const responseKind = normalizeResponseKind(payload.response_kind);
    if (!responseKind) {
      emitAck(sessionId, asNonEmptyString(payload.request_id), false, 'rejected', 'invalid_response', 'invalid response_kind');
      return;
    }

    const active = activeRequestBySession.get(sessionId) ?? null;
    const suppliedRequestId = asNonEmptyString(payload.request_id);
    const requestId = suppliedRequestId ?? (active ? active.request_id : null);
    const isManualFreeText = !requestId && !active && responseKind === 'text';
    const isManualFreeChoice = !requestId && !active && responseKind === 'choice_single';

    if (responseKind !== 'key' && responseKind !== 'restart' && !requestId && !isManualFreeText && !isManualFreeChoice) {
      emitAck(sessionId, null, false, 'rejected', 'request_missing', 'request_id is required');
      return;
    }

    if (requestId && (!active || active.request_id !== requestId)) {
      emitAck(sessionId, requestId, false, 'rejected', 'request_mismatch', 'active request does not match');
      return;
    }

    emitAck(sessionId, requestId, true, 'received', null, null);

    try {
      if (responseKind === 'key') {
        const token = normalizeOperatorKeyToken(payload.value);
        if (!token) {
          throw reasonError('unsupported_key', 'unsupported key');
        }
        await tmuxController.sendKey(token);
      } else if (responseKind === 'restart') {
        await tmuxController.restart();
      } else if (responseKind === 'text') {
        const text = asNonEmptyString(payload.value);
        if (!text) {
          throw reasonError('empty_text', 'text value is empty');
        }
        await tmuxController.sendText(text, {
          submit: payload.submit !== false,
          reinforceSubmit: isManualFreeText
        });
      } else if (responseKind === 'choice_single') {
        const choice = normalizeChoiceValue(payload.value);
        if (!choice) {
          throw reasonError('empty_choice', 'choice value is empty');
        }
        await tmuxController.sendText(choice, {
          submit: payload.submit !== false,
          reinforceSubmit: isManualFreeChoice
        });
      }

      updateSessionState(sessionId, {
        tmux_online: true,
        recovery_mode: false,
        reason: null
      });

      if (requestId && responseKind !== 'key') {
        activeRequestBySession.delete(sessionId);
      }

      emitAck(sessionId, requestId, true, 'sent_to_tmux', null, null);
      emitState(sessionId);
    } catch (error) {
      const reason = asNonEmptyString(error?.reason) ?? 'tmux_send_failed';
      updateSessionState(sessionId, {
        tmux_online: false,
        recovery_mode: true,
        reason
      });
      emitAck(sessionId, requestId, false, 'failed', reason, error.message);
      emitState(sessionId);
    }
  }

  async function publishTerminalSnapshot(sessionId = defaultSessionId) {
    const effectiveSessionId = normalizeSessionId(sessionId, defaultSessionId);

    try {
      const snapshot = await tmuxController.captureTail(mirrorLines);
      const hash = snapshot.lines.join('\n');
      const previousHash = terminalSnapshotHashBySession.get(effectiveSessionId);
      if (hash === previousHash) {
        return false;
      }

      terminalSnapshotHashBySession.set(effectiveSessionId, hash);
      while (terminalSnapshotHashBySession.size > MAX_TRACKED_SNAPSHOTS) {
        const oldest = terminalSnapshotHashBySession.keys().next().value;
        terminalSnapshotHashBySession.delete(oldest);
      }

      emit({
        type: 'operator_terminal_snapshot',
        session_id: effectiveSessionId,
        pane: snapshot.pane,
        lines: snapshot.lines,
        truncated: Boolean(snapshot.truncated)
      });

      updateSessionState(effectiveSessionId, {
        tmux_online: true,
        reason: null
      });
      return true;
    } catch (error) {
      const reason = asNonEmptyString(error?.reason) ?? 'mirror_capture_failed';
      updateSessionState(effectiveSessionId, {
        tmux_online: false,
        recovery_mode: true,
        reason
      });
      emitState(effectiveSessionId);
      return false;
    }
  }

  return {
    async handlePayload(payload) {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      if (payload.type === 'say_result') {
        trackSpokenSayResult(payload);
        return;
      }

      if (payload.type === 'operator_prompt') {
        await handleOperatorPrompt(payload);
        return;
      }

      if (payload.type === 'operator_response') {
        await handleOperatorResponse(payload);
      }
    },
    publishTerminalSnapshot,
    emitState,
    setBridgeOnline(sessionId, online) {
      emitState(sessionId, {
        bridge_online: Boolean(online),
        reason: online ? null : 'bridge_offline'
      });
    },
    setRecoveryMode(sessionId, recoveryMode, reason = null) {
      emitState(sessionId, {
        recovery_mode: Boolean(recoveryMode),
        reason: reason ?? null
      });
    },
    getActiveRequest(sessionId = defaultSessionId) {
      return activeRequestBySession.get(normalizeSessionId(sessionId, defaultSessionId)) ?? null;
    }
  };
}

export function startOperatorBridge(options = {}) {
  const wsUrl = asNonEmptyString(options.wsUrl) ?? 'ws://127.0.0.1:8765/ws';
  const sessionId = normalizeSessionId(options.sessionId, 'default');
  const mirrorIntervalMs = clampInteger(options.mirrorIntervalMs, 500, 200, 60_000);
  const reconnectMinMs = clampInteger(options.reconnectMinMs, 900, 200, 10_000);
  const reconnectMaxMs = clampInteger(options.reconnectMaxMs, 6000, reconnectMinMs, 60_000);
  const log = toLogger(options.log ?? console);

  const tmuxController =
    options.tmuxController ??
    createTmuxController({
      pane: options.tmuxPane,
      timeoutMs: options.tmuxTimeoutMs,
      restartCommand: options.restartCommand,
      restartPreKeys: options.restartPreKeys,
      log
    });

  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let mirrorTimer = null;
  let reconnectAttempts = 0;

  const runtime = createOperatorBridgeRuntime({
    sessionId,
    tmuxController,
    mirrorLines: options.mirrorLines,
    sendPayload(payload) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      try {
        socket.send(JSON.stringify(payload));
        return true;
      } catch {
        return false;
      }
    },
    log
  });

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function clearMirrorTimer() {
    if (mirrorTimer !== null) {
      clearInterval(mirrorTimer);
      mirrorTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    const waitMs = Math.min(reconnectMaxMs, reconnectMinMs + reconnectAttempts * 500);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, waitMs);
  }

  function onConnected() {
    reconnectAttempts = 0;
    runtime.setBridgeOnline(sessionId, true);
    runtime.setRecoveryMode(sessionId, false, null);
    runtime.emitState(sessionId);
    void runtime.publishTerminalSnapshot(sessionId);

    clearMirrorTimer();
    mirrorTimer = setInterval(() => {
      if (stopped) {
        return;
      }
      void runtime.publishTerminalSnapshot(sessionId);
    }, mirrorIntervalMs);
  }

  function onDisconnected() {
    clearMirrorTimer();
    runtime.setBridgeOnline(sessionId, false);
    runtime.setRecoveryMode(sessionId, true, 'ws_disconnected');
    scheduleReconnect();
  }

  function connect() {
    if (stopped) {
      return;
    }

    try {
      socket = new WebSocket(wsUrl);
    } catch (error) {
      log.error(`[operator-bridge] websocket create failed: ${error.message}`);
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      log.info(`[operator-bridge] connected: ${wsUrl}`);
      onConnected();
    });

    socket.addEventListener('message', async (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : await event.data.text();
        const payload = JSON.parse(raw);
        await runtime.handlePayload(payload);
      } catch (error) {
        log.warn(`[operator-bridge] incoming payload ignored: ${error.message}`);
      }
    });

    socket.addEventListener('error', (error) => {
      const errorMessage = error?.message ? ` ${error.message}` : '';
      log.warn(`[operator-bridge] websocket error:${errorMessage}`);
    });

    socket.addEventListener('close', () => {
      log.warn('[operator-bridge] websocket closed');
      onDisconnected();
    });
  }

  connect();

  return {
    runtime,
    async stop() {
      stopped = true;
      clearReconnectTimer();
      clearMirrorTimer();
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    }
  };
}

export function loadBridgeOptionsFromEnv(env = process.env) {
  const tmuxPane = asNonEmptyString(env.MH_BRIDGE_TMUX_PANE) ?? asNonEmptyString(env.TMUX_PANE);
  if (!tmuxPane) {
    throw new Error('MH_BRIDGE_TMUX_PANE is required (or run inside tmux with TMUX_PANE)');
  }

  return {
    wsUrl: asNonEmptyString(env.MH_BRIDGE_WS_URL) ?? 'ws://127.0.0.1:8765/ws',
    sessionId: normalizeSessionId(env.MH_BRIDGE_SESSION_ID, 'default'),
    tmuxPane,
    restartCommand: asNonEmptyString(env.MH_BRIDGE_RESTART_COMMAND) ?? 'codex resume --last',
    restartPreKeys: parseRestartPreKeys(env.MH_BRIDGE_RESTART_PRE_KEYS ?? 'C-u'),
    mirrorLines: clampInteger(env.MH_BRIDGE_MIRROR_LINES, 200, 10, 2000),
    mirrorIntervalMs: clampInteger(env.MH_BRIDGE_MIRROR_INTERVAL_MS, 500, 200, 60_000),
    tmuxTimeoutMs: clampInteger(env.MH_BRIDGE_TMUX_TIMEOUT_MS, 8000, 300, 120_000)
    ,
    submitReinforceDelayMs: clampInteger(env.MH_BRIDGE_SUBMIT_REINFORCE_DELAY_MS, 90, 20, 1000)
  };
}

async function main() {
  const log = toLogger(console);
  const options = loadBridgeOptionsFromEnv(process.env);
  const bridge = startOperatorBridge({
    ...options,
    log
  });

  const shutdown = async (signal) => {
    log.info(`[operator-bridge] ${signal} received, shutting down`);
    await bridge.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

const currentPath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (entryPath && currentPath === entryPath) {
  main().catch((error) => {
    console.error(`[operator-bridge] fatal: ${error.message}`);
    process.exit(2);
  });
}
