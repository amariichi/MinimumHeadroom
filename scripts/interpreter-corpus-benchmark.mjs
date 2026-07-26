#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  readFile,
  readdir,
  rename,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { inspectPcm16MonoWav } from '../face-app/dist/interpreter_api.js';

function optionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function primaryLanguage(value) {
  return optionalString(value)?.toLowerCase().split('-')[0] ?? null;
}

function positiveInt(value, fallback = null) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback = null) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function finiteNumber(value, fallback = null) {
  if (
    value === null
    || value === undefined
    || typeof value === 'boolean'
    || (typeof value === 'string' && value.trim() === '')
  ) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rounded(value, digits = 4) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function normalizeBenchmarkText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\p{P}\p{Z}\s]/gu, '');
}

export function levenshteinDistance(left, right) {
  const source = [...String(left ?? '')];
  const target = [...String(right ?? '')];
  if (source.length === 0) {
    return target.length;
  }
  if (target.length === 0) {
    return source.length;
  }
  let previous = Array.from(
    { length: target.length + 1 },
    (_, index) => index
  );
  for (let sourceIndex = 1; sourceIndex <= source.length; sourceIndex += 1) {
    const current = [sourceIndex];
    for (let targetIndex = 1; targetIndex <= target.length; targetIndex += 1) {
      const substitution = previous[targetIndex - 1]
        + (source[sourceIndex - 1] === target[targetIndex - 1] ? 0 : 1);
      current[targetIndex] = Math.min(
        previous[targetIndex] + 1,
        current[targetIndex - 1] + 1,
        substitution
      );
    }
    previous = current;
  }
  return previous[target.length];
}

export function characterErrorRate(expected, observed) {
  const normalizedExpected = normalizeBenchmarkText(expected);
  const normalizedObserved = normalizeBenchmarkText(observed);
  const expectedLength = [...normalizedExpected].length;
  if (expectedLength === 0) {
    return normalizedObserved === '' ? 0 : null;
  }
  return rounded(
    levenshteinDistance(normalizedExpected, normalizedObserved) / expectedLength
  );
}

function percentile(values, fraction) {
  const sorted = values
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return sorted[index];
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) {
    return null;
  }
  return finite.reduce((total, value) => total + value, 0) / finite.length;
}

function metricSummary(values) {
  return {
    mean: rounded(mean(values), 4),
    median: rounded(percentile(values, 0.5), 4),
    p95: rounded(percentile(values, 0.95), 4)
  };
}

function accuracy(count, total) {
  return total > 0 ? rounded(count / total, 4) : null;
}

export function assessInterpreterResponse(response, benchmarkCase) {
  const expectedSource = primaryLanguage(benchmarkCase?.expectedSource);
  const expectedTarget = benchmarkCase?.expectedPipelineTarget === null
    ? null
    : primaryLanguage(benchmarkCase?.expectedPipelineTarget);
  const transcript = optionalString(response?.transcript) ?? '';
  const contentText = typeof response?.contentText === 'string'
    ? response.contentText.trim()
    : '';
  const observedSource = primaryLanguage(response?.sourceLanguage);
  const observedTarget = response?.targetLanguage === null
    ? null
    : primaryLanguage(response?.targetLanguage);
  const translation = typeof response?.translation === 'string'
    ? response.translation.trim()
    : '';
  const noTranslationExpected = expectedTarget === null;
  const targetContractValid = observedTarget === expectedTarget;
  const translationContractValid = noTranslationExpected
    ? translation === ''
    : translation !== '';
  const expectedTtsStatus = noTranslationExpected ? 'skipped' : 'disabled';
  const ttsContractValid = response?.tts?.status === expectedTtsStatus;
  const schemaValid = Boolean(
    response
    && typeof response === 'object'
    && response.ok === true
    && transcript
    && observedSource
    && typeof response.translation === 'string'
    && (response.targetLanguage === null || observedTarget)
  );
  const sourceValid = schemaValid && observedSource === expectedSource;
  const directionValid = schemaValid
    && targetContractValid
    && translationContractValid;
  const expectedTranscript = optionalString(benchmarkCase?.expectedTranscript);
  const expectedContentText = optionalString(benchmarkCase?.expectedContentText);
  const referenceTranslation = optionalString(
    benchmarkCase?.referenceTranslation
  );
  const transcriptCer = expectedTranscript
    ? characterErrorRate(expectedTranscript, transcript)
    : null;
  const contentCer = expectedContentText
    ? characterErrorRate(expectedContentText, contentText)
    : null;
  const translationReferenceCer = (
    referenceTranslation
    && translation
  )
    ? characterErrorRate(referenceTranslation, translation)
    : null;
  return {
    schemaValid,
    sourceValid,
    directionValid,
    ttsContractValid,
    responseValid:
      schemaValid
      && sourceValid
      && directionValid
      && ttsContractValid,
    expectedSource,
    observedSource,
    expectedTarget,
    observedTarget,
    transcript,
    transcriptCer,
    transcriptExact: transcriptCer === 0,
    contentText,
    contentCer,
    contentExact: contentCer === 0,
    translation,
    translationReferenceCer
  };
}

