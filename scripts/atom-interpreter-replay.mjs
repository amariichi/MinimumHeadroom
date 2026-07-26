#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import {
  decodePcm16MonoWav,
  silencePcm
} from './atom-vad-replay.mjs';
import { atomInterpreterSessionId } from '../face-app/dist/interpreter_runtime_config.js';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const repoRoot = path.resolve(currentDir, '..');
const defaultOutput = path.join(
  repoRoot,
  '.local/state/interpreter/atom-interpreter-replay.json'
);
const relevantEventTypes = new Set([
  'interpreter_turn_started',
  'interpreter_transcript',
  'interpreter_translation',
  'interpreter_state_changed',
  'interpreter_turn_failed'
]);

function nonEmptyString(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized === '') {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    wsUrl: 'ws://127.0.0.1:18766/ws',
    fixture: '',
    output: defaultOutput,
    expectedSource: '',
    expectedTarget: '',
    sessionId: 'atom-interpreter-replay',
    deviceId: 'device-free-atom-replay',
    frameSamples: 1024,
    leadingSilenceMs: 320,
    trailingSilenceMs: 960,
    timeoutMs: 180_000,
    settleMs: 750,
    generation: 1,
    dryRun: false,
    help: false
  };
  const valueOptions = new Map([
    ['--ws-url', 'wsUrl'],
    ['--fixture', 'fixture'],
    ['--output', 'output'],
    ['--expect-source', 'expectedSource'],
    ['--expect-target', 'expectedTarget'],
    ['--session-id', 'sessionId'],
    ['--device-id', 'deviceId'],
    ['--frame-samples', 'frameSamples'],
    ['--leading-silence-ms', 'leadingSilenceMs'],
    ['--trailing-silence-ms', 'trailingSilenceMs'],
    ['--timeout-ms', 'timeoutMs'],
    ['--settle-ms', 'settleMs'],
    ['--generation', 'generation']
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
  if (options.help) {
    return options;
  }
  options.wsUrl = nonEmptyString(options.wsUrl, '--ws-url');
  const parsedUrl = new URL(options.wsUrl);
  if (!['ws:', 'wss:'].includes(parsedUrl.protocol)) {
    throw new Error('--ws-url must use ws:// or wss://');
  }
  options.fixture = path.resolve(
    nonEmptyString(options.fixture, '--fixture')
  );
  options.output = path.resolve(nonEmptyString(options.output, '--output'));
  options.expectedSource = nonEmptyString(
    options.expectedSource,
    '--expect-source'
  ).toLowerCase();
  options.expectedTarget = nonEmptyString(
    options.expectedTarget,
    '--expect-target'
  ).toLowerCase();
  if (options.expectedSource === options.expectedTarget) {
    throw new Error('source and target must differ');
  }
  options.sessionId = nonEmptyString(options.sessionId, '--session-id');
  options.deviceId = nonEmptyString(options.deviceId, '--device-id');
  options.frameSamples = positiveInteger(
    options.frameSamples,
    '--frame-samples'
  );
  options.leadingSilenceMs = nonNegativeInteger(
    options.leadingSilenceMs,
    '--leading-silence-ms'
  );
  options.trailingSilenceMs = positiveInteger(
    options.trailingSilenceMs,
    '--trailing-silence-ms'
  );
  options.timeoutMs = positiveInteger(options.timeoutMs, '--timeout-ms');
  options.settleMs = nonNegativeInteger(options.settleMs, '--settle-ms');
  options.generation = positiveInteger(options.generation, '--generation');
  return options;
}

export function pcmFrames(pcm, frameSamples = 1024) {
  if (!Number.isInteger(frameSamples) || frameSamples <= 0) {
    throw new Error('frameSamples must be a positive integer');
  }
  const source = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm ?? []);
  const frameBytes = frameSamples * 2;
  const frames = [];
  for (let offset = 0; offset < source.length; offset += frameBytes) {
    const slice = source.subarray(
      offset,
      Math.min(source.length, offset + frameBytes)
    );
    const frame = Buffer.alloc(frameBytes);
    slice.copy(frame);
    frames.push(frame);
  }
  return frames;
}

async function messageDataToText(data) {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(
      data.buffer,
      data.byteOffset,
      data.byteLength
    ).toString('utf8');
  }
  if (data && typeof data.text === 'function') {
    return data.text();
  }
  return String(data ?? '');
}

