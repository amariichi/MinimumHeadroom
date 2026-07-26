import assert from 'node:assert/strict';
import test from 'node:test';
import {
  atomInterpreterSessionId,
  listInterpreterPresets,
  resolveInterpreterPreset
} from '../../face-app/dist/interpreter_runtime_config.js';

test('interpreter runtime exposes the four local ASR and TTS combinations', () => {
  assert.deepEqual(listInterpreterPresets(), [
    'gemma4-supertonic',
    'gemma4-qwen3',
    'nemotron-gemma4-supertonic',
    'nemotron-gemma4-qwen3'
  ]);
});

test('interpreter presets own independent ASR and TTS choices with local Gemma translation', () => {
  assert.deepEqual(resolveInterpreterPreset('light-cloud'), {
    name: 'nemotron-gemma4-supertonic',
    asr: 'nemotron-3.5-asr',
    intent: 'gemma4',
    translation: 'gemma4',
    tts: 'supertonic'
  });
  assert.equal(resolveInterpreterPreset('gemma4-qwen3').tts, 'qwen3');
  assert.deepEqual(resolveInterpreterPreset('nemotron-gemma4-qwen3'), {
    name: 'nemotron-gemma4-qwen3',
    asr: 'nemotron-3.5-asr',
    intent: 'gemma4',
    translation: 'gemma4',
    tts: 'qwen3'
  });
  for (const presetName of listInterpreterPresets()) {
    const resolved = resolveInterpreterPreset(presetName);
    assert.equal(resolved.intent, 'gemma4');
    assert.equal(resolved.translation, 'gemma4');
    assert.notEqual(resolved.asr, 'agy-gemini');
  }
  assert.equal(resolveInterpreterPreset().name, 'gemma4-supertonic');
  assert.throws(() => resolveInterpreterPreset('operator'), /unsupported interpreter preset/);
});

test('Atom interpreter sessions are stable and device-scoped', () => {
  assert.equal(atomInterpreterSessionId('atom-headroom-1'), 'atom:atom-headroom-1');
  assert.equal(atomInterpreterSessionId(''), 'atom:headroom');
});
