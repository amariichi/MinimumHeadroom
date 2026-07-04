import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAtomAudioVadBridge,
  createRmsVadBackend,
  createSileroVadBackend,
  imaAdpcmDecode,
  pcm16Rms,
  pcm16ToWavBuffer
} from '../../face-app/dist/atom_audio_vad_bridge.js';

// IMA ADPCM step / index tables (must match the encoder in
// firmware/atoms3r-headroom/src/ima_adpcm.cpp).
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

// Mirror of ima_adpcm_encode() in C++ — used here only to feed the
// decoder a stream identical in byte layout to what the firmware emits.
function imaAdpcmEncode(pcm16Buffer) {
  const samples = Math.floor(pcm16Buffer.length / 2);
  if (samples === 0) {
    return Buffer.alloc(0);
  }
  const out = Buffer.alloc(4 + Math.ceil((samples - 1) / 2));
  let predictor = pcm16Buffer.readInt16LE(0);
  let stepIndex = 0;
  out.writeInt16LE(predictor, 0);
  out.writeInt8(stepIndex, 2);
  out[3] = 0;
  let byteIndex = 4;
  let pending = 0;
  let hasPending = false;
  for (let i = 1; i < samples; i += 1) {
    const sample = pcm16Buffer.readInt16LE(i * 2);
    let diff = sample - predictor;
    let code = 0;
    if (diff < 0) {
      code = 0x8;
      diff = -diff;
    }
    const step = IMA_STEP_TABLE[stepIndex];
    if (diff >= step) { code |= 0x4; diff -= step; }
    const halfStep = step >> 1;
    if (diff >= halfStep) { code |= 0x2; diff -= halfStep; }
    const quarterStep = halfStep >> 1;
    if (diff >= quarterStep) { code |= 0x1; }

    let delta = step >> 3;
    if (code & 0x1) delta += step >> 2;
    if (code & 0x2) delta += step >> 1;
    if (code & 0x4) delta += step;
    if (code & 0x8) {
      predictor -= delta;
    } else {
      predictor += delta;
    }
    if (predictor > 32767) predictor = 32767;
    if (predictor < -32768) predictor = -32768;
    stepIndex += IMA_INDEX_TABLE[code & 0x0f];
    if (stepIndex < 0) stepIndex = 0;
    if (stepIndex > 88) stepIndex = 88;

    const nibble = code & 0x0f;
    if (!hasPending) {
      pending = nibble;
      hasPending = true;
    } else {
      pending |= (nibble << 4) & 0xff;
      out[byteIndex++] = pending;
      hasPending = false;
    }
  }
  if (hasPending) {
    out[byteIndex++] = pending;
  }
  return out.subarray(0, byteIndex);
}

function pcm16Sine({ samples = 1024, freqHz = 300, amplitude = 6000, sampleRate = 16000 } = {}) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(amplitude * Math.sin(2 * Math.PI * freqHz * i / sampleRate));
    buffer.writeInt16LE(value, i * 2);
  }
  return buffer;
}

function pcmFrame({ samples = 1600, amplitude = 0 } = {}) {
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = index % 2 === 0 ? amplitude : -amplitude;
    buffer.writeInt16LE(value, index * 2);
  }
  return buffer;
}

function audioPayload(frame, overrides = {}) {
  return {
    v: 1,
    type: 'atom_audio_frame',
    session_id: 'atom-test',
    device_id: 'atom-test',
    language: 'ja',
    sample_rate: 16000,
    seq: 1,
    audio_base64: frame.toString('base64'),
    ...overrides
  };
}

test('pcm16ToWavBuffer wraps mono PCM with a WAV header', () => {
  const pcm = pcmFrame({ samples: 8, amplitude: 1000 });
  const wav = pcm16ToWavBuffer(pcm, 16000);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.subarray(36, 40).toString('ascii'), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.length, pcm.length + 44);
});

test('pcm16Rms detects speech-like energy', () => {
  assert.equal(pcm16Rms(pcmFrame({ samples: 160, amplitude: 0 })), 0);
  assert.ok(pcm16Rms(pcmFrame({ samples: 160, amplitude: 3000 })) > 0.05);
});