export function validateInterpreterEvents({
  events,
  expectedSessionId,
  expectedSource,
  expectedTarget
}) {
  const selected = events.filter(
    (event) => event?.sessionId === expectedSessionId
  );
  const started = selected.filter(
    (event) => event.type === 'interpreter_turn_started'
  );
  const transcripts = selected.filter(
    (event) => event.type === 'interpreter_transcript'
  );
  const translations = selected.filter(
    (event) => event.type === 'interpreter_translation'
  );
  const failures = selected.filter(
    (event) => event.type === 'interpreter_turn_failed'
  );
  if (failures.length > 0) {
    const failure = failures[0];
    throw new Error(
      `interpreter turn failed at ${failure.stage ?? 'unknown'}: `
      + `${failure.error ?? 'unknown'}`
    );
  }
  if (started.length !== 1) {
    throw new Error(`expected one started turn, observed ${started.length}`);
  }
  if (transcripts.length !== 1) {
    throw new Error(`expected one transcript, observed ${transcripts.length}`);
  }
  if (translations.length !== 1) {
    throw new Error(
      `expected one translation, observed ${translations.length}`
    );
  }
  const transcript = transcripts[0];
  const translation = translations[0];
  if (
    started[0].turnId !== transcript.turnId
    || transcript.turnId !== translation.turnId
  ) {
    throw new Error('interpreter event turn IDs do not match');
  }
  if (
    typeof transcript.transcript !== 'string'
    || transcript.transcript.trim() === ''
  ) {
    throw new Error('transcript is empty');
  }
  if (transcript.sourceLanguage !== expectedSource) {
    throw new Error(
      `source mismatch: ${transcript.sourceLanguage} != ${expectedSource}`
    );
  }
  if (translation.sourceLanguage !== expectedSource) {
    throw new Error(
      `translation source mismatch: `
      + `${translation.sourceLanguage} != ${expectedSource}`
    );
  }
  if (translation.targetLanguage !== expectedTarget) {
    throw new Error(
      `target mismatch: ${translation.targetLanguage} != ${expectedTarget}`
    );
  }
  if (
    typeof translation.translation !== 'string'
    || translation.translation.trim() === ''
  ) {
    throw new Error('translation is empty');
  }
  if (started[0].audioEndpoint !== 'atom') {
    throw new Error(
      `started audio endpoint is ${started[0].audioEndpoint}, expected atom`
    );
  }
  if (translation.audioEndpoint !== 'atom') {
    throw new Error(
      `translation audio endpoint is ${translation.audioEndpoint}, expected atom`
    );
  }
  return {
    turnId: translation.turnId,
    transcript: transcript.transcript,
    translation: translation.translation,
    sourceLanguage: translation.sourceLanguage,
    targetLanguage: translation.targetLanguage,
    audioEndpoint: translation.audioEndpoint,
    eventCounts: {
      started: started.length,
      transcripts: transcripts.length,
      translations: translations.length,
      stateChanges: selected.filter(
        (event) => event.type === 'interpreter_state_changed'
      ).length,
      failures: failures.length
    }
  };
}