function summarizeFlatSamples(samples, includeGroups = true) {
  const values = Array.isArray(samples) ? samples : [];
  const transcriptEvaluated = values.filter(
    (sample) => Number.isFinite(sample.transcriptCer)
  );
  const contentEvaluated = values.filter(
    (sample) => Number.isFinite(sample.contentCer)
  );
  const translationEvaluated = values.filter(
    (sample) => Number.isFinite(sample.translationReferenceCer)
  );
  const explicitTargetSamples = values.filter(
    (sample) => sample.category === 'explicit-target'
  );
  const summary = {
    sampleCount: values.length,
    validCount: values.filter((sample) => sample.responseValid).length,
    allValid:
      values.length > 0
      && values.every((sample) => sample.responseValid),
    schemaAccuracy: accuracy(
      values.filter((sample) => sample.schemaValid).length,
      values.length
    ),
    sourceLanguageAccuracy: accuracy(
      values.filter((sample) => sample.sourceValid).length,
      values.length
    ),
    directionAccuracy: accuracy(
      values.filter((sample) => sample.directionValid).length,
      values.length
    ),
    ttsDisabledContractAccuracy: accuracy(
      values.filter((sample) => sample.ttsContractValid).length,
      values.length
    ),
    transcript: {
      evaluatedCount: transcriptEvaluated.length,
      exactAccuracy: accuracy(
        transcriptEvaluated.filter((sample) => sample.transcriptExact).length,
        transcriptEvaluated.length
      ),
      cer: metricSummary(
        transcriptEvaluated.map((sample) => sample.transcriptCer)
      )
    },
    content: {
      evaluatedCount: contentEvaluated.length,
      exactAccuracy: accuracy(
        contentEvaluated.filter((sample) => sample.contentExact).length,
        contentEvaluated.length
      ),
      cer: metricSummary(
        contentEvaluated.map((sample) => sample.contentCer)
      )
    },
    explicitTargetInstructionStripping: {
      evaluatedCount: explicitTargetSamples.length,
      exactAccuracy: accuracy(
        explicitTargetSamples.filter((sample) => sample.contentExact).length,
        explicitTargetSamples.length
      )
    },
    translationReference: {
      informationalOnly: true,
      evaluatedCount: translationEvaluated.length,
      cer: metricSummary(
        translationEvaluated.map(
          (sample) => sample.translationReferenceCer
        )
      )
    },
    latencyMs: metricSummary(
      values.map((sample) => sample.totalMs)
    )
  };
  if (!includeGroups) {
    return summary;
  }
  const byLanguage = {};
  const byCase = {};
  for (const sample of values) {
    const language = sample.expectedSource ?? 'unknown';
    const caseId = sample.caseId ?? 'unknown';
    (byLanguage[language] ??= []).push(sample);
    (byCase[caseId] ??= []).push(sample);
  }
  summary.perLanguage = Object.fromEntries(
    Object.entries(byLanguage)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([language, group]) => [
        language,
        summarizeFlatSamples(group, false)
      ])
  );
  summary.perCase = Object.fromEntries(
    Object.entries(byCase)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([caseId, group]) => [
        caseId,
        summarizeFlatSamples(group, false)
      ])
  );
  return summary;
}

export function summarizeCorpusSamples(samples) {
  return summarizeFlatSamples(samples, true);
}

function corpusSampleKey(sample) {
  return `${sample?.caseId ?? ''}:${sample?.run ?? ''}`;
}

