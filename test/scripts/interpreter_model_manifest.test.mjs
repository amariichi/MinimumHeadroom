import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  interpreterManualPairLanguages,
  interpreterTtsSupportedLanguages
} from '../../face-app/dist/interpreter_tts_support.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');

async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8'));
}

function primaryLanguage(locale) {
  return locale.toLowerCase().split('-')[0];
}

function pythonSingleQuotedValues(source, constantName) {
  const match = source.match(
    new RegExp(
      `${constantName}\\s*=\\s*(?:frozenset\\s*\\(\\s*)?\\{([\\s\\S]*?)\\}\\s*\\)?`,
      'u'
    )
  );
  assert.ok(match, `${constantName} must remain an explicit Python set`);
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]);
}

test('speech manifest and runtime TTS support lists stay synchronized', async () => {
  const manifest = await loadJson('config/models/interpreter-speech.json');
  assert.deepEqual(
    interpreterTtsSupportedLanguages('supertonic'),
    [...manifest.models.supertonic.languages].sort()
  );
  assert.deepEqual(
    interpreterTtsSupportedLanguages('qwen3'),
    [...manifest.models.qwen3Tts.languages].sort()
  );
});

test('speech manifest stays synchronized with both Python TTS engines', async () => {
  const manifest = await loadJson('config/models/interpreter-speech.json');
  const supertonicSource = await readFile(
    path.join(repoRoot, 'tts-worker/src/tts_worker/supertonic_engine.py'),
    'utf8'
  );
  const qwenSource = await readFile(
    path.join(repoRoot, 'tts-worker/src/tts_worker/qwen3_text.py'),
    'utf8'
  );
  assert.deepEqual(
    pythonSingleQuotedValues(
      supertonicSource,
      'SUPPORTED_SUPERTONIC_LANGUAGES'
    ).sort(),
    [...manifest.models.supertonic.languages].sort()
  );

  const qwenAliases = new Set(
    pythonSingleQuotedValues(qwenSource, 'QWEN3_LANGUAGE_ALIASES')
      .filter((value) => /^[a-z]{2}$/u.test(value))
  );
  assert.deepEqual(
    [...qwenAliases].sort(),
    [...manifest.models.qwen3Tts.languages].sort()
  );
});

test('Nemotron end-to-end intersections use all out-of-box locales and exclude adaptation-only locales', async () => {
  const manifest = await loadJson('config/models/interpreter-speech.json');
  const outOfBox = new Set([
    ...manifest.models.nemotron.transcriptionReadyLocales,
    ...manifest.models.nemotron.broadCoverageLocales
  ].map(primaryLanguage));
  const expectedPrimary = [...outOfBox].sort();
  const expectedSupertonic = manifest.models.supertonic.languages
    .filter((language) => outOfBox.has(language))
    .sort();
  const expectedQwen3 = manifest.models.qwen3Tts.languages
    .filter((language) => outOfBox.has(language))
    .sort();
  assert.deepEqual(
    [...manifest.nemotronOutOfBoxPrimaryLanguages].sort(),
    expectedPrimary
  );
  assert.deepEqual(
    [...manifest.nemotronOutOfBoxSupertonicIntersection].sort(),
    expectedSupertonic
  );
  assert.deepEqual(
    [...manifest.nemotronOutOfBoxQwen3Intersection].sort(),
    expectedQwen3
  );
  assert.deepEqual(
    interpreterManualPairLanguages('light-cloud'),
    [...manifest.nemotronOutOfBoxSupertonicIntersection].sort()
  );
  assert.deepEqual(
    interpreterManualPairLanguages('nemotron-gemma4-supertonic'),
    [...manifest.nemotronOutOfBoxSupertonicIntersection].sort()
  );
  assert.deepEqual(
    interpreterManualPairLanguages('nemotron-gemma4-qwen3'),
    [...manifest.nemotronOutOfBoxQwen3Intersection].sort()
  );
  assert.equal(expectedSupertonic.includes('th'), false);
  assert.equal(expectedSupertonic.includes('he'), false);
  assert.equal(expectedQwen3.includes('zh'), true);
  assert.equal(expectedQwen3.length, 10);
});

test('Nemotron worker pins the Transformers audio feature dependency', async () => {
  const pyproject = await readFile(
    path.join(repoRoot, 'interpreter-asr-worker/pyproject.toml'),
    'utf8'
  );
  assert.match(pyproject, /"librosa==0\.11\.0"/u);
});

test('Gemma manifest records the verified converted assistant as a final artifact', async () => {
  const manifest = await loadJson('config/models/gemma4-interpreter.json');
  assert.equal(
    manifest.assistantGguf.sha256,
    '25f143b4c15b20cd04216e35e99bd7a56afc6f65e7a4e090a3e20091bb590cbb'
  );
  assert.equal(manifest.assistantGguf.bytes, 322_915_136);
  assert.equal(manifest.assistantGguf.converterUsesMtpFlag, false);
  assert.equal(
    manifest.llamaCpp.knownGoodCommit,
    'c1304d7b28e14380dbb90252c92aa2798db60185'
  );
});

test('interpreter manifests distinguish model and package licenses', async () => {
  const gemma = await loadJson('config/models/gemma4-interpreter.json');
  const speech = await loadJson('config/models/interpreter-speech.json');

  assert.equal(gemma.runtime.license, 'apache-2.0');
  assert.equal(gemma.assistantSource.license, 'apache-2.0');
  assert.equal(gemma.assistantGguf.license, 'apache-2.0');
  assert.equal(gemma.llamaCpp.license, 'mit');
  assert.equal(speech.models.nemotron.license, 'openmdw-1.1');
  assert.equal(speech.models.supertonic.license, 'openrail-m');
  assert.equal(speech.models.supertonic.packageLicense, 'mit');
  assert.equal(speech.models.qwen3Tts.license, 'apache-2.0');
  assert.equal(speech.models.qwen3Tts.packageLicense, 'apache-2.0');

  for (const entry of [
    gemma.runtime,
    gemma.assistantSource,
    gemma.assistantGguf,
    gemma.llamaCpp,
    speech.models.nemotron,
    speech.models.supertonic,
    speech.models.qwen3Tts
  ]) {
    assert.match(entry.licenseUrl, /^https:\/\//u);
  }
});

test('interpreter Gemma scripts use portable defaults instead of a developer home', async () => {
  const scripts = [
    'scripts/benchmark-gemma4-mtp.sh',
    'scripts/benchmark-interpreter-corpus.sh',
    'scripts/build-gemma4-gguf.sh',
    'scripts/check-llama-gemma4.sh',
    'scripts/interpreter-doctor.sh',
    'scripts/run-gemma4-interpreter.sh',
    'scripts/setup-gemma4-interpreter.sh',
    'scripts/setup-interpreter-stack.sh'
  ];
  for (const script of scripts) {
    const source = await readFile(path.join(repoRoot, script), 'utf8');
    assert.doesNotMatch(source, /\/home\/[A-Za-z0-9._-]+(?:\/|$)/u, script);
  }
});
