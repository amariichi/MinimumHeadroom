import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAtomAudioVadBridge,
  createRmsVadBackend,
  createSileroVadBackend,
  pcm16Rms,
  pcm16ToWavBuffer
} from '../../face-app/dist/atom_audio_vad_bridge.js';

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
