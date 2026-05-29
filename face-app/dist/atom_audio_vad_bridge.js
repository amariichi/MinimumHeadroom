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

function normalizeLanguage(value, fallback = 'ja') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized.startsWith('en')) {
    return 'en';
  }
  if (normalized.startsWith('ja')) {
    return 'ja';
  }
  return fallback === 'en' ? 'en' : 'ja';
}

function writeLe16(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
}

function writeLe32(buffer, offset, value) {
  buffer.writeUInt32LE(value, offset);
}

export function pcm16ToWavBuffer(pcmBuffer, sampleRate = 16000) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer ?? []);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii');
  writeLe32(wav, 4, wav.length - 8);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  writeLe32(wav, 16, 16);
  writeLe16(wav, 20, 1);
  writeLe16(wav, 22, 1);
  writeLe32(wav, 24, sampleRate);
  writeLe32(wav, 28, sampleRate * 2);
  writeLe16(wav, 32, 2);
  writeLe16(wav, 34, 16);
  wav.write('data', 36, 'ascii');
  writeLe32(wav, 40, pcm.length);
  pcm.copy(wav, 44);
  return wav;
}

// IMA ADPCM 4:1 decoder. Matches the encoder in
// firmware/atoms3r-headroom/src/ima_adpcm.cpp byte-for-byte: a 4-byte
// header (predictor LE16 | step index | reserved) followed by 4-bit
// nibbles (low nibble first). Returns a PCM16 little-endian Buffer.
const IMA_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
];
const IMA_INDEX_TABLE = [
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8
];

function clampInt16(value) {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

function clampStepIndex(value) {
  if (value < 0) return 0;
  if (value > 88) return 88;
  return value;
}

export function imaAdpcmDecode(buffer, sampleCount) {
  const src = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (src.length < 4 || sampleCount < 1) {
    return Buffer.alloc(0);
  }
  let predictor = src.readInt16LE(0);
  let stepIndex = clampStepIndex(src.readInt8(2));
  const out = Buffer.alloc(sampleCount * 2);
  out.writeInt16LE(predictor, 0);

  let byteOffset = 4;
  let nibbleHigh = false;
  for (let i = 1; i < sampleCount; i += 1) {
    if (byteOffset >= src.length) {
      break;
    }
    let nibble;
    if (!nibbleHigh) {
      nibble = src[byteOffset] & 0x0f;
      nibbleHigh = true;
    } else {
      nibble = (src[byteOffset] >> 4) & 0x0f;
      nibbleHigh = false;
      byteOffset += 1;
    }
    const step = IMA_STEP_TABLE[stepIndex];
    let delta = step >> 3;
    if (nibble & 0x1) delta += step >> 2;
    if (nibble & 0x2) delta += step >> 1;
    if (nibble & 0x4) delta += step;
    if (nibble & 0x8) {
      predictor -= delta;
    } else {
      predictor += delta;
    }
    predictor = clampInt16(predictor);
    stepIndex = clampStepIndex(stepIndex + IMA_INDEX_TABLE[nibble]);
    out.writeInt16LE(predictor, i * 2);
  }
  return out;
}

export function pcm16Rms(buffer) {
  const pcm = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const samples = Math.floor(pcm.length / 2);
  if (samples <= 0) {
    return 0;
  }
  let sumSquares = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples);
}

function resolveUpstreamUrl({ endpointUrl, baseUrl, language }) {
  const explicitEndpoint = typeof endpointUrl === 'string' && endpointUrl.trim() !== '' ? endpointUrl.trim() : '';
  if (explicitEndpoint) {
    return new URL(explicitEndpoint);
  }
  const explicitBase = typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl.trim() : '';
  if (!explicitBase) {
    return null;
  }
  const base = new URL(explicitBase);
  const pathPrefix = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  base.pathname = `${pathPrefix}/v1/asr/${language}`.replace(/\/{2,}/g, '/');
  return base;
}

function normalizeAsrResult(payload, fallbackLanguage) {
  if (!payload || typeof payload !== 'object' || typeof payload.text !== 'string' || payload.text.trim() === '') {
    return null;
  }
  return {
    text: payload.text.trim(),
    language: normalizeLanguage(payload.language, fallbackLanguage),
    confidence: Number.isFinite(payload.confidence) ? Number(payload.confidence) : null
  };
}

