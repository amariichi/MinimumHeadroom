import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateCorpusSpec } from '../../scripts/generate-interpreter-corpus.mjs';
import {
  assessInterpreterResponse,
  buildMtpEquivalenceComparisons,
  characterErrorRate,
  compareCorpusConfigurations,
  levenshteinDistance,
  normalizeBenchmarkText,
  summarizeCorpusSamples
} from '../../scripts/interpreter-corpus-benchmark.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');

test('checked-in corpus covers six baselines and explicit target directions', async () => {
  const raw = JSON.parse(
    await readFile(
      path.join(
        repoRoot,
        'config/benchmarks/interpreter-multilingual-corpus.json'
      ),
      'utf8'
    )
  );
  const corpus = validateCorpusSpec(raw);
  assert.equal(corpus.cases.length, 8);
  assert.deepEqual(
    corpus.cases
      .filter((item) => item.category === 'baseline')
      .map((item) => item.language),
    ['ja', 'en', 'es', 'fr', 'de', 'ko']
  );
  assert.equal(
    corpus.cases.find((item) => item.id === 'en-station')
      .expectedPipelineTarget,
    null
  );
  assert.deepEqual(
    corpus.cases
      .filter((item) => item.category === 'explicit-target')
      .map((item) => [
        item.expectedSource,
        item.expectedPipelineTarget
      ]),
    [
      ['es', 'ja'],
      ['ja', 'es']
    ]
  );
});

test('checked-in weather example fixes the documented four-preset input', async () => {
  const raw = JSON.parse(
    await readFile(
      path.join(
        repoRoot,
        'config/benchmarks/interpreter-weather-example.json'
      ),
      'utf8'
    )
  );
  const corpus = validateCorpusSpec(raw);
  assert.equal(corpus.corpusId, 'interpreter-weather-example-v1');
  assert.equal(corpus.generator.voice, 'F2');
  assert.equal(corpus.generator.revision, '724fb5abbf5502583fb520898d45929e62f02c0b');
  assert.deepEqual(corpus.requiredBaselineLanguages, ['ja']);
  assert.deepEqual(corpus.cases, [{
    id: 'ja-weather',
    category: 'baseline',
    language: 'ja',
    text: 'こんにちは。今日はいい天気ですね。雨は降るかな？',
    expectedTranscript: 'こんにちは。今日はいい天気ですね。雨は降るかな？',
    expectedContentText: 'こんにちは。今日はいい天気ですね。雨は降るかな？',
    expectedSource: 'ja',
    expectedPipelineTarget: 'en',
    expectedTarget: 'en',
    referenceTranslation: 'Hello. The weather is nice today. I wonder if it will rain?'
  }]);
});

test('benchmark normalization is Unicode-aware and punctuation-insensitive', () => {
  assert.equal(
    normalizeBenchmarkText(' Buenos DÍAS， Estación! '),
    'buenosdíasestación'
  );
  assert.equal(
    normalizeBenchmarkText('スペイン語にして。 駅はどこ？'),
    'スペイン語にして駅はどこ'
  );
  assert.equal(levenshteinDistance('station', 'stations'), 1);
  assert.equal(characterErrorRate('A B.', 'ab'), 0);
  assert.equal(characterErrorRate('cat', 'cut'), 0.3333);
});

test('first English benchmark turn requires transcript-only behavior', () => {
  const assessed = assessInterpreterResponse({
    ok: true,
    transcript: 'Good morning. Where is the train station?',
    contentText: 'Good morning. Where is the train station?',
    sourceLanguage: 'en',
    targetLanguage: null,
    translation: '',
    tts: { status: 'skipped' }
  }, {
    expectedSource: 'en',
    expectedPipelineTarget: null,
    expectedTranscript: 'Good morning. Where is the train station?',
    expectedContentText: 'Good morning. Where is the train station?',
    referenceTranslation: 'おはようございます。駅はどこですか？'
  });
  assert.equal(assessed.responseValid, true);
  assert.equal(assessed.transcriptCer, 0);
  assert.equal(assessed.translationReferenceCer, null);

  const wrongFallback = assessInterpreterResponse({
    ok: true,
    transcript: 'Good morning. Where is the train station?',
    contentText: 'Good morning. Where is the train station?',
    sourceLanguage: 'en',
    targetLanguage: 'ja',
    translation: 'おはようございます。駅はどこですか？',
    tts: { status: 'disabled' }
  }, {
    expectedSource: 'en',
    expectedPipelineTarget: null,
    expectedTranscript: 'Good morning. Where is the train station?',
    expectedContentText: 'Good morning. Where is the train station?',
    referenceTranslation: 'おはようございます。駅はどこですか？'
  });
  assert.equal(wrongFallback.directionValid, false);
  assert.equal(wrongFallback.responseValid, false);
});

