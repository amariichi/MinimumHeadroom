#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  createAtomAudioVadBridge,
  createRmsVadBackend,
  createSileroVadBackend,
  pcm16Rms
} from '../face-app/dist/atom_audio_vad_bridge.js';
import { inspectPcm16MonoWav } from '../face-app/dist/interpreter_api.js';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const repoRoot = path.resolve(currentDir, '..');
const defaultManifest = path.join(
  repoRoot,
  '.local/state/interpreter/corpus/supertonic-multilingual-v1/manifest.json'
);
const defaultOutput = path.join(
  repoRoot,
  '.local/state/interpreter/atom-vad-replay-benchmark.json'
);

const IMA_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
];
const IMA_INDEX_TABLE = [
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8
];

function optionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeNumber(value, label) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    manifest: defaultManifest,
    output: defaultOutput,
    backends: ['rms', 'silero'],
    sileroBaseUrl: 'http://127.0.0.1:18094',
    frameSamples: 1024,
    preRollMs: 256,
    endSilenceMs: 700,
    minSpeechMs: 350,
    maxUtteranceMs: 12_000,
    rmsThreshold: 0.025,
    sileroThreshold: 0.5,
    dryRun: false,
    help: false
  };
  const valueOptions = new Map([
    ['--manifest', 'manifest'],
    ['--output', 'output'],
    ['--backends', 'backends'],
    ['--silero-base-url', 'sileroBaseUrl'],
    ['--frame-samples', 'frameSamples'],
    ['--pre-roll-ms', 'preRollMs'],
    ['--end-silence-ms', 'endSilenceMs'],
    ['--min-speech-ms', 'minSpeechMs'],
    ['--max-utterance-ms', 'maxUtteranceMs'],
    ['--rms-threshold', 'rmsThreshold'],
    ['--silero-threshold', 'sileroThreshold']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--dry-run') {
      options.dryRun = true;
    } else if (item === '-h' || item === '--help') {
      options.help = true;
    } else if (valueOptions.has(item)) {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        throw new Error(`${item} requires a value`);
      }
      options[valueOptions.get(item)] = next;
      index += 1;
    } else {
      throw new Error(`unknown option: ${item}`);
    }
  }
  options.manifest = path.resolve(options.manifest);
  options.output = path.resolve(options.output);
  options.backends = String(options.backends)
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (
    options.backends.length === 0
    || options.backends.some((item) => !['rms', 'silero'].includes(item))
  ) {
    throw new Error('--backends must contain rms, silero, or rms,silero');
  }
  options.backends = [...new Set(options.backends)];
  options.frameSamples = positiveInteger(options.frameSamples, '--frame-samples');
  options.preRollMs = nonNegativeNumber(options.preRollMs, '--pre-roll-ms');
  options.endSilenceMs = positiveInteger(
    options.endSilenceMs,
    '--end-silence-ms'
  );
  options.minSpeechMs = nonNegativeNumber(
    options.minSpeechMs,
    '--min-speech-ms'
  );
  options.maxUtteranceMs = positiveInteger(
    options.maxUtteranceMs,
    '--max-utterance-ms'
  );
  options.rmsThreshold = nonNegativeNumber(
    options.rmsThreshold,
    '--rms-threshold'
  );
  options.sileroThreshold = nonNegativeNumber(
    options.sileroThreshold,
    '--silero-threshold'
  );
  if (options.rmsThreshold > 1 || options.sileroThreshold > 1) {
    throw new Error('VAD thresholds must not exceed 1');
  }
  return options;
}

export function decodePcm16MonoWav(buffer) {
  const inspection = inspectPcm16MonoWav(buffer);
  if (!inspection.ok) {
    throw new Error(`WAV is not 16 kHz mono PCM16: ${inspection.error}`);
  }
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + chunkSize > buffer.length) {
      throw new Error('WAV chunk exceeds file length');
    }
    if (chunkId === 'data') {
      return {
        pcm: Buffer.from(buffer.subarray(start, start + chunkSize)),
        sampleRate: inspection.format.sampleRate,
        durationMs: inspection.durationMs
      };
    }
    offset = start + chunkSize + (chunkSize % 2);
  }
  throw new Error('WAV data chunk is missing');
}

