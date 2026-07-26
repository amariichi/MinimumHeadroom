#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  parseInterpreterModelJson
} from '../face-app/dist/interpreter_model_json.js';
import {
  characterErrorRate,
  normalizeBenchmarkText
} from './interpreter-corpus-benchmark.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..');

const BENCHMARK_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'transcript',
    'source_language',
    'target_language',
    'translation'
  ],
  properties: {
    transcript: { type: 'string' },
    source_language: { type: 'string' },
    target_language: { type: 'string' },
    translation: { type: 'string' }
  }
});

function optionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function positiveInt(value, fallback = null) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback = null) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function primaryLanguage(value) {
  return optionalString(value)?.toLowerCase().split('-')[0] ?? null;
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return sorted[index];
}

function rounded(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function summarizeBenchmarkSamples(samples) {
  const measured = Array.isArray(samples) ? samples : [];
  const totalMs = measured.map((sample) => sample.totalMs);
  const firstContentMs = measured.map((sample) => sample.firstContentMs);
  const predictedPerSecond = measured.map(
    (sample) => sample.timings?.predicted_per_second
  );
  const draftN = measured.reduce(
    (total, sample) => total + (Number(sample.timings?.draft_n) || 0),
    0
  );
  const draftAccepted = measured.reduce(
    (total, sample) => total + (Number(sample.timings?.draft_n_accepted) || 0),
    0
  );
  const validCount = measured.filter(
    (sample) => sample.schemaValid && sample.directionValid
  ).length;
  const transcriptSamples = measured.filter(
    (sample) => Number.isFinite(sample.transcriptCer)
  );
  const transcriptExactCount = transcriptSamples.filter(
    (sample) => sample.transcriptExact
  ).length;
  const transcriptCer = transcriptSamples.map(
    (sample) => sample.transcriptCer
  );
  return {
    sampleCount: measured.length,
    validCount,
    allValid: measured.length > 0 && validCount === measured.length,
    totalMs: {
      median: rounded(percentile(totalMs, 0.5)),
      p95: rounded(percentile(totalMs, 0.95))
    },
    firstContentMs: {
      median: rounded(percentile(firstContentMs, 0.5)),
      p95: rounded(percentile(firstContentMs, 0.95))
    },
    predictedTokensPerSecondMedian: rounded(
      percentile(predictedPerSecond, 0.5)
    ),
    transcript: {
      evaluatedCount: transcriptSamples.length,
      exactCount: transcriptExactCount,
      allExact:
        transcriptSamples.length > 0
          ? transcriptExactCount === transcriptSamples.length
          : null,
      exactAccuracy:
        transcriptSamples.length > 0
          ? rounded(transcriptExactCount / transcriptSamples.length)
          : null,
      cer: {
        mean: rounded(
          transcriptCer.length > 0
            ? transcriptCer.reduce((total, value) => total + value, 0)
              / transcriptCer.length
            : null,
          4
        ),
        median: rounded(percentile(transcriptCer, 0.5), 4),
        p95: rounded(percentile(transcriptCer, 0.95), 4)
      }
    },
    draft: {
      generated: draftN,
      accepted: draftAccepted,
      acceptanceRate: draftN > 0
        ? rounded(draftAccepted / draftN)
        : null
    }
  };
}

function compareTranscriptsWithBaseline(baseline, candidate) {
  const baselineSamples = Array.isArray(baseline?.samples)
    ? baseline.samples
    : [];
  const candidateSamples = Array.isArray(candidate?.samples)
    ? candidate.samples
    : [];
  const baselineByKey = new Map();
  for (const sample of baselineSamples) {
    const transcript = optionalString(sample?.observedTranscript);
    if (!transcript) {
      continue;
    }
    baselineByKey.set(
      `${sample.caseId ?? ''}:${sample.run ?? ''}`,
      normalizeBenchmarkText(transcript)
    );
  }
  let evaluatedCount = 0;
  let equivalentCount = 0;
  for (const sample of candidateSamples) {
    const transcript = optionalString(sample?.observedTranscript);
    const key = `${sample.caseId ?? ''}:${sample.run ?? ''}`;
    if (!transcript || !baselineByKey.has(key)) {
      continue;
    }
    evaluatedCount += 1;
    if (
      normalizeBenchmarkText(transcript) === baselineByKey.get(key)
    ) {
      equivalentCount += 1;
    }
  }
  return {
    evaluatedCount,
    equivalentCount,
    allEquivalent:
      evaluatedCount > 0
        ? equivalentCount === evaluatedCount
        : null
  };
}

export function selectMtpCandidate(results, options = {}) {
  const minimumImprovement = Number.isFinite(options.minimumImprovement)
    ? options.minimumImprovement
    : 0.05;
  const maximumFirstContentRegression = Number.isFinite(
    options.maximumFirstContentRegression
  )
    ? options.maximumFirstContentRegression
    : 0.10;
  const minimumAcceptanceRate = Number.isFinite(options.minimumAcceptanceRate)
    ? options.minimumAcceptanceRate
    : 0.40;
  const values = Array.isArray(results) ? results : [];
  const baseline = values.find((result) => result.mode === 'off');
  const baselineTotal = baseline?.summary?.totalMs?.median;
  const baselineFirst = baseline?.summary?.firstContentMs?.median;
  if (
    !baseline?.summary?.allValid
    || !Number.isFinite(baselineTotal)
    || !Number.isFinite(baselineFirst)
  ) {
    return {
      candidate: null,
      reason: 'baseline_invalid_or_incomplete'
    };
  }

  const assessed = values
    .filter((result) => result.mode === 'mtp')
    .map((result) => {
      const total = result.summary?.totalMs?.median;
      const first = result.summary?.firstContentMs?.median;
      const acceptance = result.summary?.draft?.acceptanceRate;
      const improvement = Number.isFinite(total)
        ? (baselineTotal - total) / baselineTotal
        : null;
      const firstRegression = Number.isFinite(first)
        ? (first - baselineFirst) / baselineFirst
        : null;
      const transcriptEquivalence = compareTranscriptsWithBaseline(
        baseline,
        result
      );
      const reasons = [];
      if (!result.summary?.allValid) reasons.push('schema_or_direction_failure');
      if (
        transcriptEquivalence.evaluatedCount > 0
        && transcriptEquivalence.allEquivalent !== true
      ) {
        reasons.push('transcript_changed_from_off');
      }
      if (!Number.isFinite(improvement) || improvement < minimumImprovement) {
        reasons.push('total_latency_not_improved');
      }
      if (
        !Number.isFinite(firstRegression)
        || firstRegression > maximumFirstContentRegression
      ) {
        reasons.push('first_content_regressed');
      }
      if (
        !Number.isFinite(acceptance)
        || acceptance < minimumAcceptanceRate
      ) {
        reasons.push('draft_acceptance_too_low');
      }
      return {
        result,
        improvement,
        firstRegression,
        acceptance,
        transcriptEquivalence,
        reasons
      };
    });
  const passing = assessed
    .filter((entry) => entry.reasons.length === 0)
    .sort((left, right) => right.improvement - left.improvement);
  if (passing.length === 0) {
    return {
      candidate: null,
      reason: 'no_mtp_mode_met_thresholds',
      assessments: assessed.map((entry) => ({
        draftTokens: entry.result.draftTokens,
        transcriptEquivalence: entry.transcriptEquivalence,
        reasons: entry.reasons
      }))
    };
  }
  const winner = passing[0];
  return {
    candidate: {
      draftTokens: winner.result.draftTokens,
      totalLatencyImprovement: rounded(winner.improvement),
      firstContentRegression: rounded(winner.firstRegression),
      acceptanceRate: rounded(winner.acceptance),
      transcriptEquivalence: winner.transcriptEquivalence
    },
    reason: 'candidate_met_thresholds'
  };
}

function benchmarkPrompt(expectedTarget) {
  return `Transcribe this spoken audio and translate it faithfully into ${expectedTarget}.

Return exact JSON with transcript, source_language, target_language, and translation.
Use primary BCP 47 language tags. target_language must be ${expectedTarget}.
Do not answer questions in the audio and do not add commentary.`;
}

function dataFramesFromText(buffer) {
  const blocks = buffer.split(/\r?\n\r?\n/u);
  const remainder = blocks.pop() ?? '';
  const frames = [];
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) {
      frames.push(data);
    }
  }
  return { frames, remainder };
}