function exactCorpusOutput(sample) {
  return {
    sourceLanguage: sample?.observedSource ?? null,
    targetLanguage: sample?.observedTarget ?? null,
    transcript: typeof sample?.transcript === 'string'
      ? sample.transcript.trim()
      : '',
    contentText: typeof sample?.contentText === 'string'
      ? sample.contentText.trim()
      : '',
    translation: typeof sample?.translation === 'string'
      ? sample.translation.trim()
      : '',
    commandOnly: sample?.response?.commandOnly === true
  };
}

function normalizedCorpusOutput(sample) {
  const exact = exactCorpusOutput(sample);
  return {
    ...exact,
    transcript: normalizeBenchmarkText(exact.transcript),
    contentText: normalizeBenchmarkText(exact.contentText),
    translation: normalizeBenchmarkText(exact.translation)
  };
}

function differentFields(left, right) {
  return Object.keys(left).filter((name) => left[name] !== right[name]);
}

export function compareCorpusConfigurations(baseline, candidate) {
  const baselineSamples = Array.isArray(baseline?.samples)
    ? baseline.samples
    : [];
  const candidateSamples = Array.isArray(candidate?.samples)
    ? candidate.samples
    : [];
  const sameManifest = Boolean(
    baseline?.caseManifest?.sha256
    && baseline.caseManifest.sha256 === candidate?.caseManifest?.sha256
  );
  const baselineByKey = new Map(
    baselineSamples.map((sample) => [corpusSampleKey(sample), sample])
  );
  const candidateKeys = new Set(
    candidateSamples.map((sample) => corpusSampleKey(sample))
  );
  const mismatches = [];
  let exactEquivalentCount = 0;
  let normalizedEquivalentCount = 0;
  let evaluatedCount = 0;

  for (const candidateSample of candidateSamples) {
    const key = corpusSampleKey(candidateSample);
    const baselineSample = baselineByKey.get(key);
    if (!baselineSample) {
      mismatches.push({
        caseId: candidateSample?.caseId ?? null,
        run: candidateSample?.run ?? null,
        reason: 'missing_baseline_sample',
        exactFields: [],
        normalizedFields: []
      });
      continue;
    }
    evaluatedCount += 1;
    const exactFields = differentFields(
      exactCorpusOutput(baselineSample),
      exactCorpusOutput(candidateSample)
    );
    const normalizedFields = differentFields(
      normalizedCorpusOutput(baselineSample),
      normalizedCorpusOutput(candidateSample)
    );
    if (exactFields.length === 0) {
      exactEquivalentCount += 1;
    }
    if (normalizedFields.length === 0) {
      normalizedEquivalentCount += 1;
    }
    if (exactFields.length > 0 || normalizedFields.length > 0) {
      mismatches.push({
        caseId: candidateSample?.caseId ?? null,
        run: candidateSample?.run ?? null,
        reason: 'output_changed',
        exactFields,
        normalizedFields
      });
    }
  }
  for (const baselineSample of baselineSamples) {
    const key = corpusSampleKey(baselineSample);
    if (!candidateKeys.has(key)) {
      mismatches.push({
        caseId: baselineSample?.caseId ?? null,
        run: baselineSample?.run ?? null,
        reason: 'missing_candidate_sample',
        exactFields: [],
        normalizedFields: []
      });
    }
  }
  const complete = (
    sameManifest
    && baselineSamples.length > 0
    && baselineSamples.length === candidateSamples.length
    && evaluatedCount === baselineSamples.length
  );
  return {
    baseline: {
      config: baseline?.config ?? null,
      preset: baseline?.preset ?? null,
      mtp: baseline?.mtp ?? null
    },
    candidate: {
      config: candidate?.config ?? null,
      preset: candidate?.preset ?? null,
      mtp: candidate?.mtp ?? null
    },
    sameManifest,
    complete,
    evaluatedCount,
    exactEquivalentCount,
    exactAllEquivalent:
      complete ? exactEquivalentCount === evaluatedCount : false,
    normalizedEquivalentCount,
    normalizedAllEquivalent:
      complete ? normalizedEquivalentCount === evaluatedCount : false,
    mismatches
  };
}