function pcmDurationMs(pcm, sampleRate = 16_000) {
  return Math.round((Math.floor(pcm.length / 2) / sampleRate) * 1000);
}

export function silencePcm(durationMs, sampleRate = 16_000) {
  const samples = Math.max(0, Math.round((durationMs / 1000) * sampleRate));
  return Buffer.alloc(samples * 2);
}

export function sinePcm({
  durationMs,
  frequencyHz = 440,
  amplitude = 6000,
  sampleRate = 16_000
}) {
  const samples = Math.max(0, Math.round((durationMs / 1000) * sampleRate));
  const result = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(
      amplitude * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate)
    );
    result.writeInt16LE(value, index * 2);
  }
  return result;
}

export function deterministicNoisePcm({
  durationMs,
  amplitude = 2800,
  seed = 0x51f15e,
  sampleRate = 16_000
}) {
  const samples = Math.max(0, Math.round((durationMs / 1000) * sampleRate));
  const result = Buffer.alloc(samples * 2);
  let state = seed >>> 0;
  for (let index = 0; index < samples; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const unit = (state >>> 0) / 0xffffffff;
    const value = Math.max(
      -32768,
      Math.min(32767, Math.round((unit * 2 - 1) * amplitude))
    );
    result.writeInt16LE(value, index * 2);
  }
  return result;
}

export function trimPcmSilence(
  pcm,
  {
    thresholdRms = 0.005,
    windowSamples = 160
  } = {}
) {
  const bytesPerWindow = windowSamples * 2;
  let first = 0;
  while (first + bytesPerWindow <= pcm.length) {
    if (pcm16Rms(pcm.subarray(first, first + bytesPerWindow)) >= thresholdRms) {
      break;
    }
    first += bytesPerWindow;
  }
  let last = pcm.length;
  while (last - bytesPerWindow >= first) {
    if (pcm16Rms(pcm.subarray(last - bytesPerWindow, last)) >= thresholdRms) {
      break;
    }
    last -= bytesPerWindow;
  }
  return Buffer.from(pcm.subarray(first, last));
}

function clampInt16(value) {
  return Math.max(-32768, Math.min(32767, value));
}

function clampStepIndex(value) {
  return Math.max(0, Math.min(88, value));
}

export function imaAdpcmEncode(pcm16Buffer) {
  const samples = Math.floor(pcm16Buffer.length / 2);
  if (samples === 0) {
    return Buffer.alloc(0);
  }
  const output = Buffer.alloc(4 + Math.ceil((samples - 1) / 2));
  let predictor = pcm16Buffer.readInt16LE(0);
  let stepIndex = 0;
  output.writeInt16LE(predictor, 0);
  output.writeInt8(stepIndex, 2);
  output[3] = 0;
  let outputOffset = 4;
  let pendingNibble = null;
  for (let index = 1; index < samples; index += 1) {
    const sample = pcm16Buffer.readInt16LE(index * 2);
    let difference = sample - predictor;
    let code = 0;
    if (difference < 0) {
      code = 0x8;
      difference = -difference;
    }
    const step = IMA_STEP_TABLE[stepIndex];
    if (difference >= step) {
      code |= 0x4;
      difference -= step;
    }
    if (difference >= (step >> 1)) {
      code |= 0x2;
      difference -= step >> 1;
    }
    if (difference >= (step >> 2)) {
      code |= 0x1;
    }
    let delta = step >> 3;
    if (code & 0x1) delta += step >> 2;
    if (code & 0x2) delta += step >> 1;
    if (code & 0x4) delta += step;
    predictor = clampInt16(predictor + ((code & 0x8) ? -delta : delta));
    stepIndex = clampStepIndex(stepIndex + IMA_INDEX_TABLE[code]);
    if (pendingNibble === null) {
      pendingNibble = code & 0x0f;
    } else {
      output[outputOffset] = pendingNibble | ((code & 0x0f) << 4);
      outputOffset += 1;
      pendingNibble = null;
    }
  }
  if (pendingNibble !== null) {
    output[outputOffset] = pendingNibble;
    outputOffset += 1;
  }
  return output.subarray(0, outputOffset);
}

