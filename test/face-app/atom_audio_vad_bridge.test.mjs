import assert from 'node:assert/strict';
import test from 'node:test';
import { createAtomAudioVadBridge, pcm16Rms, pcm16ToWavBuffer } from '../../face-app/dist/atom_audio_vad_bridge.js';

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