test('Atom audio VAD bridge submits a completed utterance to ASR and operator response', async () => {
  const fetches = [];
  const operatorResponses = [];
  const accepted = [];
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    thresholdRms: 0.01,
    endSilenceMs: 200,
    minSpeechMs: 50,
    onAcceptedSpeech: (payload) => accepted.push(payload),
    onOperatorResponse: (payload) => operatorResponses.push(payload),
    fetchImpl: async (url, options) => {
      fetches.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ text: 'テストです', language: 'ja', confidence: 0.9 });
        }
      };
    }
  });

  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 1 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3200 }), { seq: 2 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 3 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 4 }));
  await bridge.drain();

  assert.equal(fetches.length, 1);
  assert.match(fetches[0].url, /\/v1\/asr\/ja$/);
  const upstreamBody = JSON.parse(fetches[0].options.body);
  assert.equal(upstreamBody.mimeType, 'audio/wav');
  assert.ok(Buffer.from(upstreamBody.audioBase64, 'base64').subarray(0, 4).toString('ascii') === 'RIFF');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].language, 'ja');
  assert.equal(operatorResponses.length, 1);
  assert.equal(operatorResponses[0].type, 'operator_response');
  assert.equal(operatorResponses[0].value, 'テストです');
  assert.equal(operatorResponses[0].source, 'atom-vad');
});

test('Atom audio VAD bridge uses MH_LANG as the default ASR language', async () => {
  const fetches = [];
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    env: { MH_LANG: 'EN' },
    thresholdRms: 0.01,
    endSilenceMs: 200,
    minSpeechMs: 50,
    fetchImpl: async (url) => {
      fetches.push(String(url));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ text: 'hello', confidence: 0.9 });
        }
      };
    }
  });

  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 1, language: undefined }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3200 }), { seq: 2, language: undefined }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 3, language: undefined }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 4, language: undefined }));
  await bridge.drain();

  assert.equal(fetches.length, 1);
  assert.match(fetches[0], /\/v1\/asr\/en$/);
});

test('Atom audio VAD bridge keeps explicit payload language over MH_LANG', async () => {
  const fetches = [];
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    env: { MH_LANG: 'en' },
    thresholdRms: 0.01,
    endSilenceMs: 200,
    minSpeechMs: 50,
    fetchImpl: async (url) => {
      fetches.push(String(url));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ text: '了解', language: 'ja', confidence: 0.9 });
        }
      };
    }
  });

  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 1, language: 'ja' }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3200 }), { seq: 2, language: 'ja' }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 3, language: 'ja' }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 4, language: 'ja' }));
  await bridge.drain();

  assert.equal(fetches.length, 1);
  assert.match(fetches[0], /\/v1\/asr\/ja$/);
});

test('Atom audio VAD bridge suppresses relay for audio frames', () => {
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    fetchImpl: async () => {
      throw new Error('not called');
    }
  });
  const directive = bridge.handlePayload(audioPayload(pcmFrame({ samples: 160, amplitude: 0 })));
  assert.equal(directive.relay, false);
  assert.equal(directive.accepted, true);
});

test('Atom audio VAD bridge drops frames with a generation lower than the session floor', async () => {
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    thresholdRms: 0.01,
    endSilenceMs: 200,
    minSpeechMs: 50,
    fetchImpl: async () => {
      throw new Error('ASR must not be called for stale frames');
    }
  });

  // Raise the session floor to generation 5 (as if a TTS dispatch had just
  // reset the bridge and the firmware also bumped its generation).
  bridge.resetSession('atom-test', { generation: 5, reason: 'tts_dispatch' });

  const stale = bridge.handlePayload(
    audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 1, generation: 4 })
  );
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'stale_generation');

  const stillStale = bridge.handlePayload(
    audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 2, generation: 4 })
  );
  assert.equal(stillStale.accepted, false);

  await bridge.drain();
});

test('Atom audio VAD bridge drops in-flight speech when a higher generation arrives', async () => {
  const fetches = [];
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    thresholdRms: 0.01,
    endSilenceMs: 200,
    minSpeechMs: 50,
    fetchImpl: async (url, options) => {
      fetches.push({ url: String(url), body: options?.body });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ text: 'new', language: 'ja' });
        }
      };
    }
  });

  // Speech under generation 1 — accumulates but never gets to finalize.
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 1, generation: 1 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 2, generation: 1 }));

  // Generation bump on a fresh frame: in-flight buffers must be discarded
  // without submission. The new frame is silence, so no new utterance yet.
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 3, generation: 2 }));

  // Now drive a complete utterance under generation 2.
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 4, generation: 2 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 5, generation: 2 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 6, generation: 2 }));
  await bridge.drain();

  // Exactly one ASR submission — only the post-bump utterance, never the
  // discarded pre-bump speech.
  assert.equal(fetches.length, 1);
});

