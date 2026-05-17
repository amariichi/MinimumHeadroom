import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSayGate } from './say_gate.js';

const DEFAULT_WORKER_COMMAND = {
  cmd: './scripts/run-tts-worker.sh',
  args: []
};
const DEFAULT_QWEN_BOUNDARY_SPEAKER = 'Ono_Anna';
const QWEN_ENGINE_NAME = 'qwen3-tts-0.6b-customvoice';
const KANJI_SCRIPT_CLASS = '㐀-䶿一-龯々〆ヵヶ豈-﫿';
const QWEN_BOUNDARY_SPEAKER_RE = new RegExp(
  `(?:[A-Za-z0-9][A-Za-z0-9./:+_-]{0,31})(?:\\s*[.,;:!?]\\s*)?(?=[${KANJI_SCRIPT_CLASS}])`,
  'u'
);
const HAS_SPEAKABLE_CONTENT_RE = /[\p{L}\p{N}]/u;

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

function normalizeOptionalIdentity(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
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

// Split a long utterance into ordered, sentence-bounded chunks so each
// synthesized WAV stays small enough for memory-constrained sinks (the
// AtomS3R firmware drops a single oversized base64/HTTP WAV while the
// mouth keeps animating from the independent tts_mouth stream). Short
// text (<= maxChars) is returned verbatim as a single chunk so existing
// single-utterance behavior is unchanged.
export function segmentTtsText(text, maxChars = 120) {
  const source = typeof text === 'string' ? text : '';
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 120;
  if (source.length <= limit) {
    return source.length > 0 ? [source] : [];
  }

  // Hard sentence boundaries keep their terminator; newlines also split.
  const hardBoundary = /[^。．.!?！？…\n]*(?:[。．.!?！？…]+|\n+|$)/gu;
  const sentences = [];
  let match;
  while ((match = hardBoundary.exec(source)) !== null) {
    if (match.index === hardBoundary.lastIndex) {
      hardBoundary.lastIndex += 1;
    }
    if (match[0] && match[0].trim() !== '') {
      sentences.push(match[0]);
    }
    if (hardBoundary.lastIndex >= source.length) {
      break;
    }
  }
  if (sentences.length === 0) {
    sentences.push(source);
  }

  // Soft-split any sentence still longer than the limit, preferring a
  // late comma/semicolon boundary, then a hard cut as a last resort.
  const units = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > limit) {
      const window = rest.slice(0, limit);
      const soft = window.match(/[、，,;；](?=[^、，,;；]*$)/u);
      const cut = soft && soft.index >= Math.floor(limit * 0.4) ? soft.index + 1 : limit;
      units.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest.trim() !== '') {
      units.push(rest);
    }
  }

  // Greedily pack consecutive units so we do not emit one chunk per tiny
  // sentence.
  const chunks = [];
  let buffer = '';
  for (const unit of units) {
    if (buffer === '') {
      buffer = unit;
    } else if ((buffer + unit).length <= limit) {
      buffer += unit;
    } else {
      chunks.push(buffer.trim());
      buffer = unit;
    }
  }
  if (buffer.trim() !== '') {
    chunks.push(buffer.trim());
  }

  return chunks.filter((chunk) => chunk !== '');
}

