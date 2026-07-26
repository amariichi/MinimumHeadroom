import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(currentDir, '../../face-app/public');

test('interpreter static UI labels contain no Japanese script', async () => {
  const files = [
    'interpreter.html',
    'interpreter.css',
    'interpreter.js',
    'interpreter_audio.js',
    'runtime_mode.css',
    'runtime_mode_ui.js'
  ];
  const japaneseScript = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
  for (const file of files) {
    const source = await readFile(path.join(publicDir, file), 'utf8');
    assert.equal(japaneseScript.test(source), false, `${file} contains Japanese script`);
  }
});

test('interpreter UI keeps provider and audio route out of the persistent form', async () => {
  const html = await readFile(path.join(publicDir, 'interpreter.html'), 'utf8');
  assert.equal((html.match(/<select\b/giu) ?? []).length, 4);
  assert.match(html, /<select id="pair-anchor-select"/u);
  assert.match(html, /<select id="pair-partner-select"/u);
  assert.match(html, /<select id="runtime-mode-select"/u);
  assert.match(html, /<select id="runtime-backend-select"/u);
  assert.doesNotMatch(html, /switch provider|use phone|use atom/i);
  assert.doesNotMatch(html, /provider-select|audio-route-select/u);
  assert.match(
    html,
    /id="runtime-mode-trigger"[\s\S]*id="provider-label"/u
  );
  assert.match(html, /id="talk-button"/);
  assert.match(html, /id="reset-button"/);
  assert.match(html, /id="volume-trigger"/);
  assert.match(html, /id="volume-slider"[\s\S]*max="200"/u);
  assert.match(html, /<span>\/ 200<\/span>/u);
  assert.match(html, /data-volume-preset="112">Indoor</u);
  assert.match(html, /data-volume-preset="160">Outdoor</u);
});

test('interpreter provider readout opens the same explicit runtime confirmation dialog', async () => {
  const html = await readFile(path.join(publicDir, 'interpreter.html'), 'utf8');
  const source = await readFile(
    path.join(publicDir, 'runtime_mode_ui.js'),
    'utf8'
  );
  assert.match(
    html,
    /id="runtime-mode-trigger"[\s\S]*aria-controls="runtime-mode-dialog"/u
  );
  assert.match(html, /<dialog[\s\S]*id="runtime-mode-dialog"/u);
  assert.match(html, />Mode</u);
  assert.match(html, />Backend preset</u);
  assert.match(html, />Switch</u);
  assert.match(source, /The current backend stops before the selected backend starts\./u);
  assert.match(source, /response\.status !== 202/u);
  assert.match(source, /transition\.state === 'rolled_back'/u);
});

test('language pair readout opens a native English-labelled pair dialog', async () => {
  const html = await readFile(path.join(publicDir, 'interpreter.html'), 'utf8');
  const source = await readFile(path.join(publicDir, 'interpreter.js'), 'utf8');
  assert.match(
    html,
    /id="pair-trigger"[\s\S]*aria-haspopup="dialog"[\s\S]*aria-controls="pair-dialog"/u
  );
  assert.match(html, /<dialog class="pair-dialog" id="pair-dialog"/u);
  assert.match(html, />Anchor language</u);
  assert.match(html, />Partner language</u);
  assert.match(html, />Apply pair</u);
  assert.match(source, /config\.manualPairLanguages/u);
  assert.match(source, /new Intl\.DisplayNames\(\['en'\]/u);
  assert.match(source, /localeCompare\(right\.label, 'en'/u);
  assert.match(source, /fetch\('\/api\/interpreter\/session\/pair'/u);
  assert.match(source, /'x-interpreter-session-id': sessionId/u);
  assert.match(source, /'x-interpreter-turn-id': nextTurnId\(\)/u);
  assert.match(source, /pair\.anchorLanguage === pair\.partnerLanguage/u);
});

test('interpreter UI hydrates the active session and latest turn after open or resume', async () => {
  const source = await readFile(path.join(publicDir, 'interpreter.js'), 'utf8');
  assert.match(source, /fetch\('\/api\/interpreter\/session'/);
  assert.match(source, /'x-interpreter-session-id': sessionId/);
  assert.match(source, /updateAudioEndpoint\(config\.atom\);\s*await loadSessionState\(\);/u);
  assert.match(source, /payload\?\.type === 'interpreter_audio_endpoint_changed'[\s\S]*loadSessionState\(\)/u);
  assert.match(source, /revision < state\.pairRevision/u);
  assert.match(source, /const turnActivityRevision = state\.turnActivityRevision/u);
  assert.match(source, /turnActivityRevision === state\.turnActivityRevision/u);
  assert.match(source, /payload\?\.type === 'interpreter_turn_completed'/u);
  assert.match(source, /payload\?\.type === 'interpreter_turn_ignored'/u);
  assert.match(source, /Speech was unclear\. Please try again\./u);
  assert.match(source, /state\.turnInProgressId !== snapshotTurnId/u);
  assert.match(source, /&& !hasNewerInProgressTurn/u);
  assert.match(source, /payload\.latestTurn[\s\S]*updateTurn\(payload\.latestTurn, \{ sessionId \}\)/u);
  assert.match(source, /addEventListener\('open',[\s\S]*scheduleSessionSync\(\)/u);
  assert.match(source, /addEventListener\('visibilitychange',[\s\S]*visibilityState === 'visible'[\s\S]*scheduleSessionSync\(\)/u);
  assert.match(source, /addEventListener\('pageshow',[\s\S]*scheduleSessionSync\(\)/u);
  assert.match(source, /addEventListener\('focus',[\s\S]*scheduleSessionSync\(\)/u);
  assert.match(source, /addEventListener\('online',[\s\S]*scheduleSessionSync\(\)/u);
  assert.doesNotMatch(
    source,
    /function updateTurn\(payload[\s\S]*updatePair\(payload\.state, \{ sessionId: state\.browserSessionId \}\)/u
  );
});

test('interpreter UI routes Atom volume through its same-origin authenticated API', async () => {
  const source = await readFile(path.join(publicDir, 'interpreter.js'), 'utf8');
  assert.match(source, /fetch\('\/api\/interpreter\/atom\/volume'/u);
  assert.match(source, /method: 'POST'/u);
  assert.match(source, /state\.atom\.volumeControl/u);
  assert.match(source, /elements\.volumeSlider\.addEventListener\('change'/u);
  assert.doesNotMatch(source, /fetch\(['"`]http:\/\/atom/u);
});