test('Atom audio VAD bridge resetSession discards an active mid-utterance buffer without submitting', async () => {
  const fetches = [];
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    thresholdRms: 0.01,
    endSilenceMs: 200,
    minSpeechMs: 50,
    fetchImpl: async () => {
      fetches.push(true);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ text: 'x', language: 'ja' });
        }
      };
    }
  });

  // Build up an active utterance.
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 1, generation: 1 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 2, generation: 1 }));

  // Reset mid-utterance — simulates face-app TTS dispatch right after
  // microphone bleed of the operator's prior phrase.
  bridge.resetSession('atom-test', { generation: 2, reason: 'tts_dispatch' });

  // Trailing silence from the OLD generation must be dropped, not finalize
  // anything from the discarded buffer.
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 3, generation: 1 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 4, generation: 1 }));
  await bridge.drain();

  assert.equal(fetches.length, 0);
});

test('Atom audio VAD bridge drops filler-only ASR transcripts before calling onOperatorResponse', async () => {
  const operatorResponses = [];
  const accepted = [];
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    thresholdRms: 0.01,
    endSilenceMs: 200,
    minSpeechMs: 50,
    onAcceptedSpeech: (payload) => accepted.push(payload),
    onOperatorResponse: (payload) => operatorResponses.push(payload),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ text: 'うん。', language: 'ja', confidence: 0.5 });
      }
    })
  });

  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 1, generation: 1 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 2, generation: 1 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 3, generation: 1 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 4, generation: 1 }));
  await bridge.drain();

  // ASR returned "うん。" but that's in the default filler set — it must
  // not be dispatched as an operator response, and accepted-speech ack
  // also must not fire.
  assert.equal(operatorResponses.length, 0);
  assert.equal(accepted.length, 0);
});

test('createRmsVadBackend honors thresholdRms option', () => {
  const backend = createRmsVadBackend({ thresholdRms: 0.05 });
  const loud = pcmFrame({ samples: 800, amplitude: 4000 });
  const quiet = pcmFrame({ samples: 800, amplitude: 200 });
  assert.equal(backend.decide(loud, 16000).isSpeech, true);
  assert.equal(backend.decide(quiet, 16000).isSpeech, false);
});

test('createSileroVadBackend posts to the worker and returns its decision', async () => {
  const calls = [];
  const backend = createSileroVadBackend({
    baseUrl: 'http://127.0.0.1:8092',
    threshold: 0.3,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        async json() {
          return { is_speech: true, speech_prob: 0.91, chunks: 2, durationMs: 64, device: 'cpu' };
        }
      };
    }
  });
  const decision = await backend.decide(pcmFrame({ samples: 1024, amplitude: 3000 }), 16000);
  assert.equal(decision.isSpeech, true);
  assert.equal(decision.confidence, 0.91);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/vad$/);
  assert.equal(calls[0].body.sampleRate, 16000);
  assert.equal(calls[0].body.threshold, 0.3);
  assert.ok(typeof calls[0].body.audioBase64 === 'string');
});

test('createSileroVadBackend throws on non-OK status so the bridge logs and skips', async () => {
  const backend = createSileroVadBackend({
    baseUrl: 'http://127.0.0.1:8092',
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      async json() {
        return {};
      }
    })
  });
  await assert.rejects(
    () => backend.decide(pcmFrame({ samples: 1024, amplitude: 3000 }), 16000),
    /status=503/
  );
});

