import assert from 'node:assert/strict';
import test from 'node:test';
import { ansiIndexToCss, isDefaultAnsiStyle, parseAnsiRuns } from '../../face-app/public/operator_ansi.js';

function joinedText(runs) {
  return runs.map((entry) => entry.text).join('');
}

test('parseAnsiRuns parses xterm-256 foreground colors and reset', () => {
  const runs = parseAnsiRuns('\u001b[38;5;196mRED\u001b[0m plain');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].text, 'RED');
  assert.equal(runs[0].fg, 'rgb(255, 0, 0)');
  assert.equal(runs[0].bold, false);
  assert.equal(isDefaultAnsiStyle(runs[0]), false);
  assert.equal(runs[1].text, ' plain');
  assert.equal(isDefaultAnsiStyle(runs[1]), true);
});

test('parseAnsiRuns parses truecolor background and inverse flag', () => {
  const runs = parseAnsiRuns('\u001b[48;2;10;20;30m\u001b[7mX\u001b[27mY');
  assert.equal(joinedText(runs), 'XY');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].text, 'X');
  assert.equal(runs[0].bg, 'rgb(10, 20, 30)');
  assert.equal(runs[0].inverse, true);
  assert.equal(runs[1].text, 'Y');
  assert.equal(runs[1].bg, 'rgb(10, 20, 30)');
  assert.equal(runs[1].inverse, false);
});

test('parseAnsiRuns strips OSC control sequences and non-SGR CSI', () => {
  const runs = parseAnsiRuns(`start${'\u001b]0;title\u0007'}${'\u001b[2J'}end`);
  assert.equal(joinedText(runs), 'startend');
  assert.equal(runs.length, 1);
  assert.equal(isDefaultAnsiStyle(runs[0]), true);
});

test('ansiIndexToCss maps grayscale indexes', () => {
  assert.equal(ansiIndexToCss(232), 'rgb(8, 8, 8)');
  assert.equal(ansiIndexToCss(255), 'rgb(238, 238, 238)');
  assert.equal(ansiIndexToCss(999), null);
});