export function buildMtpEquivalenceComparisons(results) {
  const values = Array.isArray(results) ? results : [];
  const comparisons = [];
  for (const candidate of values) {
    if (candidate?.mtp?.mode !== 'on') {
      continue;
    }
    const baseline = values.find(
      (result) => result?.preset === candidate?.preset
        && result?.mtp?.mode === 'off'
    );
    if (baseline) {
      comparisons.push(compareCorpusConfigurations(baseline, candidate));
    }
  }
  return comparisons;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filename) {
  return sha256Bytes(await readFile(filename));
}

function resolveInside(baseDir, filename) {
  const absolute = path.resolve(baseDir, filename);
  if (absolute !== baseDir && !absolute.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error(`case path escapes the manifest directory: ${filename}`);
  }
  return absolute;
}

async function loadCorpusManifest(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  const manifestBytes = await readFile(absoluteManifest);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (
    manifest?.schemaVersion !== 1
    || !optionalString(manifest?.corpusId)
    || !Array.isArray(manifest?.cases)
    || manifest.cases.length === 0
  ) {
    throw new Error('invalid corpus manifest');
  }
  const baseDir = path.dirname(absoluteManifest);
  const ids = new Set();
  const cases = [];
  for (const [index, item] of manifest.cases.entries()) {
    const id = optionalString(item?.id);
    const filename = optionalString(item?.file);
    const expectedHash = optionalString(item?.sha256);
    const expectedSource = primaryLanguage(item?.expectedSource);
    const expectedTarget = primaryLanguage(item?.expectedTarget);
    const expectedPipelineTarget = item?.expectedPipelineTarget === null
      ? null
      : primaryLanguage(item?.expectedPipelineTarget);
    if (
      !id
      || ids.has(id)
      || !filename
      || !expectedHash
      || !expectedSource
      || !expectedTarget
      || (
        item?.expectedPipelineTarget !== null
        && !expectedPipelineTarget
      )
    ) {
      throw new Error(`invalid corpus case at index ${index}`);
    }
    ids.add(id);
    const absoluteFile = resolveInside(baseDir, filename);
    const audio = await readFile(absoluteFile);
    const observedHash = sha256Bytes(audio);
    if (observedHash !== expectedHash) {
      throw new Error(
        `corpus WAV hash mismatch for ${id}: ${observedHash} != ${expectedHash}`
      );
    }
    const inspected = inspectPcm16MonoWav(audio);
    if (!inspected.ok) {
      throw new Error(`invalid 16 kHz mono PCM16 WAV for ${id}`);
    }
    if (
      Number.isFinite(item.durationMs)
      && Math.abs(Number(item.durationMs) - inspected.durationMs) > 1
    ) {
      throw new Error(`corpus WAV duration mismatch for ${id}`);
    }
    cases.push({
      id,
      file: filename,
      sha256: expectedHash,
      durationMs: inspected.durationMs,
      category: optionalString(item.category) ?? 'unspecified',
      expectedTranscript: optionalString(item.expectedTranscript),
      expectedContentText: optionalString(item.expectedContentText),
      expectedSource,
      expectedPipelineTarget,
      expectedTarget,
      referenceTranslation: optionalString(item.referenceTranslation),
      audio
    });
  }
  return {
    path: absoluteManifest,
    sha256: sha256Bytes(manifestBytes),
    corpusId: manifest.corpusId,
    syntheticCleanBaseline: manifest.syntheticCleanBaseline === true,
    spec: manifest.spec ?? null,
    generator: manifest.generator ?? null,
    cases
  };
}

function parseArguments(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      throw new Error(`unexpected argument: ${item}`);
    }
    const name = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[name] = true;
    } else {
      options[name] = next;
      index += 1;
    }
  }
  return { command, options };
}

async function postTurn({
  endpoint,
  item,
  sessionId,
  turnId,
  timeoutMs
}) {
  const startedAt = performance.now();
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
        'x-interpreter-session-id': sessionId,
        'x-interpreter-turn-id': turnId
      },
      body: item.audio,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return {
      ok: false,
      totalMs: rounded(performance.now() - startedAt, 2),
      error: `request_failed:${error.name ?? 'Error'}:${error.message}`
    };
  }
  const totalMs = performance.now() - startedAt;
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      totalMs: rounded(totalMs, 2),
      httpStatus: response.status,
      error: 'invalid_json_response',
      responseText: raw.slice(0, 500)
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      totalMs: rounded(totalMs, 2),
      httpStatus: response.status,
      error: optionalString(body?.error) ?? `http_${response.status}`,
      response: body
    };
  }
  return {
    ok: true,
    totalMs: rounded(totalMs, 2),
    httpStatus: response.status,
    response: body
  };
}