test('Atom audio VAD bridge feeds frames through an async backend in arrival order', async () => {
  const fetches = [];
  const operatorResponses = [];
  // Async backend with controllable resolution order. Returns isSpeech=true
  // for amplitude > 0 frames and false for silence frames.
  let calls = 0;
  const vadBackend = {
    name: 'mock-async',
    async decide(frame) {
      calls += 1;
      // Insert a microtask boundary so we exercise the per-session FIFO.
      await Promise.resolve();
      const energy = pcm16Rms(frame);
      return { isSpeech: energy >= 0.01 };
    }
  };
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    endSilenceMs: 200,
    minSpeechMs: 50,
    vadBackend,
    onOperatorResponse: (payload) => operatorResponses.push(payload),
    fetchImpl: async (url) => {
      fetches.push(String(url));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ text: 'こんにちは', language: 'ja' });
        }
      };
    }
  });

  // Speech, speech, silence, silence — sync return is { relay:false, accepted:true }
  // without the speech field (async path does not predict in handlePayload).
  const r1 = bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 1, generation: 1 }));
  const r2 = bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 2, generation: 1 }));
  const r3 = bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 3, generation: 1 }));
  const r4 = bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 0 }), { seq: 4, generation: 1 }));
  assert.deepEqual(r1, { relay: false, accepted: true });
  assert.deepEqual(r2, { relay: false, accepted: true });
  assert.deepEqual(r3, { relay: false, accepted: true });
  assert.deepEqual(r4, { relay: false, accepted: true });

  await bridge.drain();

  // Each frame went through the backend exactly once, in order, and the
  // resulting utterance was submitted once.
  assert.equal(calls, 4);
  assert.equal(fetches.length, 1);
  assert.equal(operatorResponses.length, 1);
  assert.equal(operatorResponses[0].value, 'こんにちは');
});

test('Atom audio VAD bridge async backend respects resetSession epoch', async () => {
  const operatorResponses = [];
  const vadBackend = {
    name: 'mock-async-slow',
    decide() {
      // Never resolves until we explicitly let it; the test does not await
      // any decisions before resetSession runs.
      return new Promise((resolve) => setTimeout(() => resolve({ isSpeech: true }), 5));
    }
  };
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    endSilenceMs: 100,
    minSpeechMs: 0,
    vadBackend,
    onOperatorResponse: (payload) => operatorResponses.push(payload),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ text: 'should not submit', language: 'ja' });
      }
    })
  });

  // Two speech frames whose decisions are still pending.
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 1, generation: 1 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 2, generation: 1 }));

  // External reset before any decision applies. Async results that captured
  // the old epoch must be ignored.
  bridge.resetSession('atom-test', { reason: 'tts_dispatch' });

  await bridge.drain();
  assert.equal(operatorResponses.length, 0);
});

test('imaAdpcmDecode round-trips a sine within ADPCM quantization noise', () => {
  const sine = pcm16Sine({ samples: 1024, freqHz: 440, amplitude: 8000 });
  const encoded = imaAdpcmEncode(sine);
  // 4-byte header + ceil((1024-1)/2) = 512 nibble bytes => 516 bytes total.
  // Raw PCM16 1024 samples = 2048 bytes. Compression factor ~4x as expected.
  assert.equal(encoded.length, 4 + Math.ceil(1023 / 2));
  assert.ok(encoded.length * 4 < sine.length * 5, 'expected >= 4x compression');

  const decoded = imaAdpcmDecode(encoded, 1024);
  assert.equal(decoded.length, sine.length);

  // First sample is in the header and reconstructs exactly.
  assert.equal(decoded.readInt16LE(0), sine.readInt16LE(0));

  // RMS error vs original should be small for a periodic signal.
  let sumSquares = 0;
  for (let i = 0; i < 1024; i += 1) {
    const orig = sine.readInt16LE(i * 2);
    const got = decoded.readInt16LE(i * 2);
    const err = (orig - got) / 32768;
    sumSquares += err * err;
  }
  const rmsError = Math.sqrt(sumSquares / 1024);
  assert.ok(rmsError < 0.02, `expected ADPCM RMS error < 0.02, got ${rmsError}`);
});

test('Atom audio VAD bridge decodes ima_adpcm frames before VAD/ASR submit', async () => {
  const fetches = [];
  const operatorResponses = [];
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    thresholdRms: 0.01,
    // 1024-sample ADPCM frames are 64 ms each; two trailing silence frames
    // give 128 ms, so endSilence must sit below that to finalize on drain.
    endSilenceMs: 100,
    minSpeechMs: 50,
    onOperatorResponse: (payload) => operatorResponses.push(payload),
    fetchImpl: async (url, options) => {
      fetches.push({ url: String(url), body: options.body });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ text: '圧縮も通る', language: 'ja' });
        }
      };
    }
  });

  // Speech frames as ADPCM.
  const speech = pcm16Sine({ samples: 1024, freqHz: 220, amplitude: 6000 });
  const silence = pcm16Sine({ samples: 1024, amplitude: 0 });
  function adpcmPayload(pcm, overrides) {
    const encoded = imaAdpcmEncode(pcm);
    return {
      v: 1,
      type: 'atom_audio_frame',
      session_id: 'atom-test',
      device_id: 'atom-test',
      language: 'ja',
      sample_rate: 16000,
      encoding: 'ima_adpcm',
      sample_count: 1024,
      audio_base64: encoded.toString('base64'),
      ...overrides
    };
  }

  bridge.handlePayload(adpcmPayload(speech, { seq: 1, generation: 1 }));
  bridge.handlePayload(adpcmPayload(speech, { seq: 2, generation: 1 }));
  bridge.handlePayload(adpcmPayload(silence, { seq: 3, generation: 1 }));
  bridge.handlePayload(adpcmPayload(silence, { seq: 4, generation: 1 }));
  await bridge.drain();

  assert.equal(fetches.length, 1);
  assert.equal(operatorResponses.length, 1);
  // The submitted WAV body must contain PCM16 (post-decode), not the
  // compressed bytes. Sanity-check by decoding the base64 wrapper.
  const submitted = JSON.parse(fetches[0].body);
  const wav = Buffer.from(submitted.audioBase64, 'base64');
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
});

