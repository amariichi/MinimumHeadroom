import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRmsVadBackend,
  pcm16ToWavBuffer
} from '../../face-app/dist/atom_audio_vad_bridge.js';
import {
  buildVadReplayScenarios,
  decodePcm16MonoWav,
  replayVadScenario,
  silencePcm,
  sinePcm
} from '../../scripts/atom-vad-replay.mjs';

test('device-free VAD replay decodes the generated PCM16 WAV contract', () => {
  const pcm = sinePcm({ durationMs: 640, amplitude: 5000 });
  const decoded = decodePcm16MonoWav(pcm16ToWavBuffer(pcm, 16000));
  assert.equal(decoded.sampleRate, 16000);
  assert.equal(decoded.durationMs, 640);
  assert.deepEqual(decoded.pcm, pcm);
});

test('device-free VAD replay scenarios include speech, pauses, codec, and diagnostics', () => {
  const corpusCases = [
    {
      id: 'a',
      pcm: Buffer.concat([
        silencePcm(100),
        sinePcm({ durationMs: 800, frequencyHz: 220 }),
        silencePcm(100)
      ])
    },
    {
      id: 'b',
      pcm: Buffer.concat([
        silencePcm(100),
        sinePcm({ durationMs: 800, frequencyHz: 330 }),
        silencePcm(100)
      ])
    }
  ];
  const scenarios = buildVadReplayScenarios(corpusCases);
  assert.equal(scenarios.length, 10);
  assert.ok(scenarios.some((item) => item.id === 'pause-within-turn'));
  assert.ok(scenarios.some((item) => item.id === 'pause-between-turns'));
  assert.ok(scenarios.some((item) => item.encoding === 'ima_adpcm'));
  assert.ok(scenarios.some((item) => item.id === 'tts-reset-stale-echo'));
  assert.equal(
    scenarios.find((item) => item.id === 'loud-broadband-noise').required,
    false
  );
});

test('device-free VAD replay accepts sustained RMS speech once', async () => {
  const scenario = {
    id: 'speech',
    group: 'test',
    description: 'synthetic sustained signal',
    pcm: Buffer.concat([
      silencePcm(256),
      sinePcm({ durationMs: 640, amplitude: 7000 }),
      silencePcm(768)
    ]),
    encoding: 'pcm16',
    expectedTurns: 1,
    required: true
  };
  const result = await replayVadScenario({
    scenario,
    backend: createRmsVadBackend({ thresholdRms: 0.025 }),
    backendName: 'rms',
    minSpeechMs: 350,
    endSilenceMs: 700
  });
  assert.equal(result.passed, true);
  assert.equal(result.observedTurns, 1);
  assert.equal(result.maxConcurrentDecisions, 1);
});

test('device-free VAD replay rejects a burst below minSpeechMs', async () => {
  const scenario = {
    id: 'burst',
    group: 'test',
    description: 'short burst',
    pcm: Buffer.concat([
      sinePcm({ durationMs: 256, amplitude: 7000 }),
      silencePcm(768)
    ]),
    encoding: 'pcm16',
    expectedTurns: 0,
    required: true
  };
  const result = await replayVadScenario({
    scenario,
    backend: createRmsVadBackend({ thresholdRms: 0.025 }),
    backendName: 'rms',
    minSpeechMs: 350,
    endSilenceMs: 700
  });
  assert.equal(result.passed, true);
  assert.equal(result.observedTurns, 0);
});