async function loadCorpus(manifestPath) {
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (
    manifest?.schemaVersion !== 1
    || !Array.isArray(manifest.cases)
    || manifest.cases.length < 2
  ) {
    throw new Error('corpus manifest must be schemaVersion 1 with at least two cases');
  }
  const manifestDir = path.dirname(manifestPath);
  const cases = [];
  for (const item of manifest.cases) {
    const id = optionalString(item?.id);
    const relativeFile = optionalString(item?.file);
    if (!id || !relativeFile || !optionalString(item?.sha256)) {
      throw new Error('corpus case is missing id, file, or sha256');
    }
    const filename = path.resolve(manifestDir, relativeFile);
    const wav = await readFile(filename);
    const observedHash = sha256(wav);
    if (observedHash !== item.sha256) {
      throw new Error(`corpus WAV hash mismatch for ${id}`);
    }
    const decoded = decodePcm16MonoWav(wav);
    cases.push({
      id,
      language: optionalString(item.language) ?? 'und',
      file: relativeFile,
      sha256: observedHash,
      pcm: decoded.pcm,
      durationMs: decoded.durationMs
    });
  }
  return {
    manifest,
    manifestSha256: sha256(manifestBytes),
    cases
  };
}

export function buildVadReplayScenarios(corpusCases) {
  if (!Array.isArray(corpusCases) || corpusCases.length < 2) {
    throw new Error('at least two corpus cases are required');
  }
  const leading = silencePcm(320);
  const trailing = silencePcm(900);
  const scenarios = corpusCases.map((item) => ({
    id: `clean-${item.id}`,
    group: 'clean-speech',
    description: `Corpus speech ${item.id} framed as Atom PCM16`,
    pcm: Buffer.concat([leading, item.pcm, trailing]),
    encoding: 'pcm16',
    expectedTurns: 1,
    required: true
  }));
  const first = trimPcmSilence(corpusCases[0].pcm);
  const second = trimPcmSilence(corpusCases[1].pcm);
  scenarios.push(
    {
      id: 'silence-only',
      group: 'negative',
      description: 'Two seconds of digital silence',
      pcm: silencePcm(2000),
      encoding: 'pcm16',
      expectedTurns: 0,
      required: true
    },
    {
      id: 'short-tone-burst',
      group: 'negative',
      description: 'A 256 ms high-energy burst below minSpeechMs',
      pcm: Buffer.concat([
        sinePcm({ durationMs: 256, amplitude: 7000 }),
        trailing
      ]),
      encoding: 'pcm16',
      expectedTurns: 0,
      required: true
    },
    {
      id: 'pause-within-turn',
      group: 'pause',
      description: 'Two speech segments separated by 400 ms',
      pcm: Buffer.concat([first, silencePcm(400), second, trailing]),
      encoding: 'pcm16',
      expectedTurns: 1,
      required: true
    },
    {
      id: 'pause-between-turns',
      group: 'pause',
      description: 'Two speech segments separated by 1000 ms',
      pcm: Buffer.concat([first, silencePcm(1000), second, trailing]),
      encoding: 'pcm16',
      expectedTurns: 2,
      required: true
    },
    {
      id: 'clean-adpcm',
      group: 'codec',
      description: 'Corpus speech framed with firmware-compatible IMA ADPCM',
      pcm: Buffer.concat([leading, corpusCases[0].pcm, trailing]),
      encoding: 'ima_adpcm',
      expectedTurns: 1,
      required: true
    },
    {
      id: 'tts-reset-stale-echo',
      group: 'self-echo-guard',
      description: 'Pre-TTS partial audio is reset, stale echo frames are rejected, and only the next generation is accepted',
      pcm: Buffer.concat([first, first, second, trailing]),
      encoding: 'pcm16',
      timeline: [
        { pcm: first, generation: 1 },
        {
          reset: {
            generation: 2,
            reason: 'device-free-tts-dispatch'
          }
        },
        { pcm: first, generation: 1 },
        {
          pcm: Buffer.concat([second, trailing]),
          generation: 2
        }
      ],
      expectedTurns: 1,
      required: true
    },
    {
      id: 'loud-broadband-noise',
      group: 'diagnostic-noise',
      description: 'High-RMS deterministic broadband noise',
      pcm: Buffer.concat([
        deterministicNoisePcm({ durationMs: 2000 }),
        trailing
      ]),
      encoding: 'pcm16',
      expectedTurns: 0,
      required: false
    },
    {
      id: 'steady-tone',
      group: 'diagnostic-noise',
      description: 'One second steady 440 Hz tone',
      pcm: Buffer.concat([
        sinePcm({ durationMs: 1000, amplitude: 6000 }),
        trailing
      ]),
      encoding: 'pcm16',
      expectedTurns: 0,
      required: false
    }
  );
  return scenarios;
}