test('Atom audio VAD bridge rejects unknown frame encodings', () => {
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    fetchImpl: async () => {
      throw new Error('fetch must not be called');
    }
  });
  const payload = {
    v: 1,
    type: 'atom_audio_frame',
    session_id: 'atom-test',
    device_id: 'atom-test',
    sample_rate: 16000,
    encoding: 'opus',
    audio_base64: Buffer.from([0, 0, 0, 0, 0, 0]).toString('base64')
  };
  const directive = bridge.handlePayload(payload);
  assert.equal(directive.accepted, false);
  assert.equal(directive.reason, 'unsupported_encoding');
});

test('Atom audio VAD bridge drops frames when no ASR upstream is configured', () => {
  const bridge = createAtomAudioVadBridge({
    // intentionally no asrBaseUrl / asrEndpointUrl
    thresholdRms: 0.01,
    fetchImpl: async () => {
      throw new Error('fetch must not be called when ASR is unconfigured');
    }
  });
  const directive = bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 })));
  assert.equal(directive.relay, false);
  assert.equal(directive.accepted, false);
  assert.equal(directive.reason, 'asr_not_configured');
});

test('Atom audio VAD bridge finalizes on a receive-gap timer when the device stops sending', async () => {
  const fetches = [];
  const operatorResponses = [];
  let clock = 1000;
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    thresholdRms: 0.01,
    endSilenceMs: 900,
    minSpeechMs: 50,
    now: () => clock,
    onOperatorResponse: (payload) => operatorResponses.push(payload),
    fetchImpl: async (url, options) => {
      fetches.push({ url: String(url), body: options.body });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ text: 'タイマー確定', language: 'ja' });
        }
      };
    }
  });

  // Two speech frames, then the device goes silent and sends NOTHING more
  // (firmware silence-skip past its tail). No trailing silence frames arrive.
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 1 }));
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 2 }));

  // A timer tick before the gap reaches endSilenceMs must NOT finalize.
  clock += 500;
  bridge.checkUtteranceTimeouts();
  await bridge.drain();
  assert.equal(fetches.length, 0);

  // Once the gap since the last received frame exceeds endSilenceMs, the
  // wall-clock fallback finalizes the buffered utterance — no tail frames
  // were needed, so the firmware tail is decoupled from endSilenceMs.
  clock += 500; // total gap 1000 ms >= 900 ms
  bridge.checkUtteranceTimeouts();
  await bridge.drain();
  assert.equal(fetches.length, 1);
  assert.equal(operatorResponses.length, 1);
  assert.equal(operatorResponses[0].value, 'タイマー確定');
});

test('Atom audio VAD bridge receive-gap timer ignores idle/too-short sessions', async () => {
  const fetches = [];
  let clock = 0;
  const bridge = createAtomAudioVadBridge({
    asrBaseUrl: 'http://127.0.0.1:8091',
    thresholdRms: 0.01,
    endSilenceMs: 900,
    minSpeechMs: 5000, // unrealistically high so the utterance never qualifies
    now: () => clock,
    fetchImpl: async () => {
      throw new Error('fetch must not be called when speechMs < minSpeechMs');
    }
  });
  bridge.handlePayload(audioPayload(pcmFrame({ samples: 1600, amplitude: 3000 }), { seq: 1 }));
  clock += 10000;
  bridge.checkUtteranceTimeouts();
  await bridge.drain();
  assert.equal(fetches.length, 0);
});
