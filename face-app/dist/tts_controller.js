import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSayGate } from './say_gate.js';

const DEFAULT_WORKER_COMMAND = {
  cmd: 'uv',
  args: ['run', '--project', 'tts-worker', 'python', '-m', 'tts_worker']
};

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

function normalizeSessionId(value) {
  if (typeof value !== 'string') {
    return '-';
  }
  const trimmed = value.trim();
  return trimmed === '' ? '-' : trimmed;
}

function clampPriority(value) {
  const normalized = Number.isInteger(value) ? value : Number.parseInt(value ?? '0', 10);
  if (Number.isNaN(normalized)) {
    return 0;
  }
  return Math.max(0, Math.min(3, normalized));
}

function normalizePolicy(value) {
  return value === 'interrupt' ? 'interrupt' : 'replace';
}

function normalizeTtlMs(value, fallbackMs = 60_000) {
  if (!Number.isInteger(value)) {
    return Math.max(1, fallbackMs);
  }
  return Math.max(1, value);
}

function parseTimestamp(value, fallbackMs) {
  if (Number.isFinite(value)) {
    return Math.floor(value);
  }
  return fallbackMs;
}

function normalizeEnglishTtsText(text) {
  let normalized = text
    // Normalize common English smart punctuation into ASCII equivalents.
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    // Normalize no-break spaces that often appear in copied English text.
    .replace(/[\u00A0\u202F]/g, ' ');

  // Strip combining diacritics attached to Latin letters only.
  normalized = normalized
    .normalize('NFD')
    .replace(/([\p{Script=Latin}])\p{M}+/gu, '$1')
    .normalize('NFC');

  // Keep existing dash-to-space normalization for clearer English TTS.
  normalized = normalized.replace(/([A-Za-z0-9])[-‐‑‒–—−]([A-Za-z0-9])/g, '$1 $2');
  return normalized;
}

function normalizeSpeechText(text) {
  return normalizeEnglishTtsText(text);
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeMessageId(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function normalizeRevision(value, fallback) {
  if (Number.isFinite(value)) {
    return Math.floor(value);
  }
  return fallback;
}

function makeLineJsonParser(onMessage, onParseError) {
  let buffer = '';

  return (chunk) => {
    buffer += chunk;

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }

      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      const line = rawLine.trim();
      if (line === '') {
        continue;
      }

      try {
        const parsed = JSON.parse(line);
        onMessage(parsed);
      } catch (error) {
        onParseError(error, line);
      }
    }
  };
}

export function createStdioWorkerClient(options = {}) {
  const log = toLogger(options.log ?? console);
  const emitter = new EventEmitter();

  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const defaultCwd = path.resolve(currentDir, '../..');

  const command = options.command ?? DEFAULT_WORKER_COMMAND;
  const cmd = typeof command.cmd === 'string' && command.cmd.trim() !== '' ? command.cmd : DEFAULT_WORKER_COMMAND.cmd;
  const args = Array.isArray(command.args) && command.args.length > 0 ? command.args : DEFAULT_WORKER_COMMAND.args;
  const cwd = typeof options.cwd === 'string' ? options.cwd : defaultCwd;

  const child = spawn(cmd, args, {
    cwd,
    env: {
      ...process.env,
      ...(options.env ?? {})
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const parseStdout = makeLineJsonParser(
    (message) => {
      emitter.emit('message', message);
    },
    (error, line) => {
      log.warn(`[face-app] tts worker non-json stdout: ${line} (${error.message})`);
    }
  );

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    parseStdout(chunk);
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const lines = chunk
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    for (const line of lines) {
      log.warn(`[tts-worker] ${line}`);
    }
  });

  child.on('error', (error) => {
    emitter.emit('error', error);
  });

  child.on('close', (code, signal) => {
    emitter.emit('exit', { code, signal });
  });

  return {
    on(eventName, handler) {
      emitter.on(eventName, handler);
    },
    send(payload) {
      if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
        return false;
      }
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
        return true;
      } catch {
        return false;
      }
    },
    stop() {
      if (child.exitCode !== null) {
        return;
      }

      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore kill errors when the process is already gone.
      }
    }
  };
}

