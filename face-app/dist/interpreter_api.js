import { randomUUID } from 'node:crypto';

import { InterpreterPipelineError } from './interpreter_pipeline.js';

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MIN_AUDIO_MS = 250;
const DEFAULT_MAX_AUDIO_MS = 12_000;
const MAX_VOLUME_BODY_BYTES = 1_024;
const MAX_ATOM_SPEAKER_VOLUME = 200;
const MAX_PAIR_BODY_BYTES = 1_024;
const MAX_PTT_RESPONSE_BODY_BYTES = 16 * 1024;
const DEFAULT_PTT_PENDING_TTL_MS = 30_000;
const DEFAULT_PTT_MAX_PENDING = 16;

function asNonEmptyString(value) {
  if (Array.isArray(value)) {
    return asNonEmptyString(value[0]);
  }
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    request.on('data', (chunk) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maxBodyBytes) {
        settled = true;
        const error = new Error('request body too large');
        error.code = 'payload_too_large';
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    request.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function contentTypeIsWav(value) {
  const mime = asNonEmptyString(value)?.split(';')[0].trim().toLowerCase();
  return mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave';
}

function contentTypeIsJson(value) {
  const mime = asNonEmptyString(value)?.split(';')[0].trim().toLowerCase();
  return mime === 'application/json';
}

function clientAddress(value) {
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    return null;
  }
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
}

function requestClientKey(request) {
  return clientAddress(
    request?.socket?.remoteAddress
    ?? request?.connection?.remoteAddress
  );
}

function socketClientKey(socket) {
  return clientAddress(socket?.remoteAddress);
}

function defaultAtomSessionId(deviceId) {
  return `atom:${asNonEmptyString(deviceId) ?? 'headroom'}`;
}

export function inspectPcm16MonoWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    return { ok: false, error: 'invalid_wav' };
  }
  if (
    buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return { ok: false, error: 'invalid_wav' };
  }

  let format = null;
  let dataBytes = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (chunkSize < 0 || start + chunkSize > buffer.length) {
      return { ok: false, error: 'invalid_wav' };
    }
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        bitsPerSample: buffer.readUInt16LE(start + 14)
      };
    } else if (chunkId === 'data') {
      dataBytes = chunkSize;
    }
    offset = start + chunkSize + (chunkSize % 2);
  }

  if (!format || dataBytes === null) {
    return { ok: false, error: 'invalid_wav' };
  }
  if (
    format.audioFormat !== 1
    || format.channels !== 1
    || format.bitsPerSample !== 16
    || format.sampleRate !== 16_000
    || format.byteRate !== 32_000
  ) {
    return {
      ok: false,
      error: 'unsupported_wav_format',
      format
    };
  }
  return {
    ok: true,
    format,
    dataBytes,
    durationMs: Math.round((dataBytes / format.byteRate) * 1000)
  };
}

function publicError(error) {
  if (error instanceof InterpreterPipelineError) {
    return {
      statusCode: error.statusCode,
      payload: {
        ok: false,
        error: error.code
      }
    };
  }
  if (
    typeof error?.code === 'string'
    && Number.isInteger(error?.statusCode)
    && error.statusCode >= 400
    && error.statusCode <= 599
  ) {
    return {
      statusCode: error.statusCode,
      payload: {
        ok: false,
        error: error.code
      }
    };
  }
  return {
    statusCode: 500,
    payload: {
      ok: false,
      error: 'interpreter_internal_error'
    }
  };
}