async function streamChatCompletion(response, startedAt) {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemma HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  if (!response.body) {
    throw new Error('Gemma response had no body');
  }
  const decoder = new TextDecoder();
  let pending = '';
  let assistantText = '';
  let firstContentMs = null;
  let timings = null;

  const consume = (data) => {
    if (data === '[DONE]') {
      return;
    }
    let value;
    try {
      value = JSON.parse(data);
    } catch {
      throw new Error('Gemma returned an invalid SSE data frame');
    }
    const content =
      value?.choices?.[0]?.delta?.content
      ?? value?.choices?.[0]?.message?.content
      ?? '';
    if (typeof content === 'string' && content !== '') {
      if (firstContentMs === null) {
        firstContentMs = performance.now() - startedAt;
      }
      assistantText += content;
    }
    if (value?.timings && typeof value.timings === 'object') {
      timings = value.timings;
    }
  };

  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    const parsed = dataFramesFromText(pending);
    pending = parsed.remainder;
    for (const frame of parsed.frames) {
      consume(frame);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    const parsed = dataFramesFromText(`${pending}\n\n`);
    for (const frame of parsed.frames) {
      consume(frame);
    }
  }
  return {
    assistantText,
    firstContentMs,
    timings
  };
}

async function runOneSample({
  endpoint,
  model,
  audio,
  expectedSource,
  expectedTarget,
  expectedTranscript,
  caseId,
  run
}) {
  const startedAt = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0,
      seed: 0,
      max_tokens: 512,
      cache_prompt: false,
      reasoning_format: 'none',
      timings_per_token: false,
      chat_template_kwargs: { enable_thinking: false },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'gemma4_mtp_benchmark',
          strict: true,
          schema: BENCHMARK_SCHEMA
        }
      },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: audio.toString('base64'),
                format: 'wav'
              }
            },
            {
              type: 'text',
              text: benchmarkPrompt(expectedTarget)
            }
          ]
        }
      ]
    })
  });
  const streamed = await streamChatCompletion(response, startedAt);
  const totalMs = performance.now() - startedAt;
  const parsed = parseInterpreterModelJson(streamed.assistantText);
  const source = primaryLanguage(parsed?.source_language);
  const target = primaryLanguage(parsed?.target_language);
  const transcript = optionalString(parsed?.transcript) ?? '';
  const transcriptCer = expectedTranscript
    ? characterErrorRate(expectedTranscript, transcript)
    : null;
  const schemaValid = Boolean(
    optionalString(parsed?.transcript)
    && source
    && target
    && optionalString(parsed?.translation)
  );
  return {
    caseId,
    run,
    expectedSource,
    expectedTarget,
    expectedTranscript,
    observedSource: source,
    observedTarget: target,
    observedTranscript: transcript,
    normalizedTranscript: normalizeBenchmarkText(transcript),
    transcriptCer,
    transcriptExact: transcriptCer === 0,
    schemaValid,
    directionValid:
      schemaValid
      && source === expectedSource
      && target === expectedTarget,
    firstContentMs: rounded(streamed.firstContentMs),
    totalMs: rounded(totalMs),
    timings: streamed.timings
  };
}

