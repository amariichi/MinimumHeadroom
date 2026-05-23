import { randomUUID } from 'node:crypto';

function toNow(options) {
  return typeof options.now === 'function' ? options.now : () => Date.now();
}

function normalizeTtlMs(value, fallbackMs = 60_000) {
  if (!Number.isInteger(value)) {
    return fallbackMs;
  }
  return Math.max(1, value);
}

function normalizeMimeType(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'audio/wav';
}

function parseWavDurationMs(buffer, sampleRateFallback = null) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    return null;
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  let sampleRate = Number.isInteger(sampleRateFallback) && sampleRateFallback > 0 ? sampleRateFallback : null;
  let byteRate = null;
  let dataBytes = null;
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > buffer.length) {
      break;
    }

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      byteRate = buffer.readUInt32LE(chunkStart + 8);
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
      break;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (Number.isInteger(byteRate) && byteRate > 0 && Number.isInteger(dataBytes)) {
    return Math.round((dataBytes / byteRate) * 1000);
  }
  if (Number.isInteger(sampleRate) && sampleRate > 0 && Number.isInteger(dataBytes)) {
    return Math.round((dataBytes / (sampleRate * 2)) * 1000);
  }
  return null;
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

export function createTtsAudioStore(options = {}) {
  const now = toNow(options);
  const ttlMs = normalizeTtlMs(options.ttlMs, 60_000);
  const entries = new Map();

  function prune(atMs = now()) {
    for (const [id, entry] of entries) {
      if (atMs > entry.expiresAt) {
        entries.delete(id);
      }
    }
  }

  function putAudio({
    audioBase64,
    mimeType = 'audio/wav',
    sampleRate = null,
    sessionId = '-',
    utteranceId = null,
    generation = null,
    messageId = null,
    revision = null,
    agentId = null,
    agentLabel = null
  }) {
    if (typeof audioBase64 !== 'string' || audioBase64.trim() === '') {
      return null;
    }
    prune();

    const audio = Buffer.from(audioBase64, 'base64');
    const id = randomUUID();
    const createdAt = now();
    const entry = {
      id,
      audio,
      mimeType: normalizeMimeType(mimeType),
      sampleRate: Number.isInteger(sampleRate) ? sampleRate : null,
      byteLength: audio.length,
      durationMs: parseWavDurationMs(audio, sampleRate),
      sessionId,
      utteranceId,
      generation,
      messageId,
      revision,
      agentId,
      agentLabel,
      createdAt,
      expiresAt: createdAt + ttlMs
    };
    entries.set(id, entry);
    return entry;
  }

  function get(id) {
    prune();
    const entry = entries.get(id);
    if (!entry) {
      return null;
    }
    if (now() > entry.expiresAt) {
      entries.delete(id);
      return null;
    }
    return entry;
  }

  function deleteAudio(id) {
    return entries.delete(id);
  }

  function clear() {
    entries.clear();
  }

  function toReferencePayload(entry, { basePath = '/api/tts/audio' } = {}) {
    if (!entry) {
      return null;
    }
    const url = `${basePath}/${entry.id}.wav`;
    return {
      v: 1,
      type: 'tts_audio_ref',
      session_id: entry.sessionId,
      ...(entry.agentId ? { agent_id: entry.agentId } : {}),
      ...(entry.agentLabel ? { agent_label: entry.agentLabel } : {}),
      utterance_id: entry.utteranceId,
      generation: entry.generation,
      message_id: entry.messageId,
      revision: entry.revision,
      mime_type: entry.mimeType,
      sample_rate: entry.sampleRate,
      byte_length: entry.byteLength,
      duration_ms: entry.durationMs,
      expires_at: entry.expiresAt,
      url,
      ts: now()
    };
  }

  function handleHttpRequest(request, response) {
    const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const match = parsedUrl.pathname.match(/^\/api\/tts\/audio\/([0-9a-fA-F-]+)\.wav$/);
    if (!match) {
      return false;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }

    const entry = get(match[1]);
    if (!entry) {
      writeJson(response, 410, { ok: false, error: 'audio_expired' });
      return true;
    }

    response.writeHead(200, {
      'content-type': entry.mimeType,
      'content-length': String(entry.byteLength),
      'cache-control': 'no-store',
      'x-utterance-id': entry.utteranceId ?? '',
      'x-generation': Number.isInteger(entry.generation) ? String(entry.generation) : ''
    });
    if (request.method === 'HEAD') {
      response.end();
      return true;
    }
    response.end(entry.audio);
    return true;
  }

  return {
    putAudio,
    get,
    deleteAudio,
    prune,
    clear,
    toReferencePayload,
    handleHttpRequest,
    size() {
      prune();
      return entries.size;
    }
  };
}
