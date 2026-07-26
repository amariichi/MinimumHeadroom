import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInterpreterTtsGate,
  interpreterManualPairLanguages,
  interpreterTtsSupportedLanguages,
  interpreterTtsSupportsLanguage
} from '../../face-app/dist/interpreter_tts_support.js';

test('Supertonic uses only its explicit 31-language set', () => {
  assert.equal(interpreterTtsSupportedLanguages('supertonic').length, 31);
  assert.equal(interpreterTtsSupportsLanguage('supertonic', 'es-ES'), true);
  assert.equal(interpreterTtsSupportsLanguage('supertonic', 'ja'), true);
  assert.equal(interpreterTtsSupportsLanguage('supertonic', 'zh'), false);
});

test('Qwen3 interpreter support does not silently fall back for other languages', () => {
  assert.equal(interpreterTtsSupportedLanguages('qwen3').length, 10);
  assert.equal(interpreterTtsSupportsLanguage('qwen3', 'zh-CN'), true);
  assert.equal(interpreterTtsSupportsLanguage('qwen3', 'ar'), false);
});

test('manual pair languages follow the end-to-end limit of each preset', () => {
  assert.equal(interpreterManualPairLanguages('light-cloud').length, 26);
  assert.equal(
    interpreterManualPairLanguages('nemotron-gemma4-supertonic').length,
    26
  );
  assert.deepEqual(
    interpreterManualPairLanguages('gemma4-supertonic'),
    interpreterTtsSupportedLanguages('supertonic')
  );
  assert.deepEqual(
    interpreterManualPairLanguages('gemma4-qwen3'),
    interpreterTtsSupportedLanguages('qwen3')
  );
  assert.deepEqual(
    interpreterManualPairLanguages('nemotron-gemma4-qwen3'),
    interpreterTtsSupportedLanguages('qwen3')
  );
  assert.equal(interpreterManualPairLanguages('light-cloud').includes('zh'), false);
  assert.equal(
    interpreterManualPairLanguages('nemotron-gemma4-qwen3').includes('zh'),
    true
  );
  assert.deepEqual(interpreterManualPairLanguages('unknown'), []);
});

test('interpreter TTS gate permits consecutive turns in one conversation session', () => {
  const gate = createInterpreterTtsGate();
  const payload = {
    session_id: 'atom:atom-headroom-1',
    priority: 2
  };

  assert.deepEqual(gate.check(payload, 0), { allow: true });
  assert.deepEqual(gate.check(payload, 1_000), { allow: true });
  assert.deepEqual(gate.check(payload, 2_000), { allow: true });
});