async function replayFrames(options, frames) {
  if (typeof WebSocket !== 'function') {
    throw new Error('Node.js global WebSocket is unavailable; use Node 22+');
  }
  const expectedSessionId = atomInterpreterSessionId(options.sessionId);
  const events = [];
  let sentFrames = 0;
  let openedAt = null;
  let sentAt = null;
  let completed = false;
  let timeout = null;
  let settleTimer = null;
  const startedAt = performance.now();
  const socket = new WebSocket(options.wsUrl, 'arduino');

  try {
    await new Promise((resolve, reject) => {
      const fail = (error) => {
        if (completed) {
          return;
        }
        completed = true;
        clearTimeout(timeout);
        clearTimeout(settleTimer);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const finish = () => {
        if (completed) {
          return;
        }
        completed = true;
        clearTimeout(timeout);
        clearTimeout(settleTimer);
        resolve();
      };
      timeout = setTimeout(() => {
        fail(
          new Error(
            `timed out after ${options.timeoutMs} ms waiting for translation`
          )
        );
      }, options.timeoutMs);

      socket.addEventListener('open', () => {
        openedAt = performance.now();
        for (let index = 0; index < frames.length; index += 1) {
          socket.send(JSON.stringify({
            v: 1,
            type: 'atom_audio_frame',
            session_id: options.sessionId,
            device_id: options.deviceId,
            language: 'en',
            sample_rate: 16_000,
            sample_count: options.frameSamples,
            encoding: 'pcm16',
            generation: options.generation,
            seq: index + 1,
            audio_base64: frames[index].toString('base64'),
            ts: Date.now()
          }));
          sentFrames += 1;
        }
        sentAt = performance.now();
      });

      socket.addEventListener('message', (message) => {
        void (async () => {
          let payload;
          try {
            payload = JSON.parse(await messageDataToText(message.data));
          } catch {
            return;
          }
          if (
            !relevantEventTypes.has(payload?.type)
            || payload?.sessionId !== expectedSessionId
          ) {
            return;
          }
          events.push(payload);
          if (payload.type === 'interpreter_turn_failed') {
            fail(
              new Error(
                `interpreter turn failed at ${payload.stage ?? 'unknown'}: `
                + `${payload.error ?? 'unknown'}`
              )
            );
            return;
          }
          if (payload.type === 'interpreter_translation') {
            clearTimeout(settleTimer);
            settleTimer = setTimeout(finish, options.settleMs);
          }
        })().catch(fail);
      });

      socket.addEventListener('error', (event) => {
        fail(new Error(event?.message ?? 'WebSocket error'));
      });
      socket.addEventListener('close', () => {
        if (!completed) {
          fail(new Error('WebSocket closed before translation completed'));
        }
      });
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(settleTimer);
    completed = true;
    try {
      socket.close();
    } catch {
      // The socket may already be closed after a connection failure.
    }
  }

  return {
    expectedSessionId,
    events,
    sentFrames,
    timing: {
      connectMs: openedAt === null
        ? null
        : Number((openedAt - startedAt).toFixed(2)),
      sendMs: openedAt === null || sentAt === null
        ? null
        : Number((sentAt - openedAt).toFixed(2)),
      totalMs: Number((performance.now() - startedAt).toFixed(2))
    }
  };
}

async function run(options) {
  if (options.dryRun) {
    console.log(
      `[atom-interpreter-replay] dry-run ws=${options.wsUrl} `
      + `fixture=${options.fixture}`
    );
    console.log(
      `[atom-interpreter-replay] expected=${options.expectedSource}`
      + `->${options.expectedTarget} frame_samples=${options.frameSamples}`
    );
    console.log(
      '[atom-interpreter-replay] device_free=true atom_hardware_used=false'
    );
    return null;
  }

  const wav = await readFile(options.fixture);
  const decoded = decodePcm16MonoWav(wav);
  const pcm = Buffer.concat([
    silencePcm(options.leadingSilenceMs),
    decoded.pcm,
    silencePcm(options.trailingSilenceMs)
  ]);
  const frames = pcmFrames(pcm, options.frameSamples);
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    deviceFree: true,
    atomHardwareUsed: false,
    firmwareChanged: false,
    wsUrl: options.wsUrl,
    fixture: path.relative(repoRoot, options.fixture),
    sessionId: options.sessionId,
    expectedSessionId: atomInterpreterSessionId(options.sessionId),
    expected: {
      sourceLanguage: options.expectedSource,
      targetLanguage: options.expectedTarget,
      turns: 1,
      audioEndpoint: 'atom'
    },
    audio: {
      sampleRate: decoded.sampleRate,
      fixtureDurationMs: decoded.durationMs,
      leadingSilenceMs: options.leadingSilenceMs,
      trailingSilenceMs: options.trailingSilenceMs,
      frameSamples: options.frameSamples,
      frames: frames.length
    },
    status: 'failed',
    result: null,
    events: [],
    timing: null
  };

  try {
    const replay = await replayFrames(options, frames);
    report.events = replay.events;
    report.timing = replay.timing;
    report.audio.sentFrames = replay.sentFrames;
    report.result = validateInterpreterEvents({
      events: replay.events,
      expectedSessionId: replay.expectedSessionId,
      expectedSource: options.expectedSource,
      expectedTarget: options.expectedTarget
    });
    report.status = 'passed';
  } catch (error) {
    report.error = error?.message ?? String(error);
    throw Object.assign(error, { replayReport: report });
  } finally {
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(
    `[atom-interpreter-replay] turn=${report.result.turnId} `
    + `${report.result.sourceLanguage}->${report.result.targetLanguage} `
    + `endpoint=${report.result.audioEndpoint} frames=${report.audio.sentFrames}`
  );
  console.log(`[atom-interpreter-replay] report=${options.output}`);
  return report;
}

function usage() {
  return `Usage: node scripts/atom-interpreter-replay.mjs [options]

Replay one 16 kHz mono PCM16 WAV as firmware-shaped Atom frames through a
running interpreter WebSocket. The script never connects to Atom hardware.

Required:
  --fixture PATH          16 kHz, mono, PCM16 WAV
  --expect-source CODE    expected detected source language
  --expect-target CODE    expected translated target language

Options:
  --ws-url URL            interpreter WebSocket (default ws://127.0.0.1:18766/ws)
  --output PATH           JSON report path
  --session-id ID         raw Atom capture session ID
  --device-id ID          simulated Atom device ID
  --frame-samples N       samples per frame (default 1024)
  --leading-silence-ms N  silence before fixture (default 320)
  --trailing-silence-ms N silence after fixture (default 960)
  --timeout-ms N          translation timeout (default 180000)
  --settle-ms N           duplicate-event observation window (default 750)
  --generation N          Atom capture generation (default 1)
  --dry-run               print the replay plan without connecting
  -h, --help              show this help
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
    const suffix = error?.replayReport?.error
      ? `; report_error=${error.replayReport.error}`
      : '';
    console.error(
      `[atom-interpreter-replay] ${error?.message ?? error}${suffix}`
    );
    process.exitCode = 1;
  }
}