// Very short Japanese transcripts that the Atom mic loop tends to produce
// from ambient sound (door clicks, breath, chair creaks, my own TTS tail).
// These are not real user turns and dispatching them as operator_response
// makes the agent reply to nothing. The list intentionally excludes "はい"
// and other deliberate one-word answers a user might give. Override via
// `options.ignoredFillerTexts` (Set of normalized strings); pass an empty
// Set to disable the filter entirely.
export const DEFAULT_IGNORED_FILLER_TEXTS = new Set([
  'うん', 'うーん', 'ううん', 'ん', 'んー', 'んっ', 'んん',
  'あ', 'あー', 'あっ', 'ああ', 'あぁ',
  'はあ', 'はぁ', 'は',
  'えっ', 'え', 'えー', 'えぇ',
  'お', 'おっ', 'おう', 'おー',
  'い',
  'フッ', 'ふっ', 'フフ', 'ふふ', 'フフフ', 'ふふふ',
  'ピッ', 'ピ', 'ピー'
]);

// Strip leading/trailing whitespace and trivial trailing punctuation so a
// transcript like "うん。" matches the filler set entry "うん".
function stripFillerPunctuation(text) {
  return text.replace(/^[\s「『（(]+/u, '').replace(/[\s。、,，.!?！？」』）)]+$/u, '');
}

// VAD backend interface
// ---------------------
// A backend exposes one method: `decide(frame, sampleRate)`. It may return
// either a plain object `{ isSpeech: boolean }` (sync) or a Promise that
// resolves to one (async). The bridge tolerates both. A sync RMS backend
// is the default; the Silero adapter below calls an external worker.

// Built-in RMS-energy backend. Mirrors the historical pcm16Rms gate so the
// default behavior is unchanged when no backend override is supplied.
export function createRmsVadBackend(options = {}) {
  const threshold = Number.isFinite(options.thresholdRms) ? options.thresholdRms : 0.025;
  return {
    name: 'rms',
    decide(frame /* , sampleRate */) {
      return { isSpeech: pcm16Rms(frame) >= threshold };
    }
  };
}

// Silero backend: forwards each frame to the silero-vad-worker HTTP API
// and uses the boolean it returns. Use this when ambient noise (street,
// station, cafe) makes the RMS threshold unreliable.
export function createSileroVadBackend(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch API is unavailable for Silero VAD backend');
  }
  const baseUrl = typeof options.baseUrl === 'string' && options.baseUrl.trim() !== ''
    ? options.baseUrl.trim()
    : 'http://127.0.0.1:8092';
  const endpointUrl = typeof options.endpointUrl === 'string' && options.endpointUrl.trim() !== ''
    ? options.endpointUrl.trim()
    : `${baseUrl.replace(/\/+$/, '')}/v1/vad`;
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.5;
  return {
    name: 'silero',
    async decide(frame, sampleRate) {
      const response = await fetchImpl(endpointUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          audioBase64: frame.toString('base64'),
          sampleRate,
          threshold
        })
      });
      if (!response.ok) {
        throw new Error(`silero-vad-worker returned status=${response.status}`);
      }
      const body = await response.json();
      return {
        isSpeech: Boolean(body?.is_speech),
        confidence: Number.isFinite(body?.speech_prob) ? Number(body.speech_prob) : null
      };
    }
  };
}