export function createInterpreterApi(options = {}) {
  const pipeline = options.pipeline;
  const maxBodyBytes = Number.isFinite(options.maxBodyBytes)
    ? Math.max(1024, Math.floor(options.maxBodyBytes))
    : DEFAULT_MAX_BODY_BYTES;
  const minAudioMs = Number.isFinite(options.minAudioMs)
    ? Math.max(0, Math.floor(options.minAudioMs))
    : DEFAULT_MIN_AUDIO_MS;
  const maxAudioMs = Number.isFinite(options.maxAudioMs)
    ? Math.max(minAudioMs, Math.floor(options.maxAudioMs))
    : DEFAULT_MAX_AUDIO_MS;
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => ({});
  const getHealth = typeof options.getHealth === 'function'
    ? options.getHealth
    : () => ({ ok: true, service: 'interpreter' });
  const setAtomVolume = typeof options.setAtomVolume === 'function'
    ? options.setAtomVolume
    : null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const createTurnId = typeof options.createTurnId === 'function'
    ? options.createTurnId
    : () => randomUUID();
  const atomSessionId = typeof options.atomSessionId === 'function'
    ? options.atomSessionId
    : defaultAtomSessionId;
  const pttPendingTtlMs = Number.isFinite(options.pttPendingTtlMs)
    ? Math.max(1_000, Math.floor(options.pttPendingTtlMs))
    : DEFAULT_PTT_PENDING_TTL_MS;
  const pttMaxPending = Number.isFinite(options.pttMaxPending)
    ? Math.max(1, Math.floor(options.pttMaxPending))
    : DEFAULT_PTT_MAX_PENDING;
  const pttPending = new Map();
  const log = options.log ?? console;

  if (!pipeline || typeof pipeline.processTurn !== 'function') {
    throw new TypeError('interpreter API requires a pipeline');
  }

  function pttAvailable() {
    return (
      typeof pipeline.transcribeAudio === 'function'
      && typeof pipeline.processRecognizedTurn === 'function'
    );
  }

  function prunePttPending(atMs = now()) {
    for (const [key, entry] of pttPending) {
      if (atMs - entry.preparedAt > pttPendingTtlMs) {
        pttPending.delete(key);
      }
    }
    while (pttPending.size > pttMaxPending) {
      pttPending.delete(pttPending.keys().next().value);
    }
  }

  function rememberPttTranscription(clientKey, entry) {
    pttPending.delete(clientKey);
    pttPending.set(clientKey, entry);
    prunePttPending(entry.preparedAt);
  }

  function validatePttResponsePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, statusCode: 400, error: 'invalid_operator_response' };
    }
    if (payload.type !== 'operator_response') {
      return { ok: false, statusCode: 400, error: 'invalid_operator_response' };
    }
    if (payload.source !== 'atom') {
      return { ok: false, statusCode: 400, error: 'ptt_atom_source_required' };
    }
    const deviceId = asNonEmptyString(payload.session_id);
    const transcript = asNonEmptyString(payload.value);
    if (!deviceId || deviceId.length > 128) {
      return { ok: false, statusCode: 400, error: 'invalid_atom_device_id' };
    }
    if (!transcript) {
      return { ok: false, statusCode: 400, error: 'empty_value' };
    }
    return {
      ok: true,
      deviceId,
      transcript
    };
  }

  function acceptPttResponse(payload, clientKey) {
    if (!pttAvailable()) {
      return { ok: false, statusCode: 503, error: 'interpreter_ptt_unavailable' };
    }
    if (!clientKey) {
      return { ok: false, statusCode: 400, error: 'ptt_client_identity_required' };
    }
    const validated = validatePttResponsePayload(payload);
    if (!validated.ok) {
      return validated;
    }

    const entry = pttPending.get(clientKey);
    if (!entry) {
      return { ok: false, statusCode: 409, error: 'ptt_transcript_missing' };
    }
    if (now() - entry.preparedAt > pttPendingTtlMs) {
      pttPending.delete(clientKey);
      return { ok: false, statusCode: 410, error: 'ptt_transcript_expired' };
    }
    if (validated.transcript !== entry.asrResult.transcript) {
      return { ok: false, statusCode: 409, error: 'ptt_transcript_mismatch' };
    }

    const sessionId = atomSessionId(validated.deviceId);
    if (entry.sessionId && entry.sessionId !== sessionId) {
      return { ok: false, statusCode: 409, error: 'ptt_session_mismatch' };
    }
    entry.sessionId = sessionId;
    const duplicate = Boolean(entry.dispatchPromise);
    if (!entry.dispatchPromise) {
      entry.dispatchPromise = Promise.resolve()
        .then(() => pipeline.processRecognizedTurn({
          asrResult: entry.asrResult,
          sessionId,
          turnId: entry.turnId,
          inputSource: 'atom'
        }))
        .then((result) => {
          entry.result = result;
          return result;
        })
        .catch((error) => {
          entry.error = error;
          log.warn?.(`[interpreter] Atom PTT turn failed: ${error.message}`);
          return null;
        });
    }
    return {
      ok: true,
      statusCode: 202,
      sessionId,
      turnId: entry.turnId,
      duplicate
    };
  }

  async function handlePttAsr(request, response) {
    if (request.method !== 'POST') {
      writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    if (!contentTypeIsWav(request.headers['content-type'])) {
      writeJson(response, 415, {
        ok: false,
        error: 'unsupported_media_type',
        supported: ['audio/wav']
      });
      return;
    }
    if (!pttAvailable()) {
      writeJson(response, 503, { ok: false, error: 'interpreter_ptt_unavailable' });
      return;
    }
    const clientKey = requestClientKey(request);
    if (!clientKey) {
      writeJson(response, 400, { ok: false, error: 'ptt_client_identity_required' });
      return;
    }

    let audio;
    try {
      audio = await readRequestBody(request, maxBodyBytes);
    } catch (error) {
      writeJson(response, error?.code === 'payload_too_large' ? 413 : 400, {
        ok: false,
        error: error?.code ?? 'invalid_audio_body'
      });
      return;
    }
    const inspected = inspectPcm16MonoWav(audio);
    if (!inspected.ok) {
      writeJson(response, 415, { ok: false, error: inspected.error });
      return;
    }
    if (inspected.durationMs < minAudioMs) {
      writeJson(response, 422, { ok: false, error: 'audio_too_short' });
      return;
    }
    if (inspected.durationMs > maxAudioMs) {
      writeJson(response, 422, { ok: false, error: 'audio_too_long' });
      return;
    }

    const turnId = createTurnId();
    try {
      const asrResult = await pipeline.transcribeAudio({
        audio,
        mimeType: 'audio/wav',
        sessionId: `ptt:${clientKey}`,
        turnId,
        inputSource: 'atom',
        speechMs: inspected.durationMs
      });
      rememberPttTranscription(clientKey, {
        asrResult,
        turnId,
        preparedAt: now(),
        sessionId: null,
        dispatchPromise: null,
        result: undefined,
        error: null
      });
      writeJson(response, 200, {
        ok: true,
        text: asrResult.transcript,
        language: asrResult.sourceLanguage,
        confidence: asrResult.confidence,
        route: 'interpreter_ptt'
      });
    } catch (error) {
      log.warn?.(`[interpreter] Atom PTT ASR failed: ${error.message}`);
      const failure = publicError(error);
      writeJson(response, failure.statusCode, failure.payload);
    }
  }

  async function handlePttResponse(request, response) {
    if (request.method !== 'POST') {
      writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    if (!contentTypeIsJson(request.headers['content-type'])) {
      writeJson(response, 415, {
        ok: false,
        error: 'unsupported_media_type',
        supported: ['application/json']
      });
      return;
    }
    let payload;
    try {
      const raw = await readRequestBody(request, MAX_PTT_RESPONSE_BODY_BYTES);
      payload = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      writeJson(response, error?.code === 'payload_too_large' ? 413 : 400, {
        ok: false,
        error: error?.code === 'payload_too_large'
          ? 'payload_too_large'
          : 'invalid_json'
      });
      return;
    }
    const accepted = acceptPttResponse(payload, requestClientKey(request));
    if (!accepted.ok) {
      writeJson(response, accepted.statusCode, {
        ok: false,
        error: accepted.error
      });
      return;
    }
    writeJson(response, 202, {
      ok: true,
      session_id: accepted.sessionId,
      turn_id: accepted.turnId
    });
  }

  async function handleTurn(request, response) {
    if (request.method !== 'POST') {
      writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    if (!contentTypeIsWav(request.headers['content-type'])) {
      writeJson(response, 415, {
        ok: false,
        error: 'unsupported_media_type',
        supported: ['audio/wav']
      });
      return;
    }
    const sessionId = asNonEmptyString(request.headers['x-interpreter-session-id']);
    const turnId = asNonEmptyString(request.headers['x-interpreter-turn-id']);
    if (!sessionId || !turnId) {
      writeJson(response, 400, {
        ok: false,
        error: !sessionId ? 'session_id_required' : 'turn_id_required'
      });
      return;
    }

    let audio;
    try {
      audio = await readRequestBody(request, maxBodyBytes);
    } catch (error) {
      writeJson(response, error?.code === 'payload_too_large' ? 413 : 400, {
        ok: false,
        error: error?.code ?? 'invalid_audio_body'
      });
      return;
    }
    const inspected = inspectPcm16MonoWav(audio);
    if (!inspected.ok) {
      writeJson(response, 415, {
        ok: false,
        error: inspected.error
      });
      return;
    }
    if (inspected.durationMs < minAudioMs) {
      writeJson(response, 422, { ok: false, error: 'audio_too_short' });
      return;
    }
    if (inspected.durationMs > maxAudioMs) {
      writeJson(response, 422, { ok: false, error: 'audio_too_long' });
      return;
    }

    try {
      const result = await pipeline.processTurn({
        audio,
        mimeType: 'audio/wav',
        sessionId,
        turnId,
        inputSource: 'browser'
      });
      writeJson(response, 200, result);
    } catch (error) {
      log.warn?.(`[interpreter] turn failed: ${error.message}`);
      const failure = publicError(error);
      writeJson(response, failure.statusCode, failure.payload);
    }
  }

  function handleReset(request, response) {
    if (request.method !== 'POST') {
      writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    const sessionId = asNonEmptyString(request.headers['x-interpreter-session-id']);
    const turnId = asNonEmptyString(request.headers['x-interpreter-turn-id']);
    if (!sessionId || !turnId) {
      writeJson(response, 400, {
        ok: false,
        error: !sessionId ? 'session_id_required' : 'turn_id_required'
      });
      return;
    }
    writeJson(response, 200, pipeline.resetSession(sessionId, turnId));
  }

  function handleSessionState(request, response) {
    if (request.method !== 'GET') {
      writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    const sessionId = asNonEmptyString(request.headers['x-interpreter-session-id']);
    if (!sessionId) {
      writeJson(response, 400, { ok: false, error: 'session_id_required' });
      return;
    }
    if (
      typeof pipeline.getSessionSnapshot !== 'function'
      && typeof pipeline.getSessionState !== 'function'
    ) {
      writeJson(response, 500, { ok: false, error: 'interpreter_internal_error' });
      return;
    }
    const snapshot = typeof pipeline.getSessionSnapshot === 'function'
      ? pipeline.getSessionSnapshot(sessionId)
      : {
          state: pipeline.getSessionState(sessionId),
          latestTurn: null
        };
    writeJson(response, 200, {
      ok: true,
      sessionId,
      state: snapshot.state,
      latestTurn: snapshot.latestTurn ?? null
    });
  }

  async function handleSessionPair(request, response) {
    if (request.method !== 'POST') {
      writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    if (!contentTypeIsJson(request.headers['content-type'])) {
      writeJson(response, 415, {
        ok: false,
        error: 'unsupported_media_type',
        supported: ['application/json']
      });
      return;
    }
    const sessionId = asNonEmptyString(request.headers['x-interpreter-session-id']);
    const turnId = asNonEmptyString(request.headers['x-interpreter-turn-id']);
    if (!sessionId || !turnId) {
      writeJson(response, 400, {
        ok: false,
        error: !sessionId ? 'session_id_required' : 'turn_id_required'
      });
      return;
    }
    if (typeof pipeline.setSessionPair !== 'function') {
      writeJson(response, 500, { ok: false, error: 'interpreter_internal_error' });
      return;
    }

    let body;
    try {
      const raw = await readRequestBody(request, MAX_PAIR_BODY_BYTES);
      body = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      writeJson(
        response,
        error?.code === 'payload_too_large' ? 413 : 400,
        {
          ok: false,
          error: error?.code === 'payload_too_large'
            ? 'payload_too_large'
            : 'invalid_json'
        }
      );
      return;
    }
    const keys = body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body).sort()
      : [];
    if (
      keys.length !== 2
      || keys[0] !== 'anchorLanguage'
      || keys[1] !== 'partnerLanguage'
      || typeof body.anchorLanguage !== 'string'
      || typeof body.partnerLanguage !== 'string'
    ) {
      writeJson(response, 400, { ok: false, error: 'invalid_pair_request' });
      return;
    }

    try {
      const result = await pipeline.setSessionPair({
        sessionId,
        turnId,
        anchorLanguage: body.anchorLanguage,
        partnerLanguage: body.partnerLanguage,
        inputSource: 'browser'
      });
      writeJson(response, 200, result);
    } catch (error) {
      log.warn?.(`[interpreter] manual pair failed: ${error.message}`);
      const failure = publicError(error);
      writeJson(response, failure.statusCode, failure.payload);
    }
  }

  async function handleAtomVolume(request, response) {
    if (request.method !== 'POST') {
      writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    if (!contentTypeIsJson(request.headers['content-type'])) {
      writeJson(response, 415, {
        ok: false,
        error: 'unsupported_media_type',
        supported: ['application/json']
      });
      return;
    }
    if (!setAtomVolume) {
      writeJson(response, 503, { ok: false, error: 'atom_volume_unavailable' });
      return;
    }
    let body;
    try {
      const raw = await readRequestBody(request, MAX_VOLUME_BODY_BYTES);
      body = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      writeJson(
        response,
        error?.code === 'payload_too_large' ? 413 : 400,
        {
          ok: false,
          error: error?.code === 'payload_too_large'
            ? 'payload_too_large'
            : 'invalid_json'
        }
      );
      return;
    }
    if (
      !body
      || typeof body !== 'object'
      || Array.isArray(body)
      || !Number.isInteger(body.volume)
      || body.volume < 0
      || body.volume > MAX_ATOM_SPEAKER_VOLUME
    ) {
      writeJson(response, 400, { ok: false, error: 'invalid_atom_volume' });
      return;
    }
    const deviceId = body.deviceId === undefined
      ? null
      : asNonEmptyString(body.deviceId);
    if (body.deviceId !== undefined && !deviceId) {
      writeJson(response, 400, { ok: false, error: 'invalid_atom_device_id' });
      return;
    }
    try {
      const result = await setAtomVolume({
        deviceId,
        volume: body.volume
      });
      writeJson(response, 200, result);
    } catch (error) {
      log.warn?.(`[interpreter] Atom volume failed: ${error.message}`);
      const failure = publicError(error);
      writeJson(response, failure.statusCode, failure.payload);
    }
  }

  return {
    handlePttPayload(payload, context = {}) {
      if (payload?.type !== 'operator_response' || context?.isAtom !== true) {
        return null;
      }
      const accepted = acceptPttResponse(payload, socketClientKey(context.socket));
      if (!accepted.ok) {
        log.warn?.(`[interpreter] Atom PTT response rejected: ${accepted.error}`);
      }
      return {
        relay: false,
        accepted: accepted.ok,
        ...(accepted.ok ? { turnId: accepted.turnId } : { error: accepted.error })
      };
    },
    async handleHttpRequest(request, response) {
      const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (parsedUrl.pathname === '/healthz') {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
          return true;
        }
        const health = await getHealth();
        writeJson(response, health?.ok === false ? 503 : 200, health);
        return true;
      }
      if (parsedUrl.pathname === '/api/interpreter/config') {
        if (request.method !== 'GET') {
          writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
          return true;
        }
        writeJson(response, 200, {
          ok: true,
          ...await getConfig()
        });
        return true;
      }
      if (parsedUrl.pathname === '/api/operator/asr') {
        await handlePttAsr(request, response);
        return true;
      }
      if (parsedUrl.pathname === '/api/operator/response') {
        await handlePttResponse(request, response);
        return true;
      }
      if (parsedUrl.pathname === '/api/interpreter/turn') {
        await handleTurn(request, response);
        return true;
      }
      if (parsedUrl.pathname === '/api/interpreter/session') {
        handleSessionState(request, response);
        return true;
      }
      if (parsedUrl.pathname === '/api/interpreter/session/reset') {
        handleReset(request, response);
        return true;
      }
      if (parsedUrl.pathname === '/api/interpreter/session/pair') {
        await handleSessionPair(request, response);
        return true;
      }
      if (parsedUrl.pathname === '/api/interpreter/atom/volume') {
        await handleAtomVolume(request, response);
        return true;
      }
      return false;
    }
  };
}