function failedAssessment(item) {
  return {
    schemaValid: false,
    sourceValid: false,
    directionValid: false,
    ttsContractValid: false,
    responseValid: false,
    expectedSource: item.expectedSource,
    observedSource: null,
    expectedTarget: item.expectedPipelineTarget,
    observedTarget: null,
    transcript: '',
    transcriptCer: item.expectedTranscript === null ? null : 1,
    transcriptExact: false,
    contentText: '',
    contentCer: item.expectedContentText === null ? null : 1,
    contentExact: false,
    translation: '',
    translationReferenceCer: null
  };
}

async function runCommand(options) {
  const endpoint = optionalString(options.endpoint);
  const casesPath = optionalString(options.cases);
  const output = optionalString(options.output);
  const config = optionalString(options.config) ?? 'unspecified';
  const preset = optionalString(options.preset) ?? config;
  const mtp = optionalString(options.mtp) ?? 'off';
  const draftTokens = nonNegativeInt(options['draft-tokens'], 0);
  const runs = positiveInt(options.runs, 1);
  const warmup = nonNegativeInt(options.warmup, 1);
  const timeoutMs = positiveInt(options['request-timeout-ms'], 180_000);
  if (!endpoint || !casesPath || !output) {
    throw new Error('run requires --endpoint, --cases, and --output');
  }
  const corpus = await loadCorpusManifest(casesPath);
  for (let pass = 1; pass <= warmup; pass += 1) {
    for (const item of corpus.cases) {
      const warmed = await postTurn({
        endpoint,
        item,
        sessionId: `corpus-warmup-${process.pid}-${pass}-${item.id}`,
        turnId: `warmup-${pass}-${item.id}`,
        timeoutMs
      });
      if (!warmed.ok) {
        throw new Error(
          `warm-up failed for ${item.id}: ${warmed.error ?? 'unknown'}`
        );
      }
    }
  }

  const samples = [];
  for (let run = 1; run <= runs; run += 1) {
    for (const item of corpus.cases) {
      const request = await postTurn({
        endpoint,
        item,
        sessionId: `corpus-${process.pid}-${run}-${item.id}`,
        turnId: `measured-${run}-${item.id}`,
        timeoutMs
      });
      const assessment = request.ok
        ? assessInterpreterResponse(request.response, item)
        : failedAssessment(item);
      samples.push({
        caseId: item.id,
        category: item.category,
        run,
        durationMs: item.durationMs,
        totalMs: request.totalMs,
        httpStatus: request.httpStatus ?? null,
        requestError: request.ok ? null : request.error,
        ...assessment,
        response: request.response ?? null
      });
      process.stdout.write(
        `[interpreter-corpus] ${config} run=${run} case=${item.id} `
        + `source=${assessment.observedSource ?? 'none'}/${item.expectedSource} `
        + `target=${assessment.observedTarget ?? 'none'}/${item.expectedPipelineTarget ?? 'none'} `
        + `cer=${assessment.transcriptCer ?? 'n/a'} `
        + `latency_ms=${request.totalMs} valid=${assessment.responseValid}\n`
      );
    }
  }

  const result = {
    schemaVersion: 1,
    kind: 'interpreter-corpus-result',
    config,
    preset,
    mtp: {
      mode: mtp,
      draftTokens: mtp === 'on' ? draftTokens : 0
    },
    createdAt: new Date().toISOString(),
    syntheticCleanBaseline: corpus.syntheticCleanBaseline,
    realWorldAccuracyClaim: false,
    caseManifest: {
      path: corpus.path,
      sha256: corpus.sha256,
      corpusId: corpus.corpusId,
      spec: corpus.spec,
      generator: corpus.generator,
      cases: corpus.cases.map((item) => ({
        id: item.id,
        file: item.file,
        sha256: item.sha256,
        durationMs: item.durationMs,
        category: item.category,
        expectedTranscript: item.expectedTranscript,
        expectedContentText: item.expectedContentText,
        expectedSource: item.expectedSource,
        expectedPipelineTarget: item.expectedPipelineTarget,
        expectedTarget: item.expectedTarget,
        referenceTranslation: item.referenceTranslation
      }))
    },
    warmup,
    runs,
    samples,
    summary: summarizeCorpusSamples(samples)
  };
  await atomicWriteJson(path.resolve(output), result);
}