export function createAtomAudioVadBridge(options = {}) {
  const log = toLogger(options.log ?? console);
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const baseUrl = typeof options.asrBaseUrl === 'string' ? options.asrBaseUrl : '';
  const endpointUrl = typeof options.asrEndpointUrl === 'string' ? options.asrEndpointUrl : '';
  const onOperatorResponse = typeof options.onOperatorResponse === 'function' ? options.onOperatorResponse : null;
  const onAcceptedSpeech = typeof options.onAcceptedSpeech === 'function' ? options.onAcceptedSpeech : null;
  // thresholdRms: RMS energy floor a frame must exceed to count as speech.
  // 0.025 (-32 dBFS) ignores typical ambient noise and short non-verbal
  // bursts like throat clicks; lower values pick up "うん" / "あ" / "ピッ"
  // phantoms (observed at 0.012 on real hardware).
  const thresholdRms = Number.isFinite(options.thresholdRms) ? options.thresholdRms : 0.025;
  // endSilenceMs: trailing silence required after speech before the
  // utterance is finalized and posted to ASR. Lower = snappier reply at the
  // cost of cutting natural pauses mid-utterance. 400 ms balances "feels
  // conversational" against "did not actually stop talking yet".
  const endSilenceMs = Number.isFinite(options.endSilenceMs) ? Math.max(100, Math.floor(options.endSilenceMs)) : 400;
  const maxUtteranceMs = Number.isFinite(options.maxUtteranceMs) ? Math.max(1000, Math.floor(options.maxUtteranceMs)) : 12_000;
  // minSpeechMs: cumulative speech-frame time required before an utterance
  // is allowed to finalize. 350 ms rejects momentary bursts that exceed
  // thresholdRms for one or two frames but never sustain.
  const minSpeechMs = Number.isFinite(options.minSpeechMs) ? Math.max(0, Math.floor(options.minSpeechMs)) : 350;
  const ignoredFillerTexts = options.ignoredFillerTexts instanceof Set
    ? options.ignoredFillerTexts
    : DEFAULT_IGNORED_FILLER_TEXTS;
  // VAD backend: defaults to the historical RMS-energy gate so existing
  // callers and tests behave identically. Inject a Silero backend (or any
  // other shape implementing `decide(frame, sampleRate)`) via the option.
  const vadBackend = options.vadBackend && typeof options.vadBackend.decide === 'function'
    ? options.vadBackend
    : createRmsVadBackend({ thresholdRms });
  const sessions = new Map();
  const pending = new Set();

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch API is unavailable for Atom audio VAD bridge');
  }

  function sessionFor(id) {
    const key = typeof id === 'string' && id.trim() !== '' ? id.trim() : 'atom-headroom';
    let session = sessions.get(key);
    if (!session) {
      session = {
        id: key,
        active: false,
        sampleRate: 16000,
        language: 'ja',
        buffers: [],
        speechMs: 0,
        silenceMs: 0,
        utteranceMs: 0,
        seq: 0,
        // Highest generation seen so far. Frames with a lower generation are
        // stale (from a capture session the device has already retired) and
        // must be dropped. A higher generation resets in-flight state.
        generation: 0,
        // Epoch is bumped on every external reset (explicit resetSession,
        // higher-generation frame). Async backend results that captured an
        // older epoch are discarded on apply, so an in-flight Silero call
        // for a frame that has since been invalidated cannot resurrect a
        // cleared session.
        epoch: 0,
        // FIFO chain of async per-frame work. Each enqueued frame's
        // backend.decide() result is applied only after the previous one,
        // preserving arrival order under async backends.
        pendingProcessing: Promise.resolve()
      };
      sessions.set(key, session);
    }
    return session;
  }

  async function submitUtterance(session, pcmBuffer) {
    const language = normalizeLanguage(session.language, 'ja');
    const upstreamUrl = resolveUpstreamUrl({ endpointUrl, baseUrl, language });
    if (!upstreamUrl) {
      log.warn('[face-app] Atom VAD utterance dropped: ASR upstream is not configured');
      return;
    }

    const wav = pcm16ToWavBuffer(pcmBuffer, session.sampleRate);
    const response = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        audioBase64: wav.toString('base64'),
        mimeType: 'audio/wav'
      })
    });
    const rawBody = await response.text();
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      parsedBody = null;
    }
    if (!response.ok) {
      log.warn(`[face-app] Atom VAD ASR failed status=${response.status}`);
      return;
    }
    const normalized = normalizeAsrResult(parsedBody, language);
    if (!normalized) {
      log.warn('[face-app] Atom VAD ASR returned no transcript');
      return;
    }
    if (ignoredFillerTexts.size > 0) {
      const stripped = stripFillerPunctuation(normalized.text);
      if (ignoredFillerTexts.has(stripped)) {
        log.info(`[face-app] Atom VAD utterance dropped: filler_only "${normalized.text}"`);
        return;
      }
    }
    if (onAcceptedSpeech) {
      await onAcceptedSpeech({
        text: normalized.text,
        language: normalized.language,
        requestedLanguage: language,
        confidence: normalized.confidence,
        source: 'atom_vad'
      });
    }
    if (onOperatorResponse) {
      await onOperatorResponse({
        v: 1,
        type: 'operator_response',
        session_id: session.id,
        request_id: null,
        response_kind: 'text',
        value: normalized.text,
        source: 'atom-vad',
        ts: Date.now()
      });
    }
  }

  function clearSessionBuffers(session) {
    session.active = false;
    session.buffers = [];
    session.speechMs = 0;
    session.silenceMs = 0;
    session.utteranceMs = 0;
  }

  function applyFrameDecision(session, frame, frameMs, decision) {
    const isSpeech = Boolean(decision && decision.isSpeech);
    if (isSpeech) {
      session.active = true;
      session.speechMs += frameMs;
      session.silenceMs = 0;
    } else if (session.active) {
      session.silenceMs += frameMs;
    }
    if (session.active) {
      session.buffers.push(frame);
      session.utteranceMs += frameMs;
      if (
        (session.silenceMs >= endSilenceMs && session.speechMs >= minSpeechMs) ||
        session.utteranceMs >= maxUtteranceMs
      ) {
        finalize(session);
      }
    }
  }

  // Async backend path: queue the work behind any prior in-flight frame
  // for the same session so decisions are applied in arrival order. An
  // epoch captured at enqueue time gates the apply step against external
  // resets (resetSession, higher-generation frame) that happened while
  // the backend call was outstanding.
  function enqueueAsyncFrame(session, frame, frameMs, decisionPromise) {
    const epochAtEnqueue = session.epoch;
    const work = session.pendingProcessing
      .then(async () => {
        const decision = await decisionPromise;
        if (session.epoch !== epochAtEnqueue) {
          return;
        }
        applyFrameDecision(session, frame, frameMs, decision);
      })
      .catch((error) => {
        log.warn(`[face-app] Atom VAD backend.decide failed: ${error?.message ?? error}`);
      });
    session.pendingProcessing = work;
    pending.add(work);
    work.finally(() => pending.delete(work));
  }

  function finalize(session) {
    const pcm = Buffer.concat(session.buffers);
    clearSessionBuffers(session);
    if (pcm.length === 0) {
      return;
    }
    const task = submitUtterance(session, pcm)
      .catch((error) => {
        log.warn(`[face-app] Atom VAD submit failed: ${error.message}`);
      })
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  }

  // True when there is at least one configured way to reach an ASR endpoint.
  // If neither base nor explicit endpoint URL is set, the bridge cannot
  // submit utterances, so we drop frames at the door rather than buffer
  // them silently.
  const asrConfigured = (typeof endpointUrl === 'string' && endpointUrl.trim() !== '') ||
    (typeof baseUrl === 'string' && baseUrl.trim() !== '');

  function handlePayload(payload) {
    if (!payload || payload.type !== 'atom_audio_frame') {
      return null;
    }
    if (!asrConfigured) {
      return { relay: false, accepted: false, reason: 'asr_not_configured' };
    }
    const audioBase64 = typeof payload.audio_base64 === 'string'
      ? payload.audio_base64
      : typeof payload.audioBase64 === 'string'
        ? payload.audioBase64
        : '';
    if (!audioBase64) {
      return { relay: false, accepted: false, reason: 'missing_audio' };
    }
    let frame;
    try {
      frame = Buffer.from(audioBase64, 'base64');
    } catch {
      return { relay: false, accepted: false, reason: 'bad_audio_base64' };
    }
    if (frame.length < 2) {
      return { relay: false, accepted: false, reason: 'empty_audio' };
    }

    // Decode firmware-side compression. The bridge's downstream logic
    // (RMS / Silero / WAV submit) expects raw PCM16; decoding here keeps
    // the rest of the pipeline encoding-agnostic.
    const encoding = typeof payload.encoding === 'string' ? payload.encoding.trim().toLowerCase() : 'pcm16';
    if (encoding === 'ima_adpcm' || encoding === 'adpcm') {
      const reportedSampleCount = Number.isFinite(payload.sample_count)
        ? Math.max(0, Math.floor(payload.sample_count))
        : 0;
      const inferredSampleCount = reportedSampleCount > 0
        ? reportedSampleCount
        : Math.max(1, 1 + (frame.length - 4) * 2);
      try {
        frame = imaAdpcmDecode(frame, inferredSampleCount);
      } catch (error) {
        log.warn(`[face-app] Atom VAD ima_adpcm decode failed: ${error?.message ?? error}`);
        return { relay: false, accepted: false, reason: 'bad_ima_adpcm' };
      }
      if (frame.length < 2) {
        return { relay: false, accepted: false, reason: 'empty_audio' };
      }
    } else if (encoding && encoding !== 'pcm16' && encoding !== 'pcm') {
      return { relay: false, accepted: false, reason: 'unsupported_encoding' };
    }

    const session = sessionFor(payload.session_id ?? payload.device_id);

    // Generation gating. The firmware bumps generation on every transition
    // that invalidates buffered audio (suspend for playback or PTT, disable,
    // mic restart). A lower generation means the frame predates the most
    // recent reset and must be dropped; a higher generation means the device
    // has moved on without us, so we discard partial buffers before
    // accepting the new frame.
    const frameGeneration = Number.isFinite(payload.generation) ? Math.floor(payload.generation) : null;
    if (frameGeneration !== null) {
      if (frameGeneration < session.generation) {
        return { relay: false, accepted: false, reason: 'stale_generation' };
      }
      if (frameGeneration > session.generation) {
        clearSessionBuffers(session);
        session.generation = frameGeneration;
        // Higher generation is an external reset: any in-flight async
        // backend work for the older generation must be discarded on apply.
        session.epoch += 1;
      }
    }

    session.sampleRate = Number.isFinite(payload.sample_rate) ? Math.floor(payload.sample_rate) : 16000;
    session.language = normalizeLanguage(payload.language, session.language);
    session.seq = Number.isFinite(payload.seq) ? Math.floor(payload.seq) : session.seq + 1;

    const frameMs = Math.max(1, Math.round((Math.floor(frame.length / 2) / session.sampleRate) * 1000));

    const decisionOrPromise = vadBackend.decide(frame, session.sampleRate);
    if (decisionOrPromise && typeof decisionOrPromise.then === 'function') {
      // Async backend (e.g., Silero HTTP): apply via FIFO queue.
      enqueueAsyncFrame(session, frame, frameMs, decisionOrPromise);
      return { relay: false, accepted: true };
    }
    applyFrameDecision(session, frame, frameMs, decisionOrPromise);
    return {
      relay: false,
      accepted: true,
      speech: Boolean(decisionOrPromise && decisionOrPromise.isSpeech),
      active: session.active
    };
  }

  // Discard any partial utterance for a session without submitting it.
  // Optionally raise the accepted-generation floor: any subsequent frame
  // tagged with a generation lower than `generation` is treated as stale.
  // Called from face-app's TTS dispatch path so frames buffered from
  // microphone bleed of the prior turn cannot finalize into ASR after TTS
  // has logically begun.
  function resetSession(sessionId = 'atom-headroom', options = {}) {
    const session = sessionFor(sessionId);
    clearSessionBuffers(session);
    // External reset: invalidate any in-flight async backend decisions
    // captured under the previous epoch so they cannot resurrect this
    // session after the caller has explicitly cleared it.
    session.epoch += 1;
    if (Number.isFinite(options?.generation)) {
      const floor = Math.floor(options.generation);
      if (floor > session.generation) {
        session.generation = floor;
      }
    }
    return {
      sessionId: session.id,
      generation: session.generation,
      reason: typeof options?.reason === 'string' ? options.reason : null
    };
  }

  return {
    handlePayload,
    resetSession,
    async drain() {
      await Promise.all([...pending]);
    },
    flush(sessionId = 'atom-headroom') {
      const session = sessionFor(sessionId);
      if (session.active && session.buffers.length > 0) {
        finalize(session);
      }
    }
  };
}