test('explicit-target assessment grades instruction stripping separately', () => {
  const assessed = assessInterpreterResponse({
    ok: true,
    transcript:
      'Traduce al japonés: Buenos días. ¿Dónde está la estación de tren?',
    contentText: 'Buenos días. ¿Dónde está la estación de tren?',
    sourceLanguage: 'es-ES',
    targetLanguage: 'ja',
    translation: 'おはようございます。駅はどこですか？',
    tts: { status: 'disabled' }
  }, {
    expectedSource: 'es',
    expectedPipelineTarget: 'ja',
    expectedTranscript:
      'Traduce al japonés: Buenos días. ¿Dónde está la estación de tren?',
    expectedContentText: 'Buenos días. ¿Dónde está la estación de tren?',
    referenceTranslation: 'おはようございます。駅はどこですか？'
  });
  assert.equal(assessed.responseValid, true);
  assert.equal(assessed.transcriptExact, true);
  assert.equal(assessed.contentExact, true);
  assert.equal(assessed.translationReferenceCer, 0);
});

test('corpus summary keeps accuracy, CER, latency, and groups explicit', () => {
  const samples = [
    {
      caseId: 'es-one',
      category: 'explicit-target',
      expectedSource: 'es',
      responseValid: true,
      schemaValid: true,
      sourceValid: true,
      directionValid: true,
      ttsContractValid: true,
      transcriptCer: 0,
      transcriptExact: true,
      contentCer: 0,
      contentExact: true,
      translationReferenceCer: 0.2,
      totalMs: 100
    },
    {
      caseId: 'ja-one',
      category: 'baseline',
      expectedSource: 'ja',
      responseValid: false,
      schemaValid: true,
      sourceValid: false,
      directionValid: true,
      ttsContractValid: true,
      transcriptCer: 0.25,
      transcriptExact: false,
      contentCer: 0.25,
      contentExact: false,
      translationReferenceCer: 0.1,
      totalMs: 200
    }
  ];
  const summary = summarizeCorpusSamples(samples);
  assert.equal(summary.allValid, false);
  assert.equal(summary.sourceLanguageAccuracy, 0.5);
  assert.equal(summary.directionAccuracy, 1);
  assert.equal(summary.transcript.cer.median, 0);
  assert.equal(summary.transcript.cer.p95, 0.25);
  assert.equal(summary.latencyMs.median, 100);
  assert.equal(
    summary.explicitTargetInstructionStripping.exactAccuracy,
    1
  );
  assert.deepEqual(Object.keys(summary.perLanguage), ['es', 'ja']);
  assert.equal(summary.translationReference.informationalOnly, true);
});

test('MTP corpus comparison measures output equivalence against off', () => {
  const baseSample = {
    caseId: 'ja-explicit-es',
    run: 1,
    observedSource: 'ja',
    observedTarget: 'es',
    transcript: 'スペイン語にして。おはようございます。',
    contentText: 'おはようございます。',
    translation: 'Buenos días.',
    response: { commandOnly: false }
  };
  const baseline = {
    config: 'gemma4-supertonic-mtp-off',
    preset: 'gemma4-supertonic',
    mtp: { mode: 'off', draftTokens: 0 },
    caseManifest: { sha256: 'fixture-manifest' },
    samples: [baseSample]
  };
  const equivalent = {
    config: 'gemma4-supertonic-mtp-on-draft-1',
    preset: 'gemma4-supertonic',
    mtp: { mode: 'on', draftTokens: 1 },
    caseManifest: { sha256: 'fixture-manifest' },
    samples: [{
      ...baseSample,
      transcript: 'スペイン語にして おはようございます'
    }]
  };
  const compared = compareCorpusConfigurations(baseline, equivalent);
  assert.equal(compared.complete, true);
  assert.equal(compared.exactAllEquivalent, false);
  assert.equal(compared.normalizedAllEquivalent, true);
  assert.deepEqual(compared.mismatches[0].exactFields, ['transcript']);
  assert.deepEqual(compared.mismatches[0].normalizedFields, []);

  const changed = {
    ...equivalent,
    samples: [{
      ...baseSample,
      contentText: 'スペイン語にして。おはようございます。'
    }]
  };
  const comparisons = buildMtpEquivalenceComparisons([baseline, changed]);
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0].normalizedAllEquivalent, false);
  assert.deepEqual(
    comparisons[0].mismatches[0].normalizedFields,
    ['contentText']
  );
});