async function sha256(pathname) {
  const bytes = await readFile(pathname);
  return createHash('sha256').update(bytes).digest('hex');
}

async function loadCases(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifest, 'utf8'));
  if (!Array.isArray(manifest?.cases) || manifest.cases.length === 0) {
    throw new Error('case manifest must contain a non-empty cases array');
  }
  const baseDir = path.dirname(absoluteManifest);
  const cases = [];
  for (const [index, value] of manifest.cases.entries()) {
    const filename = optionalString(value?.file);
    const expectedSource = primaryLanguage(value?.expectedSource);
    const expectedTarget = primaryLanguage(value?.expectedTarget);
    const expectedTranscript = optionalString(value?.expectedTranscript);
    if (!filename || !expectedSource || !expectedTarget) {
      throw new Error(`invalid benchmark case at index ${index}`);
    }
    const absoluteFile = path.resolve(baseDir, filename);
    const audio = await readFile(absoluteFile);
    if (
      audio.length < 44
      || audio.toString('ascii', 0, 4) !== 'RIFF'
      || audio.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new Error(`case is not a WAV file: ${absoluteFile}`);
    }
    const observedHash = createHash('sha256').update(audio).digest('hex');
    const expectedHash = optionalString(value?.sha256);
    if (expectedHash && observedHash !== expectedHash) {
      throw new Error(
        `case WAV hash mismatch for ${value.id ?? index}: `
        + `${observedHash} != ${expectedHash}`
      );
    }
    cases.push({
      id: optionalString(value.id) ?? `case-${index + 1}`,
      file: filename,
      sha256: observedHash,
      expectedSource,
      expectedTarget,
      expectedTranscript,
      audio
    });
  }
  return {
    path: absoluteManifest,
    sha256: await sha256(absoluteManifest),
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
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      options[name] = true;
    } else {
      options[name] = value;
      index += 1;
    }
  }
  return { command, options };
}

