import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRealtimePrimaryOutcome,
  defaultLoopSpeakers,
  evaluateLoopCase,
  normalizeLoopObservedText,
  normalizeLoopSpeakerName,
  parseLoopSpeakers
} from '../../scripts/tts-asr-loop-lib.mjs';

test('normalizeLoopObservedText strips optional leading filler before normalization', () => {
  const fixture = {
    language: 'ja',
    allowOptionalHaiPrefix: true
  };
  assert.equal(normalizeLoopObservedText('はい、きっとハブにプッシュしてください。', fixture), 'GitHubにpushしてください');
});

test('evaluateLoopCase passes exact canonical matches', () => {
  const fixture = {
    language: 'ja',
    tier: 'stable',
    displayText: 'PRを出してCIを確認します。'
  };
  const result = evaluateLoopCase(fixture, 'ピーアールを出してシーアイを確認します。');
  assert.equal(result.status, 'pass');
  assert.equal(result.reason, 'expected-match');
  assert.equal(result.normalizedObserved, 'PRを出してCIを確認します');
});

test('evaluateLoopCase treats lower-case short acronyms as equivalent for comparison', () => {
  const fixture = {
    language: 'ja',
    tier: 'stable',
    displayText: 'PRを出してCIが通ったらCDします。'
  };
  const result = evaluateLoopCase(fixture, 'prを出してciが通ったらcdします。');
  assert.equal(result.status, 'pass');
  assert.equal(result.reason, 'expected-match');
  assert.equal(result.normalizedObserved, 'PRを出してCIが通ったらCDします');
});

test('evaluateLoopCase ignores comma-only punctuation differences in japanese comparison', () => {
  const fixture = {
    language: 'ja',
    tier: 'stable',
    displayText: 'PRを出してCIが通ったらCDします。'
  };
  const result = evaluateLoopCase(fixture, 'prを出して、ciが通ったら、cdします。');
  assert.equal(result.status, 'pass');
  assert.equal(result.reason, 'expected-match');
  assert.equal(result.normalizedObserved, 'PRを出してCIが通ったらCDします');
});

test('evaluateLoopCase ignores trailing sentence punctuation in japanese comparison', () => {
  const fixture = {
    language: 'ja',
    tier: 'stable',
    displayText: 'JSONとYAMLを確認します。'
  };
  const result = evaluateLoopCase(fixture, 'JSONとYAMLを確認します');
  assert.equal(result.status, 'pass');
  assert.equal(result.reason, 'expected-match');
  assert.equal(result.normalizedObserved, 'JSONとYAMLを確認します');
});

test('evaluateLoopCase ignores spacing at ascii-japanese boundaries in comparison', () => {
  const fixture = {
    language: 'ja',
    tier: 'stable',
    displayText: 'GitHub承認申請をお願いします。'
  };
  const result = evaluateLoopCase(fixture, 'ギットハブ 承認申請をお願いします');
  assert.equal(result.status, 'pass');
  assert.equal(result.reason, 'expected-match');
  assert.equal(result.normalizedObserved, 'GitHub承認申請お願いします');
});

test('evaluateLoopCase ignores optional を before お願いします in japanese comparison', () => {
  const fixture = {
    language: 'ja',
    tier: 'stable',
    displayText: '承認申請をお願いします。',
    allowOptionalHaiPrefix: true
  };
  const result = evaluateLoopCase(fixture, 'はい、承認申請お願いします。');
  assert.equal(result.status, 'pass');
  assert.equal(result.reason, 'expected-match');
  assert.equal(result.normalizedObserved, '承認申請お願いします');
});

test('evaluateLoopCase warns for fragile mismatches', () => {
  const fixture = {
    language: 'ja',
    tier: 'fragile',
    displayText: 'GitHub承認申請をお願いします。'
  };
  const result = evaluateLoopCase(fixture, 'ギットハブ承認新生をお願いします。');
  assert.equal(result.status, 'warn');
  assert.equal(result.reason, 'fragile-mismatch');
});

test('evaluateLoopCase fails for stable empty outputs', () => {
  const fixture = {
    language: 'ja',
    tier: 'stable',
    displayText: 'JSONを確認します。'
  };
  const result = evaluateLoopCase(fixture, '  ');
  assert.equal(result.status, 'fail');
  assert.equal(result.reason, 'empty-output');
});

test('parseLoopSpeakers canonicalizes known speaker aliases', () => {
  assert.deepEqual(parseLoopSpeakers('serena, vivian, ono anna'), ['Serena', 'Vivian', 'Ono_Anna']);
  assert.equal(normalizeLoopSpeakerName('Ono_Anna'), 'Ono_Anna');
});

test('parseLoopSpeakers falls back to the default speaker matrix', () => {
  assert.deepEqual(parseLoopSpeakers('', defaultLoopSpeakers), ['Serena', 'Vivian', 'Ono_Anna']);
});

test('classifyRealtimePrimaryOutcome accepts stable realtime text', () => {
  assert.deepEqual(
    classifyRealtimePrimaryOutcome({ text: 'PRを出してCIを確認します。', language: 'ja', hasBufferedAudio: true }),
    {
      useFallback: false,
      reason: 'accepted',
      acceptedText: 'PRを出してCIを確認します。',
      suspicion: null
    }
  );
});

test('classifyRealtimePrimaryOutcome requests fallback for suspicious ja latin-only text', () => {
  const result = classifyRealtimePrimaryOutcome({
    text: 'github push please',
    language: 'ja',
    hasBufferedAudio: true
  });
  assert.equal(result.useFallback, true);
  assert.equal(result.reason, 'suspicious');
  assert.equal(result.suspicion, 'latin-only-ja');
});

test('classifyRealtimePrimaryOutcome requests fallback for realtime errors when audio exists', () => {
  assert.deepEqual(
    classifyRealtimePrimaryOutcome({ error: 'realtime_asr_socket_error', language: 'ja', hasBufferedAudio: true }),
    {
      useFallback: true,
      reason: 'error',
      acceptedText: '',
      suspicion: null
    }
  );
});