async function atomicWriteJson(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, filename);
}

async function annotateCommand(options) {
  const input = optionalString(options.input);
  if (!input) {
    throw new Error('annotate requires --input');
  }
  const filename = path.resolve(input);
  const value = JSON.parse(await readFile(filename, 'utf8'));
  if (value?.kind !== 'interpreter-corpus-result') {
    throw new Error('annotate input is not an interpreter corpus result');
  }
  value.runtime = {
    coldStartMs: finiteNumber(options['cold-start-ms']),
    gpuMemoryMiB: {
      before: finiteNumber(options['gpu-before']),
      loaded: finiteNumber(options['gpu-loaded']),
      afterTurns: finiteNumber(options['gpu-after']),
      loadedDelta: (
        finiteNumber(options['gpu-before']) !== null
        && finiteNumber(options['gpu-loaded']) !== null
      )
        ? finiteNumber(options['gpu-loaded'])
          - finiteNumber(options['gpu-before'])
        : null,
      postTurnDelta: (
        finiteNumber(options['gpu-before']) !== null
        && finiteNumber(options['gpu-after']) !== null
      )
        ? finiteNumber(options['gpu-after'])
          - finiteNumber(options['gpu-before'])
        : null
    },
    log: optionalString(options.log),
    annotatedAt: new Date().toISOString()
  };
  await atomicWriteJson(filename, value);
}

async function reportCommand(options) {
  const inputDir = optionalString(options.input);
  const output = optionalString(options.output);
  const environmentPath = optionalString(options.environment);
  if (!inputDir || !output || !environmentPath) {
    throw new Error('report requires --input, --environment, and --output');
  }
  const absoluteInput = path.resolve(inputDir);
  const filenames = (await readdir(absoluteInput))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const results = [];
  for (const filename of filenames) {
    const candidate = JSON.parse(
      await readFile(path.join(absoluteInput, filename), 'utf8')
    );
    if (candidate?.kind === 'interpreter-corpus-result') {
      candidate.summary = summarizeCorpusSamples(candidate.samples);
      results.push(candidate);
    }
  }
  if (results.length === 0) {
    throw new Error('report found no interpreter corpus result files');
  }
  const manifestHashes = new Set(
    results.map((result) => result.caseManifest?.sha256)
  );
  if (manifestHashes.size !== 1 || manifestHashes.has(undefined)) {
    throw new Error('result files do not share one corpus manifest');
  }
  const report = {
    schemaVersion: 1,
    kind: 'interpreter-corpus-report',
    generatedAt: new Date().toISOString(),
    syntheticCleanBaseline: true,
    realWorldAccuracyClaim: false,
    recommendation: null,
    recommendationReason:
      'Synthetic clean speech is a reproducible baseline; human/noisy/Atom recordings remain required.',
    environment: JSON.parse(
      await readFile(path.resolve(environmentPath), 'utf8')
    ),
    caseManifest: results[0].caseManifest,
    mtpEquivalence: buildMtpEquivalenceComparisons(results),
    results
  };
  await atomicWriteJson(path.resolve(output), report);
}

function usage() {
  return `Usage:
  node scripts/interpreter-corpus-benchmark.mjs run \\
    --endpoint URL --cases FILE --output FILE --config NAME --preset NAME \\
    --mtp off|on [--draft-tokens N] [--warmup N] [--runs N]

  node scripts/interpreter-corpus-benchmark.mjs annotate \\
    --input FILE --cold-start-ms N --gpu-before N --gpu-loaded N \\
    --gpu-after N --log FILE

  node scripts/interpreter-corpus-benchmark.mjs report \\
    --input DIR --environment FILE --output FILE
`;
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (options.help || command === 'help' || !command) {
    process.stdout.write(usage());
    return;
  }
  if (command === 'run') {
    await runCommand(options);
    return;
  }
  if (command === 'annotate') {
    await annotateCommand(options);
    return;
  }
  if (command === 'report') {
    await reportCommand(options);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[interpreter-corpus] ${error.message}\n`);
    process.exitCode = 1;
  });
}