function pcmFrames(pcm, frameSamples) {
  const frameBytes = frameSamples * 2;
  const frames = [];
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    const source = pcm.subarray(offset, Math.min(pcm.length, offset + frameBytes));
    if (source.length === frameBytes) {
      frames.push(Buffer.from(source));
    } else {
      const padded = Buffer.alloc(frameBytes);
      source.copy(padded);
      frames.push(padded);
    }
  }
  return frames;
}

function instrumentVadBackend(backend) {
  const metrics = {
    decisions: 0,
    speechFrames: 0,
    confidence: [],
    totalDecisionMs: 0,
    inFlight: 0,
    maxInFlight: 0
  };
  const record = (decision, startedAt) => {
    metrics.decisions += 1;
    if (decision?.isSpeech) {
      metrics.speechFrames += 1;
    }
    if (Number.isFinite(decision?.confidence)) {
      metrics.confidence.push(Number(decision.confidence));
    }
    metrics.totalDecisionMs += performance.now() - startedAt;
    return decision;
  };
  return {
    metrics,
    backend: {
      name: backend.name,
      synchronous: backend.synchronous,
      decide(frame, sampleRate, context) {
        const startedAt = performance.now();
        metrics.inFlight += 1;
        metrics.maxInFlight = Math.max(metrics.maxInFlight, metrics.inFlight);
        try {
          const result = backend.decide(frame, sampleRate, context);
          if (result && typeof result.then === 'function') {
            return result
              .then((decision) => record(decision, startedAt))
              .finally(() => {
                metrics.inFlight -= 1;
              });
          }
          const decision = record(result, startedAt);
          metrics.inFlight -= 1;
          return decision;
        } catch (error) {
          metrics.inFlight -= 1;
          throw error;
        }
      }
    }
  };
}

