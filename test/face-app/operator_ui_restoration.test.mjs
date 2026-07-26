import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');

test('operator controls retain their established order around the title trigger', async () => {
  const source = await readFile(
    path.join(repoRoot, 'face-app/public/index.html'),
    'utf8'
  );
  assert.match(
    source,
    /<header class="operator-header">[\s\S]*id="operator-title"[\s\S]*id="operator-esc-inline"[\s\S]*id="operator-close"[\s\S]*<\/header>[\s\S]*id="operator-status"[\s\S]*id="operator-agent-current"[\s\S]*id="operator-prompt"[\s\S]*id="operator-ptt-ja"[\s\S]*id="operator-text-card"[\s\S]*class="operator-keypad"[\s\S]*id="operator-mirror"/u
  );
});

test('operator mode entry reuses the title and keeps the confirmation UI in a dialog', async () => {
  const source = await readFile(path.join(repoRoot, 'face-app/public/index.html'), 'utf8');
  const behavior = await readFile(
    path.join(repoRoot, 'face-app/public/runtime_mode_ui.js'),
    'utf8'
  );
  const styles = await readFile(
    path.join(repoRoot, 'face-app/public/runtime_mode.css'),
    'utf8'
  );
  assert.equal((source.match(/class="operator-title runtime-mode-trigger"/gu) ?? []).length, 1);
  assert.match(source, /id="operator-title"[\s\S]*aria-controls="runtime-mode-dialog"/u);
  assert.match(
    styles,
    /\.operator-title\.runtime-mode-trigger\s*\{[\s\S]*font-family:\s*inherit;[\s\S]*font-weight:\s*700;/u
  );
  assert.match(source, /<dialog[\s\S]*id="runtime-mode-dialog"/u);
  assert.match(source, />Mode</u);
  assert.match(source, />Backend preset</u);
  assert.match(source, />Cancel</u);
  assert.match(source, />Switch</u);
  assert.doesNotMatch(source, /operator-mode-switch|interpreter-mode-button/u);
  assert.match(behavior, /addEventListener\('submit'/u);
  assert.match(behavior, /fetchImpl\('\/api\/runtime\/switch'/u);
  assert.match(behavior, /window\.location\.reload\(\)/u);
});
