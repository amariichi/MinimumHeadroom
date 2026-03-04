import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOperatorTextInsertion, normalizeOperatorTextSelection } from '../../face-app/public/operator_text_insert.js';

test('operator text insertion appends at end by default', () => {
  const result = buildOperatorTextInsertion('hello', 'world', 'en');
  assert.equal(result.text, 'hello world');
  assert.equal(result.caretStart, result.text.length);
});

test('operator text insertion inserts at caret position', () => {
  const result = buildOperatorTextInsertion('abcXYZ', '123', 'en', 3, 3);
  assert.equal(result.text, 'abc 123 XYZ');
});

test('operator text insertion replaces selected range', () => {
  const result = buildOperatorTextInsertion('hello brave world', 'small', 'en', 6, 11);
  assert.equal(result.text, 'hello small world');
});

test('operator text insertion avoids adding extra space before punctuation', () => {
  const result = buildOperatorTextInsertion('Hello!', 'world', 'en', 5, 5);
  assert.equal(result.text, 'Hello world!');
});

test('operator text insertion preserves Japanese insertion without forcing trailing space', () => {
  const result = buildOperatorTextInsertion('日本語です', '追加', 'ja', 2, 2);
  assert.equal(result.text, '日本追加語です');
});

test('operator text selection normalizes invalid ranges', () => {
  assert.deepEqual(normalizeOperatorTextSelection('abcd', -5, 99), { start: 0, end: 4 });
});