export async function replayVadScenario({
  scenario,
  backend,
  backendName,
  frameSamples = 1024,
  preRollMs = 256,
  endSilenceMs = 700,
  minSpeechMs = 350,
  maxUtteranceMs = 12_000
}) {
  const captured = [];
  let clockMs = 0;
  const instrumented = instrumentVadBackend(backend);
  const bridge = createAtomAudioVadBridge({
    vadBackend: instrumented.backend,
    preRollMs,
    endSilenceMs,
    minSpeechMs,
    maxUtteranceMs,
    now: () => clockMs,
    onUtterance(utterance) {
      const decoded = decodePcm16MonoWav(utterance.wav);
      captured.push({
        bytes: utterance.wav.length,
        durationMs: decoded.durationMs,
        speechMs: utterance.speechMs,
        utteranceMs: utterance.utteranceMs,
        generation: utterance.generation
      });
      return { handled: true };
    }
  });
  const sessionId = `replay:${backendName}:${scenario.id}`;
  const timeline = Array.isArray(scenario.timeline)
    ? scenario.timeline
    : [{ pcm: scenario.pcm, generation: 1 }];
  const frameMs = Math.round((frameSamples / 16_000) * 1000);
  const startedAt = performance.now();
  let frameCount = 0;
  let acceptedFrames = 0;
  let rejectedFrames = 0;
  const rejectionReasons = {};
  for (const event of timeline) {
    if (event.reset) {
      bridge.resetSession(sessionId, event.reset);
      continue;
    }
    const frames = pcmFrames(event.pcm, frameSamples);
    for (const frame of frames) {
      frameCount += 1;
      const encoded = scenario.encoding === 'ima_adpcm'
        ? imaAdpcmEncode(frame)
        : frame;
      const directive = bridge.handlePayload({
        v: 1,
        type: 'atom_audio_frame',
        session_id: sessionId,
        device_id: 'device-free-replay',
        language: 'en',
        sample_rate: 16_000,
        sample_count: frameSamples,
        encoding: scenario.encoding,
        generation: event.generation,
        seq: frameCount,
        audio_base64: encoded.toString('base64')
      });
      if (directive?.accepted === true) {
        acceptedFrames += 1;
      } else {
        rejectedFrames += 1;
        const reason = directive?.reason ?? 'unknown';
        rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
      }
      await bridge.drain();
      clockMs += frameMs;
    }
  }
  bridge.checkUtteranceTimeouts(clockMs + endSilenceMs + 1);
  await bridge.drain();
  const wallMs = performance.now() - startedAt;
  const confidences = instrumented.metrics.confidence;
  return {
    id: scenario.id,
    group: scenario.group,
    description: scenario.description,
    encoding: scenario.encoding,
    required: scenario.required,
    expectedTurns: scenario.expectedTurns,
    observedTurns: captured.length,
    passed: captured.length === scenario.expectedTurns,
    inputDurationMs: pcmDurationMs(scenario.pcm),
    replayWallMs: Number(wallMs.toFixed(2)),
    frames: frameCount,
    acceptedFrames,
    rejectedFrames,
    rejectionReasons,
    decisions: instrumented.metrics.decisions,
    speechFrames: instrumented.metrics.speechFrames,
    maxConcurrentDecisions: instrumented.metrics.maxInFlight,
    meanDecisionMs: instrumented.metrics.decisions > 0
      ? Number(
          (
            instrumented.metrics.totalDecisionMs
            / instrumented.metrics.decisions
          ).toFixed(3)
        )
      : 0,
    confidence: confidences.length > 0
      ? {
          min: Number(Math.min(...confidences).toFixed(4)),
          max: Number(Math.max(...confidences).toFixed(4)),
          mean: Number(
            (
              confidences.reduce((sum, value) => sum + value, 0)
              / confidences.length
            ).toFixed(4)
          )
        }
      : null,
    turns: captured
  };
}

function summarizeBackend(cases) {
  const required = cases.filter((item) => item.required);
  const clean = cases.filter((item) => item.group === 'clean-speech');
  const diagnostics = cases.filter((item) => !item.required);
  return {
    requiredPassed: required.filter((item) => item.passed).length,
    requiredTotal: required.length,
    cleanSpeechPassed: clean.filter((item) => item.passed).length,
    cleanSpeechTotal: clean.length,
    diagnosticNoiseRejected: diagnostics.filter(
      (item) => item.observedTurns === 0
    ).length,
    diagnosticNoiseTotal: diagnostics.length,
    serialized: cases.every((item) => item.maxConcurrentDecisions <= 1),
    passed: required.every((item) => item.passed)
  };
}