function normalizeAudioTarget(value) {
  if (typeof value !== 'string') {
    return 'local';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'local' || normalized === 'browser' || normalized === 'both') {
    return normalized;
  }
  return 'local';
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

function normalizeText(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  return HAS_SPEAKABLE_CONTENT_RE.test(trimmed) ? trimmed : null;
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

function normalizeSpeakerOverride(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function selectQwenSpeakerForText(text, { engine, defaultVoice, boundarySpeaker }) {
  if (engine !== QWEN_ENGINE_NAME) {
    return null;
  }
  if (!QWEN_BOUNDARY_SPEAKER_RE.test(text)) {
    return null;
  }
  if (boundarySpeaker === null || boundarySpeaker === defaultVoice) {
    return null;
  }
  return boundarySpeaker;
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
  const audioStore = options.audioStore ?? null;
  const audioTarget = normalizeAudioTarget(options.audioTarget);
  const browserAudioEnabled = audioTarget === 'browser' || audioTarget === 'both';
  const defaultTtlMs = Number.isInteger(options.defaultTtlMs) ? Math.max(1, options.defaultTtlMs) : 60_000;
  const autoInterruptAfterMs =
    Number.isInteger(options.autoInterruptAfterMs) && options.autoInterruptAfterMs >= 0
      ? options.autoInterruptAfterMs
      : null;
  const maxChunkChars =
    Number.isInteger(options.maxChunkChars) && options.maxChunkChars > 0
      ? options.maxChunkChars
      : 120;
  const gate = options.gate ?? createSayGate(options.gateConfig ?? {});

  const worker = options.worker ?? createStdioWorkerClient({
    log,
    cwd: options.workerCwd,
    command: options.workerCommand,
    env: options.workerEnv
  });
  const qwenBoundarySpeaker = normalizeSpeakerOverride(options.qwenBoundarySpeaker) ?? DEFAULT_QWEN_BOUNDARY_SPEAKER;

  let stopped = false;
  let workerReady = false;
  let workerEngine = 'unknown';
  let workerVoice = 'af_heart';
  let generation = 0;
  let active = null;
  let activeQueuedAt = null;
  let activePlayStartedAt = null;
  // FIFO of ordered chunks belonging to the current logical utterance.
  // A newer accepted say flushes this and replaces it.
  let queue = [];

  function clearQueue() {
    queue = [];
  }

  function enqueueEntries(entries) {
    for (const entry of entries) {
      queue.push(entry);
    }
  }

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

  function emitMouth(sessionId, utteranceId, open, generationValue = null, messageId = null, revision = null, extra = {}) {
    const value = Number.isFinite(open) ? Math.max(0, Math.min(1, open)) : 0;
    broadcast({
      v: 1,
      type: 'tts_mouth',
      session_id: normalizeSessionId(sessionId),
      ...(extra.agent_id ? { agent_id: extra.agent_id } : {}),
      ...(extra.agent_label ? { agent_label: extra.agent_label } : {}),
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

    const sessionId = normalizeSessionId(payload?.session_id);
    const agentId = normalizeOptionalIdentity(payload?.agent_id);
    const agentLabel = normalizeOptionalIdentity(payload?.agent_label);
    const policy = normalizePolicy(payload?.policy);
    const priority = clampPriority(payload?.priority ?? 0);
    const ttlMs = normalizeTtlMs(payload?.ttl_ms, defaultTtlMs);
    const createdAt = parseTimestamp(payload?.ts, acceptedAt);

    const fallbackMessageId = `${sessionId}:${currentGeneration}`;
    const revision = normalizeRevision(payload?.revision, createdAt);
    const speaker = selectQwenSpeakerForText(rawText, {
      engine: workerEngine,
      defaultVoice: workerVoice,
      boundarySpeaker: qwenBoundarySpeaker
    });
    return {
      generation: currentGeneration,
      sessionId,
      agentId,
      agentLabel,
      utteranceId: typeof payload?.utterance_id === 'string' && payload.utterance_id.trim() !== '' ? payload.utterance_id : `${sessionId}:${currentGeneration}`,
      messageId: normalizeMessageId(payload?.message_id, fallbackMessageId),
      revision,
      text: rawText,
      speaker,
      priority,
      policy,
      ttlMs,
      createdAt,
      dedupeKey: typeof payload?.dedupe_key === 'string' ? payload.dedupe_key : null
    };
  }

  function makeChildEntry(parent, text, index, count) {
    if (count <= 1) {
      return parent;
    }
    const speaker = selectQwenSpeakerForText(text, {
      engine: workerEngine,
      defaultVoice: workerVoice,
      boundarySpeaker: qwenBoundarySpeaker
    });
    const suffix = `#${index + 1}/${count}`;
    return {
      ...parent,
      text,
      speaker,
      utteranceId: `${parent.utteranceId}${suffix}`,
      messageId: `${parent.messageId}${suffix}`,
      chunkIndex: index,
      chunkCount: count
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
        ...(entry.agentId ? { agent_id: entry.agentId } : {}),
        ...(entry.agentLabel ? { agent_label: entry.agentLabel } : {}),
        reason: 'worker_unavailable',
        generation: entry.generation,
        voice: entry.speaker ?? workerVoice,
        message_id: entry.messageId,
        revision: entry.revision
      });
      return { accepted: false, reason: 'worker_unavailable' };
    }

    if (isEntryExpired(entry)) {
      emitState(entry.sessionId, entry.utteranceId, 'dropped', {
        ...(entry.agentId ? { agent_id: entry.agentId } : {}),
        ...(entry.agentLabel ? { agent_label: entry.agentLabel } : {}),
        reason: 'ttl_expired',
        generation: entry.generation,
        voice: entry.speaker ?? workerVoice,
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
      speaker: entry.speaker,
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
        ...(entry.agentId ? { agent_id: entry.agentId } : {}),
        ...(entry.agentLabel ? { agent_label: entry.agentLabel } : {}),
        reason: 'worker_send_failed',
        generation: entry.generation,
        voice: entry.speaker ?? workerVoice,
        message_id: entry.messageId,
        revision: entry.revision
      });
      return { accepted: false, reason: 'worker_send_failed' };
    }

    active = entry;
    activeQueuedAt = now();
    activePlayStartedAt = null;
    emitState(entry.sessionId, entry.utteranceId, 'queued', {
      ...(entry.agentId ? { agent_id: entry.agentId } : {}),
      ...(entry.agentLabel ? { agent_label: entry.agentLabel } : {}),
      reason,
      generation: entry.generation,
      voice: entry.speaker ?? workerVoice,
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
    if (active || queue.length === 0) {
      return;
    }

    const next = queue.shift();
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
      ...(active.agentId ? { agent_id: active.agentId } : {}),
      ...(active.agentLabel ? { agent_label: active.agentLabel } : {}),
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
      workerEngine = typeof message.engine === 'string' ? message.engine : 'unknown';
      workerVoice = typeof message.voice === 'string' ? message.voice : 'af_heart';
      const playbackBackend = typeof message.playback_backend === 'string' ? message.playback_backend : 'unknown';
      emitState('-', null, 'worker_ready', {
        voice: workerVoice,
        engine: workerEngine,
        playback_backend: playbackBackend,
        audio_target: audioTarget
      });
      if (playbackBackend === 'silent' && audioTarget === 'local') {
        log.warn('[face-app] tts worker ready (silent backend: PortAudio unavailable)');
      } else {
        log.info(`[face-app] tts worker ready (backend=${playbackBackend}, audio_target=${audioTarget})`);
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
      emitMouth(active.sessionId, active.utteranceId, message.open, active.generation, active.messageId, active.revision, {
        agent_id: active.agentId,
        agent_label: active.agentLabel
      });
      return;
    }

    if (message.type === 'audio') {
      if (!active || !Number.isInteger(message.generation) || message.generation !== active.generation) {
        return;
      }
      if (typeof message.audio_base64 !== 'string' || message.audio_base64.trim() === '') {
        return;
      }

      const mimeType = typeof message.mime_type === 'string' ? message.mime_type : 'audio/wav';
      const sampleRate = Number.isInteger(message.sample_rate) ? message.sample_rate : null;

      if (audioStore && typeof audioStore.putAudio === 'function' && typeof audioStore.toReferencePayload === 'function') {
        const entry = audioStore.putAudio({
          audioBase64: message.audio_base64,
          mimeType,
          sampleRate,
          sessionId: active.sessionId,
          agentId: active.agentId,
          agentLabel: active.agentLabel,
          utteranceId: active.utteranceId,
          generation: active.generation,
          messageId: active.messageId,
          revision: active.revision
        });
        const refPayload = audioStore.toReferencePayload(entry);
        if (refPayload) {
          broadcast(refPayload);
        }
      }

      if (browserAudioEnabled) {
        broadcast({
          v: 1,
          type: 'tts_audio',
          session_id: active.sessionId,
          ...(active.agentId ? { agent_id: active.agentId } : {}),
          ...(active.agentLabel ? { agent_label: active.agentLabel } : {}),
          utterance_id: active.utteranceId,
          generation: active.generation,
          message_id: active.messageId,
          revision: active.revision,
          mime_type: mimeType,
          audio_base64: message.audio_base64,
          sample_rate: sampleRate,
          ts: now()
        });
      }
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
      ...(active?.agentId ? { agent_id: active.agentId } : {}),
      ...(active?.agentLabel ? { agent_label: active.agentLabel } : {}),
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
        emitMouth(active.sessionId, active.utteranceId, 0, active.generation, active.messageId, active.revision, {
          agent_id: active.agentId,
          agent_label: active.agentLabel
        });
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
    clearQueue();

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
        ...(entry.agentId ? { agent_id: entry.agentId } : {}),
        ...(entry.agentLabel ? { agent_label: entry.agentLabel } : {}),
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
        ...(entry.agentId ? { agent_id: entry.agentId } : {}),
        ...(entry.agentLabel ? { agent_label: entry.agentLabel } : {}),
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

    // Split long utterances so each synthesized WAV stays small; short
    // text yields a single chunk and the original code path.
    const segments = segmentTtsText(entry.text, maxChunkChars);
    const children =
      segments.length > 1
        ? segments.map((seg, index) => makeChildEntry(entry, seg, index, segments.length))
        : [entry];
    const head = children[0];
    const tail = children.slice(1);

    const forceInterrupt = entry.policy === 'interrupt' || entry.priority >= 3;
    const autoInterrupt = shouldPromoteToAutoInterrupt(entry, acceptedAt);

    if (forceInterrupt || autoInterrupt) {
      clearQueue();
      if (active) {
        interruptActive(autoInterrupt ? 'auto_interrupt' : 'superseded', entry.generation);
      }

      enqueueEntries(tail);
      return dispatchSpeak(head, autoInterrupt ? 'auto_interrupt' : 'interrupt');
    }

    if (active) {
      // A newer utterance supersedes the previous one's queued remainder.
      clearQueue();
      enqueueEntries(children);
      emitState(head.sessionId, head.utteranceId, 'queued', {
        ...(head.agentId ? { agent_id: head.agentId } : {}),
        ...(head.agentLabel ? { agent_label: head.agentLabel } : {}),
        reason: 'pending_replace',
        generation: head.generation,
        message_id: head.messageId,
        revision: head.revision
      });
      return {
        accepted: true,
        spoken: true,
        generation: head.generation,
        queued: true,
        message_id: head.messageId,
        revision: head.revision,
        reason: null
      };
    }

    enqueueEntries(tail);
    return dispatchSpeak(head, 'immediate');
  }

  async function interruptCurrent(reason = 'manual_interrupt') {
    if (!active) {
      return;
    }
    interruptActive(reason, generation);
  }

  // Barge-in: the operator took the turn (PTT). Drop every queued chunk,
  // stop the active chunk, advance the generation so any late worker
  // audio/mouth for the old utterance is ignored, and clear stored audio
  // refs so a memory-constrained sink cannot pull a stale chunk.
  async function flushForBargeIn(reason = 'operator_ptt') {
    clearQueue();
    if (active) {
      interruptActive(reason, generation);
      emitMouth(active.sessionId, active.utteranceId, 0, active.generation, active.messageId, active.revision, {
        agent_id: active.agentId,
        agent_label: active.agentLabel
      });
      emitState(active.sessionId, active.utteranceId, 'play_stop', {
        ...(active.agentId ? { agent_id: active.agentId } : {}),
        ...(active.agentLabel ? { agent_label: active.agentLabel } : {}),
        reason,
        generation: active.generation,
        message_id: active.messageId,
        revision: active.revision
      });
      active = null;
      activeQueuedAt = null;
      activePlayStartedAt = null;
    }
    generation += 1;
    if (audioStore && typeof audioStore.clear === 'function') {
      audioStore.clear();
    }
  }

  async function stop() {
    if (stopped) {
      return;
    }

    stopped = true;
    clearQueue();

    if (active) {
      emitMouth(active.sessionId, active.utteranceId, 0, active.generation, active.messageId, active.revision, {
        agent_id: active.agentId,
        agent_label: active.agentLabel
      });
      active = null;
      activeQueuedAt = null;
      activePlayStartedAt = null;
    }

    worker.stop();
    if (audioStore && typeof audioStore.clear === 'function') {
      audioStore.clear();
    }
  }

  return {
    handleSayPayload,
    interruptCurrent,
    flushForBargeIn,
    stop,
    snapshot() {
      return {
        workerReady,
        generation,
        activeGeneration: active?.generation ?? null,
        pendingGeneration: queue[0]?.generation ?? null,
        queuedChunks: queue.length
      };
    }
  };
}