async function runCommand(options) {
  const endpoint = optionalString(options.endpoint);
  const manifestPath = optionalString(options.cases);
  const output = optionalString(options.output);
  const mode = options.mode === 'off' ? 'off' : 'mtp';
  const draftTokens = mode === 'mtp'
    ? positiveInt(options['draft-tokens'])
    : 0;
  const runs = positiveInt(options.runs, 3);
  const warmup = nonNegativeInt(options.warmup, 1);
  const model = optionalString(options.model)
    ?? 'gemma-4-12b-it-qat-q4_0.gguf';
  if (!endpoint || !manifestPath || !output) {
    throw new Error('run requires --endpoint, --cases, and --output');
  }
  if (mode === 'mtp' && !draftTokens) {
    throw new Error('MTP run requires --draft-tokens');
  }
  const cases = await loadCases(manifestPath);
  for (const item of cases.cases) {
    for (let index = 0; index < warmup; index += 1) {
      await runOneSample({
        endpoint,
        model,
        audio: item.audio,
        expectedSource: item.expectedSource,
        expectedTarget: item.expectedTarget,
        expectedTranscript: item.expectedTranscript,
        caseId: item.id,
        run: `warmup-${index + 1}`
      });
    }
  }
  const samples = [];
  for (let run = 1; run <= runs; run += 1) {
    for (const item of cases.cases) {
      samples.push(await runOneSample({
        endpoint,
        model,
        audio: item.audio,
        expectedSource: item.expectedSource,
        expectedTarget: item.expectedTarget,
        expectedTranscript: item.expectedTranscript,
        caseId: item.id,
        run
      }));
    }
  }
  const result = {
    schemaVersion: 1,
    mode,
    draftTokens,
    createdAt: new Date().toISOString(),
    caseManifest: {
      path: cases.path,
      sha256: cases.sha256,
      cases: cases.cases.map((item) => ({
        id: item.id,
        file: item.file,
        sha256: item.sha256,
        expectedSource: item.expectedSource,
        expectedTarget: item.expectedTarget,
        expectedTranscript: item.expectedTranscript
      }))
    },
    warmup,
    runs,
    samples,
    summary: summarizeBenchmarkSamples(samples)
  };
  await writeFile(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`);
}

async function reportCommand(options) {
  const inputDir = optionalString(options.input);
  const output = optionalString(options.output);
  const environmentPath = optionalString(options.environment);
  const approvedDraft = positiveInt(options['approve-draft']);
  if (!inputDir || !output || !environmentPath) {
    throw new Error('report requires --input, --environment, and --output');
  }
  const files = (await readdir(path.resolve(inputDir)))
    .filter((name) => /^(off|mtp-[0-9]+)\.json$/u.test(name))
    .sort();
  const results = [];
  for (const filename of files) {
    results.push(JSON.parse(
      await readFile(path.join(path.resolve(inputDir), filename), 'utf8')
    ));
  }
  const environment = JSON.parse(
    await readFile(path.resolve(environmentPath), 'utf8')
  );
  const selection = selectMtpCandidate(results);
  if (
    approvedDraft
    && selection.candidate?.draftTokens !== approvedDraft
  ) {
    throw new Error(
      `draft ${approvedDraft} cannot be approved; measured candidate is `
      + `${selection.candidate?.draftTokens ?? 'none'}`
    );
  }
  const report = {
    schemaVersion: 1,
    recommended: Boolean(
      approvedDraft
      && selection.candidate?.draftTokens === approvedDraft
    ),
    draftTokens: approvedDraft ?? selection.candidate?.draftTokens ?? null,
    approval: approvedDraft
      ? {
          explicit: true,
          approvedAt: new Date().toISOString()
        }
      : {
          explicit: false,
          reason: 'run again with --approve-draft only after reviewing results'
        },
    selection,
    environment,
    results,
    generatedAt: new Date().toISOString()
  };
  await writeFile(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`);
}

function usage() {
  return `Usage:
  node scripts/gemma4-mtp-benchmark.mjs run \\
    --endpoint URL --cases FILE --output FILE \\
    --mode off|mtp [--draft-tokens N] [--warmup N] [--runs N]

  node scripts/gemma4-mtp-benchmark.mjs report \\
    --input DIR --environment FILE --output FILE [--approve-draft N]
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
  if (command === 'report') {
    await reportCommand(options);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[gemma4-mtp-benchmark] ${error.message}\n`);
    process.exitCode = 1;
  });
}