async function run(options) {
  const corpus = await loadCorpus(options.manifest);
  const scenarios = buildVadReplayScenarios(corpus.cases);
  if (options.dryRun) {
    console.log(
      `[atom-vad-replay] dry-run corpus=${corpus.manifest.corpusId} `
      + `cases=${scenarios.length} backends=${options.backends.join(',')}`
    );
    for (const scenario of scenarios) {
      console.log(
        `[atom-vad-replay] case=${scenario.id} group=${scenario.group} `
        + `expected_turns=${scenario.expectedTurns} required=${scenario.required}`
      );
    }
    return null;
  }

  const backendResults = {};
  for (const backendName of options.backends) {
    const backend = backendName === 'rms'
      ? createRmsVadBackend({ thresholdRms: options.rmsThreshold })
      : createSileroVadBackend({
          baseUrl: options.sileroBaseUrl,
          threshold: options.sileroThreshold
        });
    const cases = [];
    for (const scenario of scenarios) {
      const result = await replayVadScenario({
        scenario,
        backend,
        backendName,
        frameSamples: options.frameSamples,
        preRollMs: options.preRollMs,
        endSilenceMs: options.endSilenceMs,
        minSpeechMs: options.minSpeechMs,
        maxUtteranceMs: options.maxUtteranceMs
      });
      cases.push(result);
      console.log(
        `[atom-vad-replay] backend=${backendName} case=${result.id} `
        + `turns=${result.observedTurns}/${result.expectedTurns} `
        + `required=${result.required} pass=${result.passed} `
        + `wall_ms=${result.replayWallMs}`
      );
    }
    backendResults[backendName] = {
      summary: summarizeBackend(cases),
      cases
    };
  }

  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    deviceFree: true,
    atomHardwareUsed: false,
    firmwareChanged: false,
    corpus: {
      manifest: path.relative(repoRoot, options.manifest),
      manifestSha256: corpus.manifestSha256,
      corpusId: corpus.manifest.corpusId,
      cases: corpus.cases.map((item) => ({
        id: item.id,
        file: item.file,
        sha256: item.sha256,
        durationMs: item.durationMs
      }))
    },
    settings: {
      frameSamples: options.frameSamples,
      frameMs: Number(((options.frameSamples / 16_000) * 1000).toFixed(3)),
      preRollMs: options.preRollMs,
      endSilenceMs: options.endSilenceMs,
      minSpeechMs: options.minSpeechMs,
      maxUtteranceMs: options.maxUtteranceMs,
      rmsThreshold: options.rmsThreshold,
      sileroThreshold: options.sileroThreshold
    },
    acceptance: {
      backend: options.backends.includes('silero')
        ? 'silero'
        : options.backends[0],
      rationale: options.backends.includes('silero')
        ? 'The interpreter defaults to Silero; RMS remains a comparison baseline.'
        : 'Only one backend was requested.'
    },
    backends: backendResults,
    limitations: [
      'Synthetic Supertonic speech and generated noise do not replace human, room, or Atom microphone recordings.',
      'TTS playback suspension, hardware cooldown, touch gestures, and phone/Atom endpoint routing still require the physical Atom.'
    ]
  };
  report.acceptance.passed =
    backendResults[report.acceptance.backend].summary.passed;
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[atom-vad-replay] report=${options.output}`);
  for (const [name, result] of Object.entries(backendResults)) {
    if (name !== report.acceptance.backend && !result.summary.passed) {
      console.warn(
        `[atom-vad-replay] comparison backend=${name} did not meet all `
        + 'required cases; see report'
      );
    }
  }
  if (!report.acceptance.passed) {
    process.exitCode = 1;
  }
  return report;
}

function usage() {
  return `Usage: node scripts/atom-vad-replay.mjs [options]

Replay a pinned 16 kHz corpus as firmware-shaped Atom audio frames through
the real bridge segmentation logic. This never connects to or configures Atom.

Options:
  --manifest PATH          corpus manifest
  --output PATH            JSON report path
  --backends LIST          rms, silero, or rms,silero
  --silero-base-url URL    worker URL (default http://127.0.0.1:18094)
  --frame-samples N        samples per Atom frame (default 1024)
  --pre-roll-ms N          inactive audio retained before onset (default 256)
  --end-silence-ms N       silence required to end a turn (default 700)
  --min-speech-ms N        speech required to accept a turn (default 350)
  --max-utterance-ms N     hard turn cap (default 12000)
  --rms-threshold N        RMS threshold (default 0.025)
  --silero-threshold N     Silero probability threshold (default 0.5)
  --dry-run                validate and list cases without inference
  -h, --help               show this help
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
    } else {
      await run(options);
    }
  } catch (error) {
    console.error(`[atom-vad-replay] ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
