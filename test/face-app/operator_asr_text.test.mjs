import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeOperatorRealtimeAsrText,
  getOperatorRealtimeAsrSuspicion,
  resolveOperatorRealtimeAsrFinalText,
  shouldAcceptOperatorBatchFallbackResult
} from '../../face-app/public/operator_asr_text.js';

test('operator ASR text analysis counts japanese and latin characters separately', () => {
  const analysis = analyzeOperatorRealtimeAsrText('githubにpushしてください');
  assert.equal(analysis.japaneseCount > 0, true);
  assert.equal(analysis.latinCount > 0, true);
  assert.equal(analysis.significantCount, analysis.japaneseCount + analysis.latinCount);
});

test('operator ASR suspicion keeps short latin-only tokens for PTT JA', () => {
  assert.equal(getOperatorRealtimeAsrSuspicion('GitHub', 'ja'), null);
  assert.equal(getOperatorRealtimeAsrSuspicion('push', 'ja'), null);
});

test('operator ASR suspicion flags long latin-only text for PTT JA', () => {
  assert.equal(getOperatorRealtimeAsrSuspicion('github push', 'ja'), 'latin-only-ja');
  assert.equal(getOperatorRealtimeAsrSuspicion('desorrasestahueikamushigamashin', 'ja'), 'latin-only-ja');
  assert.equal(getOperatorRealtimeAsrSuspicion('de sorras estahuei kamushigamashin.', 'ja'), 'latin-only-ja');
});

test('operator ASR suspicion still rejects obviously wrong scripts', () => {
  assert.equal(getOperatorRealtimeAsrSuspicion('테스트', 'ja'), 'hangul');
  assert.equal(getOperatorRealtimeAsrSuspicion('тест', 'ja'), 'cyrillic');
  assert.equal(getOperatorRealtimeAsrSuspicion('日本語だけ', 'en'), 'non-english');
});

test('operator ASR batch fallback acceptance uses the same suspicion rules', () => {
  assert.equal(shouldAcceptOperatorBatchFallbackResult({ text: 'github push' }, 'ja'), false);
  assert.equal(shouldAcceptOperatorBatchFallbackResult({ text: 'githubにpushしてください' }, 'ja'), true);
});

test('operator realtime ASR final text prefers normalized final text', () => {
  const resolved = resolveOperatorRealtimeAsrFinalText('きっとハブにプッシュしてください。', 'ignored draft', 'ja');
  assert.deepEqual(resolved, {
    text: 'GitHubにpushしてください。',
    source: 'final'
  });
});

test('operator realtime ASR final text falls back to normalized draft text when final text is empty', () => {
  const resolved = resolveOperatorRealtimeAsrFinalText('', 'きっとハブにプッシュしてください。', 'ja');
  assert.deepEqual(resolved, {
    text: 'GitHubにpushしてください。',
    source: 'draft'
  });
});

test('operator realtime ASR final text reports empty when neither final nor draft text is usable', () => {
  const resolved = resolveOperatorRealtimeAsrFinalText('   ', '   ', 'ja');
  assert.deepEqual(resolved, {
    text: '',
    source: 'empty'
  });
});