export function createTtsController(options = {}) {
  const log = toLogger(options.log ?? console);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const broadcast = typeof options.broadcast === 'function' ? options.broadcast : () => false;
  const defaultTtlMs = Number.isInteger(options.defaultTtlMs) ? Math.max(1, options.defaultTtlMs) : 60_000;
  const autoInterruptAfterMs =
    Number.isInteger(options.autoInterruptAfterMs) && options.autoInterruptAfterMs >= 0
      ? options.autoInterruptAfterMs
      : null;
  const gate = options.gate ?? createSayGate(options.gateConfig ?? {});

  const worker = options.worker ?? createStdioWorkerClient({
    log,
    cwd: options.workerCwd,
    command: options.workerCommand,
    env: options.workerEnv
  });

  let stopped = false;
  let workerReady = false;
  let generation = 0;
  let active = null;
  let activeQueuedAt = null;
  let activePlayStartedAt = null;
  let pending = null;

  function emitState(sessionId, utteranceId, phase, extra = {}) {
    const payload = {
      v: 1,
      type: 'tts_state',
      session_id: normalizeSessionId(sessionId),
      utterance_id: utteranceId ?? null,
      phase,
      ts: now(),
      ...extra
    };
    broadcast(payload);
  }

  function emitMouth(sessionId, utteranceId, open, generationValue = null, messageId = null, revision = null) {
    const value = Number.isFinite(open) ? Math.max(0, Math.min(1, open)) : 0;
    broadcast({
      v: 1,
      type: 'tts_mouth',
      session_id: normalizeSessionId(sessionId),
      utterance_id: utteranceId ?? null,
      generation: generationValue,
      message_id: messageId,
      revision,
      open: value,
      ts: now()
    });
  }

  function isEntryExpired(entry, atMs = now()) {
    return atMs > entry.createdAt + entry.ttlMs;
  }

  function normalizeEntry(payload, currentGeneration, acceptedAt) {
    const rawText = normalizeText(payload?.text);
    if (!rawText) {
      return null;
    }

    const text = normalizeSpeechText(rawText);
    const sessionId = normalizeSessionId(payload?.session_id);
    const policy = normalizePolicy(payload?.policy);
    const priority = clampPriority(payload?.priority ?? 0);
    const ttlMs = normalizeTtlMs(payload?.ttl_ms, defaultTtlMs);
    const createdAt = parseTimestamp(payload?.ts, acceptedAt);

    const fallbackMessageId = `${sessionId}:${currentGeneration}`;
    const revision = normalizeRevision(payload?.revision, createdAt);
    return {
      generation: currentGeneration,
      sessionId,
      utteranceId: typeof payload?.utterance_id === 'string' && payload.utterance_id.trim() !== '' ? payload.utterance_id : `${sessionId}:${currentGeneration}`,
      messageId: normalizeMessageId(payload?.message_id, fallbackMessageId),
      revision,
      text,
      priority,
      policy,
      ttlMs,
      createdAt,
      dedupeKey: typeof payload?.dedupe_key === 'string' ? payload.dedupe_key : null
    };
  }

  function sendWorker(payload) {
    const ok = worker.send(payload);
    if (!ok) {
      log.error('[face-app] tts worker send failed');
      workerReady = false;
      return false;
    }
    return true;
  }

  function dispatchSpeak(entry, reason = 'accepted') {
    if (stopped) {
      return { accepted: false, reason: 'controller_stopped' };
    }

    if (!workerReady) {
      emitState(entry.sessionId, entry.utteranceId, 'dropped', {
        reason: 'worker_unavailable',
        generation: entry.generation,
        message_id: entry.messageId,
        revision: entry.revision
      });
      return { accepted: false, reason: 'worker_unavailable' };
    }

    if (isEntryExpired(entry)) {
      emitState(entry.sessionId, entry.utteranceId, 'dropped', {
        reason: 'ttl_expired',
        generation: entry.generation,
        message_id: entry.messageId,
        revision: entry.revision
      });
      return { accepted: false, reason: 'ttl_expired' };
    }

    const expiresAt = entry.createdAt + entry.ttlMs;
    const sent = sendWorker({
      id: `speak-${entry.generation}-${now()}`,
      op: 'speak',
      generation: entry.generation,
      session_id: entry.sessionId,
      utterance_id: entry.utteranceId,
      text: entry.text,
      priority: entry.priority,
      policy: entry.policy,
      ts: entry.createdAt,
      ttl_ms: entry.ttlMs,
      expires_at: expiresAt,
      message_id: entry.messageId,
      revision: entry.revision
    });

    if (!sent) {
      emitState(entry.sessionId, entry.utteranceId, 'dropped', {
        reason: 'worker_send_failed',
        generation: entry.generation,
        message_id: entry.messageId,
        revision: entry.revision
      });
      return { accepted: false, reason: 'worker_send_failed' };
    }

    active = entry;
    activeQueuedAt = now();
    activePlayStartedAt = null;
    emitState(entry.sessionId, entry.utteranceId, 'queued', {
      reason,
      generation: entry.generation,
      expires_at: expiresAt,
      message_id: entry.messageId,
      revision: entry.revision
    });

    return {
      accepted: true,
      spoken: true,
      generation: entry.generation,
      message_id: entry.messageId,
      revision: entry.revision,
      reason: null
    };
  }

  function maybeStartPending() {
    if (active || !pending) {
      return;
    }

    const next = pending;
    pending = null;
    dispatchSpeak(next, 'dequeued');
  }

  function shouldPromoteToAutoInterrupt(entry, acceptedAt) {
    if (!active || autoInterruptAfterMs === null) {
      return false;
    }
    if (entry.policy !== 'replace') {
      return false;
    }
    if (entry.priority >= 3) {
      return false;
    }

    const anchor = Number.isFinite(activePlayStartedAt) ? activePlayStartedAt : activeQueuedAt;
    if (!Number.isFinite(anchor)) {
      return false;
    }

    return acceptedAt - anchor >= autoInterruptAfterMs;
  }

  function interruptActive(reason, byGeneration = null) {
    if (!active) {
      return;
    }

    sendWorker({
      id: `interrupt-${active.generation}-${now()}`,
      op: 'interrupt',
      generation: active.generation,
      reason
    });

    emitState(active.sessionId, active.utteranceId, 'interrupt_requested', {
      reason,
      generation: active.generation,
      by_generation: byGeneration,
      message_id: active.messageId,
      revision: active.revision
    });
  }

  function handleWorkerMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'ready') {
      workerReady = true;
      const playbackBackend = typeof message.playback_backend === 'string' ? message.playback_backend : 'unknown';
      emitState('-', null, 'worker_ready', {
        voice: message.voice ?? 'af_heart',
        engine: message.engine ?? 'kokoro',
        playback_backend: playbackBackend
      });
      if (playbackBackend === 'silent') {
        log.warn('[face-app] tts worker ready (silent backend: PortAudio unavailable)');
      } else {
        log.info(`[face-app] tts worker ready (backend=${playbackBackend})`);
      }
      maybeStartPending();
      return;
    }

    if (message.type === 'response') {
      return;
    }

    if (message.type === 'error') {
      emitState('-', null, 'worker_error', {
        reason: typeof message.message === 'string' ? message.message : 'unknown'
      });
      log.error(`[face-app] tts worker error: ${message.message ?? 'unknown'}`);
      return;
    }

    if (message.type === 'mouth') {
      if (!active || !Number.isInteger(message.generation) || message.generation !== active.generation) {
        return;
      }
      emitMouth(active.sessionId, active.utteranceId, message.open, active.generation, active.messageId, active.revision);
      return;
    }

    if (message.type !== 'event') {
      return;
    }

    const phase = typeof message.phase === 'string' ? message.phase : 'unknown';
    const messageGeneration = Number.isInteger(message.generation) ? message.generation : null;

    if (active && messageGeneration !== null && messageGeneration !== active.generation) {
      return;
    }

    const sessionId = active?.sessionId ?? message.session_id ?? '-';
    const utteranceId = active?.utteranceId ?? message.utterance_id ?? null;
    const messageId = active?.messageId ?? (typeof message.message_id === 'string' ? message.message_id : null);
    const revision = Number.isFinite(message.revision) ? Math.floor(message.revision) : (active?.revision ?? null);

    emitState(sessionId, utteranceId, phase, {
      reason: message.reason ?? null,
      generation: messageGeneration,
      message_id: messageId,
      revision
    });

    if (phase === 'play_start' && active && (messageGeneration === null || messageGeneration === active.generation)) {
      activePlayStartedAt = Number.isFinite(message.ts) ? Math.floor(message.ts) : now();
    }

    if (phase === 'play_stop' || phase === 'dropped' || phase === 'error') {
      if (active && (messageGeneration === null || messageGeneration === active.generation)) {
        emitMouth(active.sessionId, active.utteranceId, 0, active.generation, active.messageId, active.revision);
        active = null;
        activeQueuedAt = null;
        activePlayStartedAt = null;
      }
      maybeStartPending();
    }
  }

  worker.on('message', (message) => {
    try {
      handleWorkerMessage(message);
    } catch (error) {
      log.error(`[face-app] tts message handler failure: ${error.message}`);
    }
  });

  worker.on('error', (error) => {
    workerReady = false;
    emitState('-', null, 'worker_unavailable', {
      reason: error.message
    });
    log.error(`[face-app] tts worker process error: ${error.message}`);
  });

  worker.on('exit', (info) => {
    workerReady = false;

    if (active) {
      emitMouth(active.sessionId, active.utteranceId, 0, active.generation, active.messageId, active.revision);
      active = null;
      activeQueuedAt = null;
      activePlayStartedAt = null;
    }
    pending = null;

    emitState('-', null, 'worker_unavailable', {
      reason: `exit:${info.code ?? 'null'}:${info.signal ?? 'none'}`
    });
    log.warn(`[face-app] tts worker exited code=${info.code ?? 'null'} signal=${info.signal ?? 'none'}`);
  });

  // Kick a health check; worker may still emit ready asynchronously.
  sendWorker({ id: `ping-${now()}`, op: 'ping' });

  async function handleSayPayload(payload) {
    const acceptedAt = now();

    if (stopped) {
      return { accepted: false, reason: 'controller_stopped' };
    }

    const entry = normalizeEntry(payload, generation + 1, acceptedAt);
    if (!entry) {
      return { accepted: false, reason: 'invalid_payload' };
    }

    if (isEntryExpired(entry, acceptedAt)) {
      emitState(entry.sessionId, entry.utteranceId, 'dropped', {
        reason: 'ttl_expired',
        generation: entry.generation,
        message_id: entry.messageId,
        revision: entry.revision
      });
      return {
        accepted: false,
        spoken: false,
        reason: 'ttl_expired',
        message_id: entry.messageId,
        revision: entry.revision
      };
    }

    const gateResult = gate.check(
      {
        session_id: entry.sessionId,
        text: entry.text,
        priority: entry.priority,
        dedupe_key: entry.dedupeKey
      },
      acceptedAt
    );

    if (!gateResult.allow) {
      emitState(entry.sessionId, entry.utteranceId, 'dropped', {
        reason: gateResult.reason,
        generation: entry.generation,
        message_id: entry.messageId,
        revision: entry.revision
      });
      return {
        accepted: false,
        spoken: false,
        reason: gateResult.reason,
        message_id: entry.messageId,
        revision: entry.revision
      };
    }

    generation = entry.generation;

    const forceInterrupt = entry.policy === 'interrupt' || entry.priority >= 3;
    const autoInterrupt = shouldPromoteToAutoInterrupt(entry, acceptedAt);

    if (forceInterrupt || autoInterrupt) {
      pending = null;
      if (active) {
        interruptActive(autoInterrupt ? 'auto_interrupt' : 'superseded', entry.generation);
      }

      return dispatchSpeak(entry, autoInterrupt ? 'auto_interrupt' : 'interrupt');
    }

    if (active) {
      pending = entry;
      emitState(entry.sessionId, entry.utteranceId, 'queued', {
        reason: 'pending_replace',
        generation: entry.generation,
        message_id: entry.messageId,
        revision: entry.revision
      });
      return {
        accepted: true,
        spoken: true,
        generation: entry.generation,
        queued: true,
        message_id: entry.messageId,
        revision: entry.revision,
        reason: null
      };
    }

    return dispatchSpeak(entry, 'immediate');
  }

  async function interruptCurrent(reason = 'manual_interrupt') {
    if (!active) {
      return;
    }
    interruptActive(reason, generation);
  }

  async function stop() {
    if (stopped) {
      return;
    }

    stopped = true;
    pending = null;

    if (active) {
      emitMouth(active.sessionId, active.utteranceId, 0, active.generation, active.messageId, active.revision);
      active = null;
      activeQueuedAt = null;
      activePlayStartedAt = null;
    }

    worker.stop();
  }

  return {
    handleSayPayload,
    interruptCurrent,
    stop,
    snapshot() {
      return {
        workerReady,
        generation,
        activeGeneration: active?.generation ?? null,
        pendingGeneration: pending?.generation ?? null
      };
    }
  };
}
