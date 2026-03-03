#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

import { shouldAcceptOperatorBatchFallbackResult } from '../face-app/public/operator_asr_text.js';
import { classifyRealtimePrimaryOutcome, defaultLoopSpeakers, evaluateLoopCase, parseLoopSpeakers } from './tts-asr-loop-lib.mjs';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const repoRoot = path.resolve(currentDir, '..');
const defaultFixturesPath = path.resolve(repoRoot, 'test/tts-asr-loop/cases.json');
const defaultReportPath = path.resolve(repoRoot, 'test/tts-asr-loop/latest-realtime-report.md');
const defaultTtsScriptPath = path.resolve(repoRoot, 'scripts/run-tts-worker.sh');
const defaultAsrBaseUrl = 'http://127.0.0.1:8091';
const defaultFaceWsUrl = 'ws://127.0.0.1:8765/ws';
const defaultTtsSource = 'face';
const defaultWorkerSpeed = 1.0;
const realtimeSampleRateHz = 16_000;
const realtimeChunkBytes = 8_192;
const ttsReadyTimeoutMs = 10_000;
const ttsSpeakTimeoutMs = 120_000;
const ttsShutdownTimeoutMs = 2_000;
const realtimeResponseTimeoutMs = 30_000;
const batchAsrTimeoutMs = 30_000;

function parseArgs(argv) {
  const options = {
    fixturesPath: defaultFixturesPath,
    reportPath: defaultReportPath,
    ttsScriptPath: defaultTtsScriptPath,
    asrBaseUrl: defaultAsrBaseUrl,
    faceWsUrl: defaultFaceWsUrl,
    speakers: [...defaultLoopSpeakers],
    caseId: null,
    tier: null,
    ttsSource: defaultTtsSource,
    workerSpeed: defaultWorkerSpeed,
    repeats: 1
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--fixtures' && argv[index + 1]) {
      options.fixturesPath = path.resolve(repoRoot, argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === '--report' && argv[index + 1]) {
      options.reportPath = path.resolve(repoRoot, argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === '--tts-script' && argv[index + 1]) {
      options.ttsScriptPath = path.resolve(repoRoot, argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === '--asr-base-url' && argv[index + 1]) {
      options.asrBaseUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === '--face-ws-url' && argv[index + 1]) {
      options.faceWsUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if ((value === '--voices' || value === '--speakers') && argv[index + 1]) {
      options.speakers = parseLoopSpeakers(argv[index + 1], options.speakers);
      index += 1;
      continue;
    }
    if ((value === '--case' || value === '--only') && argv[index + 1]) {
      options.caseId = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === '--tier' && argv[index + 1]) {
      const candidate = argv[index + 1].trim().toLowerCase();
      if (candidate !== 'stable' && candidate !== 'fragile') {
        throw new Error(`Unsupported --tier: ${argv[index + 1]} (expected stable|fragile)`);
      }
      options.tier = candidate;
      index += 1;
      continue;
    }
    if (value === '--repeats' && argv[index + 1]) {
      const repeats = Number.parseInt(argv[index + 1], 10);
      if (!Number.isFinite(repeats) || repeats < 1) {
        throw new Error(`Unsupported --repeats: ${argv[index + 1]} (expected integer >= 1)`);
      }
      options.repeats = repeats;
      index += 1;
      continue;
    }
    if (value === '--tts-source' && argv[index + 1]) {
      const candidate = argv[index + 1].trim().toLowerCase();
      if (candidate !== 'face' && candidate !== 'worker') {
        throw new Error(`Unsupported --tts-source: ${argv[index + 1]} (expected face|worker)`);
      }
      options.ttsSource = candidate;
      index += 1;
      continue;
    }
    if (value === '--worker-speed' && argv[index + 1]) {
      const speed = Number.parseFloat(argv[index + 1]);
      if (!Number.isFinite(speed) || speed <= 0.5 || speed > 2.0) {
        throw new Error(`Unsupported --worker-speed: ${argv[index + 1]} (expected float > 0.5 and <= 2.0)`);
      }
      options.workerSpeed = speed;
      index += 1;
      continue;
    }
    if (value === '-h' || value === '--help') {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  return options;
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: node scripts/tts-realtime-asr-loop-check.mjs [--fixtures <path>] [--report <path>] [--tts-script <path>] [--face-ws-url <url>] [--asr-base-url <url>] [--voices <list>] [--case <id>] [--tier <stable|fragile>] [--repeats <n>] [--tts-source <face|worker>] [--worker-speed <float>]',
      '',
      'This harness follows the actual operator flow: Voxtral realtime primary via face-app websocket, then Parakeet batch fallback when needed.',
      'Default TTS source is the already-running face-app (`--tts-source face`), which best matches the real runtime.',
      'Use `--tts-source worker` only when you want an isolated standalone Qwen3 worker.',
      'For worker mode, `--worker-speed <float>` overrides `MH_QWEN_TTS_SPEED` (default 1.0).'
    ].join('\n') + '\n'
  );
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([
    promise.finally(() => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }),
    timeoutPromise
  ]);
}

function validateFixture(raw) {
  const id = asNonEmptyString(raw?.id);
  const displayText = asNonEmptyString(raw?.displayText);
  const ttsInput = asNonEmptyString(raw?.ttsInput);
  if (!id || !displayText || !ttsInput) {
    throw new Error(`Invalid fixture entry: ${JSON.stringify(raw)}`);
  }
  return {
    id,
    tier: raw?.tier === 'fragile' ? 'fragile' : 'stable',
    language: raw?.language === 'ja' ? 'ja' : 'en',
    displayText,
    ttsInput,
    allowOptionalHaiPrefix: raw?.allowOptionalHaiPrefix === true,
    allowedOutputs: Array.isArray(raw?.allowedOutputs) ? raw.allowedOutputs.filter((entry) => typeof entry === 'string') : [],
    notes: typeof raw?.notes === 'string' ? raw.notes.trim() : ''
  };
}

async function loadFixtures(fixturesPath) {
  const raw = await readFile(fixturesPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Fixture file must contain a JSON array: ${fixturesPath}`);
  }
  return parsed.map(validateFixture);
}

function createTtsSession({ ttsScriptPath, speaker, speed }) {
  const child = spawn(ttsScriptPath, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TTS_ENGINE: 'qwen3',
      MH_AUDIO_TARGET: 'browser',
      MH_QWEN_TTS_SPEED: String(speed),
      MH_QWEN_TTS_SPEAKER: speaker
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let readyPayload = null;
  let readyResolve;
  let readyReject;
  let closed = false;
  let stderr = '';
  let exitResolve;

  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const exitPromise = new Promise((resolve) => {
    exitResolve = resolve;
  });

  function failPending(error) {
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  }

  rl.on('line', (line) => {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return;
    }

    if (payload?.type === 'ready' && readyPayload === null) {
      readyPayload = payload;
      readyResolve(payload);
      return;
    }

    if (payload?.type === 'error' && readyPayload === null) {
      readyReject(new Error(`TTS worker startup failed: ${payload.message ?? 'unknown error'}`));
      return;
    }

    if (payload?.type === 'audio') {
      const utteranceId = asNonEmptyString(payload.utterance_id);
      if (!utteranceId) {
        return;
      }
      const pendingEntry = pending.get(utteranceId);
      if (!pendingEntry) {
        return;
      }
      pending.delete(utteranceId);
      pendingEntry.resolve({
        mimeType: asNonEmptyString(payload.mime_type) ?? 'audio/wav',
        audioBase64: asNonEmptyString(payload.audio_base64) ?? '',
        sampleRate: Number.isFinite(payload.sample_rate) ? Number(payload.sample_rate) : null
      });
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  child.on('error', (error) => {
    if (readyPayload === null) {
      readyReject(error);
      return;
    }
    failPending(error);
  });

  child.on('exit', (code) => {
    closed = true;
    rl.close();
    exitResolve(code);
    const detail = stderr.trim();
    const message = detail === '' ? `TTS worker exited with code ${code}` : `TTS worker exited with code ${code}: ${detail}`;
    const error = new Error(message);
    if (readyPayload === null) {
      readyReject(error);
      return;
    }
    if (pending.size > 0) {
      failPending(error);
    }
  });

  return {
    ready,
    async speak(text) {
      const utteranceId = randomUUID();
      await ready;
      if (closed) {
        throw new Error('TTS worker is already closed');
      }

      return await withTimeout(
        new Promise((resolve, reject) => {
          pending.set(utteranceId, { resolve, reject });
          const command = {
            op: 'speak',
            id: utteranceId,
            generation: pending.size,
            session_id: 'tts-realtime-loop',
            utterance_id: utteranceId,
            text,
            ts: Date.now(),
            ttl_ms: 20_000,
            message_id: utteranceId,
            revision: Date.now()
          };
          child.stdin.write(`${JSON.stringify(command)}\n`);
        }),
        ttsSpeakTimeoutMs,
        `Timed out waiting for TTS audio after ${ttsSpeakTimeoutMs}ms`
      ).finally(() => {
        pending.delete(utteranceId);
      });
    },
    async close() {
      if (closed) {
        return;
      }
      try {
        child.stdin.write(`${JSON.stringify({ op: 'shutdown', id: 'shutdown' })}\n`);
      } catch {
        child.kill('SIGKILL');
        await exitPromise;
        return;
      }

      try {
        await withTimeout(
          exitPromise,
          ttsShutdownTimeoutMs,
          `Timed out waiting for TTS shutdown after ${ttsShutdownTimeoutMs}ms`
        );
      } catch {
        child.kill('SIGKILL');
        await exitPromise;
      }
    },
    getReadyPayload() {
      return readyPayload;
    }
  };
}

function decodeWavBase64(audioBase64) {
  const wavBytes = Buffer.from(audioBase64, 'base64');
  if (wavBytes.length < 44 || wavBytes.toString('ascii', 0, 4) !== 'RIFF' || wavBytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('unsupported WAV payload from TTS worker');
  }

  let offset = 12;
  let sampleRate = null;
  let channels = null;
  let bitsPerSample = null;
  let dataOffset = null;
  let dataLength = null;

  while (offset + 8 <= wavBytes.length) {
    const chunkId = wavBytes.toString('ascii', offset, offset + 4);
    const chunkSize = wavBytes.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      const formatCode = wavBytes.readUInt16LE(chunkDataOffset);
      channels = wavBytes.readUInt16LE(chunkDataOffset + 2);
      sampleRate = wavBytes.readUInt32LE(chunkDataOffset + 4);
      bitsPerSample = wavBytes.readUInt16LE(chunkDataOffset + 14);
      if (formatCode !== 1) {
        throw new Error(`unsupported WAV format code: ${formatCode}`);
      }
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataLength = chunkSize;
      break;
    }
    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (sampleRate === null || channels !== 1 || bitsPerSample !== 16 || dataOffset === null || dataLength === null) {
    throw new Error('unsupported WAV layout from TTS worker');
  }

  return {
    sampleRate,
    pcmBytes: new Uint8Array(wavBytes.buffer, wavBytes.byteOffset + dataOffset, dataLength)
  };
}

function decodePcm16ToFloat32(pcmBytes) {
  const byteOffset = pcmBytes.byteOffset ?? 0;
  const byteLength = pcmBytes.byteLength ?? pcmBytes.length;
  const dataView = new DataView(pcmBytes.buffer, byteOffset, byteLength);
  const sampleCount = Math.floor(byteLength / 2);
  const output = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = dataView.getInt16(index * 2, true);
    output[index] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  return output;
}

function resampleMonoAudio(input, sourceRate, targetRate) {
  if (!Number.isFinite(sourceRate) || !Number.isFinite(targetRate) || sourceRate <= 0 || targetRate <= 0) {
    return input;
  }
  if (sourceRate === targetRate || input.length === 0) {
    return input;
  }

  const outputLength = Math.max(1, Math.round((input.length * targetRate) / sourceRate));
  const output = new Float32Array(outputLength);
  const rateRatio = sourceRate / targetRate;
  let sourceIndex = 0;

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const nextSourceIndex = Math.min(input.length, Math.round((outputIndex + 1) * rateRatio));
    let sum = 0;
    let count = 0;
    for (let cursor = sourceIndex; cursor < nextSourceIndex; cursor += 1) {
      sum += input[cursor];
      count += 1;
    }
    output[outputIndex] = count > 0 ? sum / count : input[Math.min(sourceIndex, input.length - 1)];
    sourceIndex = nextSourceIndex;
  }
  return output;
}

function encodeMonoPcm16Bytes(samples) {
  const pcmBytes = new Uint8Array(samples.length * 2);
  const view = new DataView(pcmBytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    const scaled = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(index * 2, Math.round(scaled), true);
  }
  return pcmBytes;
}

function convertTtsAudioToRealtimePcm(audioBase64, targetRate) {
  const decoded = decodeWavBase64(audioBase64);
  const floatSamples = decodePcm16ToFloat32(decoded.pcmBytes);
  const resampled = resampleMonoAudio(floatSamples, decoded.sampleRate, targetRate);
  return encodeMonoPcm16Bytes(resampled);
}

function encodeBytesToBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function splitRealtimeChunks(pcmBytes) {
  const chunks = [];
  for (let offset = 0; offset < pcmBytes.length; offset += realtimeChunkBytes) {
    chunks.push(pcmBytes.subarray(offset, Math.min(pcmBytes.length, offset + realtimeChunkBytes)));
  }
  return chunks;
}

function buildWaveBufferFromPcmBytes(pcmBytes, sampleRateHz) {
  const dataLength = pcmBytes.length;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRateHz, 24);
  buffer.writeUInt32LE(sampleRateHz * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataLength, 40);
  Buffer.from(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength).copy(buffer, 44);
  return buffer;
}

async function normalizeIncomingWsText(data) {
  if (typeof data === 'string') {
    return data;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (data && typeof data === 'object' && typeof data.text === 'function') {
    return await data.text();
  }
  if (data == null) {
    return '';
  }
  return String(data);
}

async function runRealtimePrimary({ faceWsUrl, language, pcmBytes }) {
  if (typeof WebSocket !== 'function') {
    throw new Error('WebSocket API is unavailable in this Node runtime');
  }

  const sessionId = `tts-loop#${randomUUID()}`;
  const generation = 1;
  const chunks = splitRealtimeChunks(pcmBytes);

  return await withTimeout(
    new Promise((resolve, reject) => {
      const socket = new WebSocket(faceWsUrl);
      let resolved = false;
      let accumulatedText = '';

      function finish(result) {
        if (resolved) {
          return;
        }
        resolved = true;
        try {
          socket.close();
        } catch {
          // Ignore close failures.
        }
        resolve(result);
      }

      function fail(error) {
        if (resolved) {
          return;
        }
        resolved = true;
        try {
          socket.close();
        } catch {
          // Ignore close failures.
        }
        reject(error);
      }

      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({
            v: 1,
            type: 'operator_realtime_asr_start',
            session_id: sessionId,
            ts: Date.now(),
            generation,
            language
          })
        );
        for (const chunk of chunks) {
          socket.send(
            JSON.stringify({
              v: 1,
              type: 'operator_realtime_asr_chunk',
              session_id: sessionId,
              ts: Date.now(),
              generation,
              language,
              audio: encodeBytesToBase64(chunk),
              sample_rate_hz: realtimeSampleRateHz
            })
          );
        }
        socket.send(
          JSON.stringify({
            v: 1,
            type: 'operator_realtime_asr_stop',
            session_id: sessionId,
            ts: Date.now(),
            generation,
            language
          })
        );
      });

      socket.addEventListener('message', async (event) => {
        try {
          const payload = JSON.parse(await normalizeIncomingWsText(event.data));
          if (!payload || payload.session_id !== sessionId) {
            return;
          }
          if (Number.isFinite(payload.generation) && Math.floor(payload.generation) !== generation) {
            return;
          }

          if (payload.type === 'operator_realtime_asr_delta') {
            if (typeof payload.text === 'string') {
              accumulatedText = payload.text;
            } else if (typeof payload.delta === 'string') {
              accumulatedText += payload.delta;
            }
            return;
          }

          if (payload.type === 'operator_realtime_asr_done') {
            finish({
              primaryKind: 'done',
              primaryText:
                typeof payload.text === 'string' && payload.text !== '' ? payload.text : accumulatedText,
              primaryError: null
            });
            return;
          }

          if (payload.type === 'operator_realtime_asr_error') {
            finish({
              primaryKind: 'error',
              primaryText: accumulatedText,
              primaryError: typeof payload.error === 'string' ? payload.error : 'realtime_asr_error'
            });
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });

      socket.addEventListener('error', () => {
        fail(new Error('face-app websocket error'));
      });

      socket.addEventListener('close', () => {
        if (!resolved) {
          finish({
            primaryKind: 'error',
            primaryText: accumulatedText,
            primaryError: 'face-app websocket closed'
          });
        }
      });
    }),
    realtimeResponseTimeoutMs,
    `Timed out waiting for realtime ASR after ${realtimeResponseTimeoutMs}ms`
  );
}

async function requestFaceAppTtsAudio({ faceWsUrl, text }) {
  if (typeof WebSocket !== 'function') {
    throw new Error('WebSocket API is unavailable in this Node runtime');
  }

  const sessionId = `tts-audio#${randomUUID()}`;
  const messageId = `tts-audio#${randomUUID()}`;

  return await withTimeout(
    new Promise((resolve, reject) => {
      const socket = new WebSocket(faceWsUrl);
      let resolved = false;

      function finish(result) {
        if (resolved) {
          return;
        }
        resolved = true;
        try {
          socket.close();
        } catch {
          // Ignore close failures.
        }
        resolve(result);
      }

      function fail(error) {
        if (resolved) {
          return;
        }
        resolved = true;
        try {
          socket.close();
        } catch {
          // Ignore close failures.
        }
        reject(error);
      }

      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({
            v: 1,
            type: 'say',
            session_id: sessionId,
            ts: Date.now(),
            text,
            priority: 0,
            policy: 'replace',
            message_id: messageId,
            revision: Date.now()
          })
        );
      });

      socket.addEventListener('message', async (event) => {
        try {
          const payload = JSON.parse(await normalizeIncomingWsText(event.data));
          if (!payload || payload.session_id !== sessionId) {
            return;
          }
          if (payload.type === 'tts_audio' && payload.message_id === messageId) {
            if (typeof payload.audio_base64 !== 'string' || payload.audio_base64.trim() === '') {
              fail(new Error('face-app returned empty tts_audio payload'));
              return;
            }
            finish({
              audioBase64: payload.audio_base64.trim(),
              mimeType: typeof payload.mime_type === 'string' ? payload.mime_type : 'audio/wav',
              sampleRate: Number.isFinite(payload.sample_rate) ? Number(payload.sample_rate) : null
            });
            return;
          }
          if (payload.type === 'say_result' && payload.message_id === messageId) {
            if (payload.accepted === false || payload.spoken === false) {
              fail(new Error(`face-app rejected say request: ${payload.reason ?? 'not_spoken'}`));
            }
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });

      socket.addEventListener('error', () => {
        fail(new Error('face-app websocket error while requesting tts_audio'));
      });

      socket.addEventListener('close', () => {
        if (!resolved) {
          fail(new Error('face-app websocket closed before tts_audio arrived'));
        }
      });
    }),
    ttsSpeakTimeoutMs,
    `Timed out waiting for face-app tts_audio after ${ttsSpeakTimeoutMs}ms`
  );
}

async function transcribeWithBatchAsr({ asrBaseUrl, audioBase64, mimeType, language }) {
  const endpoint = new URL(`/v1/asr/${language === 'ja' ? 'ja' : 'en'}`, asrBaseUrl).toString();
  const controller = new AbortController();
  const abortTimer = setTimeout(() => {
    controller.abort();
  }, batchAsrTimeoutMs);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        audioBase64,
        mimeType
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`ASR request timed out after ${batchAsrTimeoutMs}ms for ${endpoint}`);
    }
    throw error;
  } finally {
    clearTimeout(abortTimer);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload || typeof payload.text !== 'string') {
    throw new Error(`ASR request failed for ${endpoint} (${response.status})`);
  }

  return payload;
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function collectStabilitySummaries(rows) {
  const groups = new Map();
  for (const row of rows) {
    const caseId = typeof row.fixture?.id === 'string' ? row.fixture.id : row.caseLabel;
    const key = `${row.speaker}\u0000${caseId}`;
    let summary = groups.get(key);
    if (!summary) {
      summary = {
        speaker: row.speaker,
        caseId,
        tier: row.fixture?.tier === 'fragile' ? 'fragile' : 'stable',
        total: 0,
        pass: 0,
        warn: 0,
        fail: 0,
        variants: new Map()
      };
      groups.set(key, summary);
    }
    summary.total += 1;
    if (row.evaluation?.status === 'pass') {
      summary.pass += 1;
    } else if (row.evaluation?.status === 'warn') {
      summary.warn += 1;
    } else {
      summary.fail += 1;
    }

    const variant =
      typeof row.evaluation?.normalizedObserved === 'string' && row.evaluation.normalizedObserved !== ''
        ? row.evaluation.normalizedObserved
        : '(empty)';
    summary.variants.set(variant, (summary.variants.get(variant) ?? 0) + 1);
  }

  return [...groups.values()]
    .map((summary) => ({
      ...summary,
      passRate: summary.total > 0 ? summary.pass / summary.total : 0,
      topVariants: [...summary.variants.entries()]
        .sort((left, right) => {
          if (right[1] !== left[1]) {
            return right[1] - left[1];
          }
          return left[0].localeCompare(right[0]);
        })
        .slice(0, 3)
        .map(([variant, count]) => `${variant} (${count}/${summary.total})`)
        .join(' | ')
    }))
    .sort((left, right) => {
      if (left.passRate !== right.passRate) {
        return left.passRate - right.passRate;
      }
      if (left.fail !== right.fail) {
        return right.fail - left.fail;
      }
      if (left.speaker !== right.speaker) {
        return left.speaker.localeCompare(right.speaker);
      }
      return left.caseId.localeCompare(right.caseId);
    });
}

function buildReport({ fixturesPath, reportPath, faceWsUrl, speakerMetadata, rows, repeats, ttsSource, workerSpeed }) {
  const now = new Date().toISOString();
  const lines = [
    '# Latest Realtime-Primary TTS to ASR Closed-Loop Report',
    '',
    `Generated: ${now}`,
    '',
    `Fixtures: ${path.relative(repoRoot, fixturesPath)}`,
    `Report: ${path.relative(repoRoot, reportPath)}`,
    `Face WS: ${faceWsUrl}`,
    '',
    '- Machine judgment is a regression aid only.',
    '- Final human review is still required.',
    '- The primary path is the face-app websocket realtime route; batch ASR is only used as a fallback.',
    `- Repeats per case: ${repeats}.`,
    `- Fixture tiers present: ${[...new Set(rows.map((row) => row.fixture?.tier === 'fragile' ? 'fragile' : 'stable'))].join(', ')}.`,
    `- Voices exercised: ${speakerMetadata.map((entry) => entry.speaker).join(', ')}.`
  ];

  if (ttsSource === 'worker') {
    lines.push(`- The harness forced \`MH_QWEN_TTS_SPEED=${String(workerSpeed)}\` for this worker-managed run.`);
  } else {
    lines.push('- This was a face-app-managed TTS run; the runtime worker speed was not overridden by the harness.');
  }

  for (const entry of speakerMetadata) {
    const metadata =
      entry.ttsReady && typeof entry.ttsReady.voices_path === 'string'
        ? `\`${entry.ttsReady.voices_path}\``
        : 'unavailable';
    lines.push(`- TTS worker metadata [${entry.speaker}]: ${metadata}`);
  }

  if (repeats > 1) {
    const summaries = collectStabilitySummaries(rows);
    lines.push(
      '',
      '## Stability Summary',
      '',
      '| Voice | Tier | Case | Passes | Warns | Fails | Pass Rate | Top Variants |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |'
    );
    for (const summary of summaries) {
      const passRateLabel = `${Math.round(summary.passRate * 100)}%`;
      lines.push(
        `| ${escapeMarkdownCell(summary.speaker)} | ${escapeMarkdownCell(summary.tier)} | ${escapeMarkdownCell(summary.caseId)} | ${summary.pass}/${summary.total} | ${summary.warn}/${summary.total} | ${summary.fail}/${summary.total} | ${passRateLabel} | ${escapeMarkdownCell(summary.topVariants)} |`
      );
    }
  }

  lines.push(
    '',
    '| Voice | Tier | Case | Primary | Fallback | Machine | Reason | Expected | Primary Text | Final Text | Normalized | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  );

  for (const row of rows) {
    lines.push(
      `| ${escapeMarkdownCell(row.speaker)} | ${escapeMarkdownCell(row.fixture?.tier === 'fragile' ? 'fragile' : 'stable')} | ${escapeMarkdownCell(row.caseLabel)} | ${escapeMarkdownCell(row.primary)} | ${escapeMarkdownCell(row.fallback)} | ${escapeMarkdownCell(row.evaluation.status)} | ${escapeMarkdownCell(row.evaluation.reason)} | ${escapeMarkdownCell(row.evaluation.expected)} | ${escapeMarkdownCell(row.primaryText)} | ${escapeMarkdownCell(row.finalText)} | ${escapeMarkdownCell(row.evaluation.normalizedObserved)} | ${escapeMarkdownCell(row.fixture.notes || 'Human review required')} |`
    );
  }

  lines.push('', 'Human review note: this report follows the realtime-primary path, but synthesized pronunciation and service timing can still bias the outcome.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = await loadFixtures(options.fixturesPath);
  let selectedFixtures = fixtures;
  if (typeof options.tier === 'string' && options.tier !== '') {
    selectedFixtures = selectedFixtures.filter((fixture) => fixture.tier === options.tier);
  }
  if (typeof options.caseId === 'string' && options.caseId.trim() !== '') {
    selectedFixtures = selectedFixtures.filter((fixture) => fixture.id === options.caseId);
  }
  if (selectedFixtures.length === 0) {
    const filterParts = [];
    if (options.tier) {
      filterParts.push(`tier=${options.tier}`);
    }
    if (options.caseId) {
      filterParts.push(`case=${options.caseId}`);
    }
    throw new Error(`No fixtures matched: ${filterParts.join(', ') || 'all fixtures'}`);
  }
  const rows = [];
  const speakerMetadata = [];
  let hadErrors = false;

  const speakerRuns =
    options.ttsSource === 'face'
      ? [{ speaker: 'runtime', tts: null, metadata: { voice: 'runtime', voices_path: 'face-app-managed' } }]
      : options.speakers.map((speaker) => ({
          speaker,
          tts: createTtsSession({ ttsScriptPath: options.ttsScriptPath, speaker, speed: options.workerSpeed }),
          metadata: null
        }));

  for (const run of speakerRuns) {
    const speakerEntry = { speaker: run.speaker, ttsReady: run.metadata };
    speakerMetadata.push(speakerEntry);

    try {
      if (run.tts) {
        await withTimeout(
          run.tts.ready,
          ttsReadyTimeoutMs,
          `Timed out waiting for TTS ready after ${ttsReadyTimeoutMs}ms [${run.speaker}]`
        );
        speakerEntry.ttsReady = run.tts.getReadyPayload();
      }

      for (const fixture of selectedFixtures) {
        for (let attempt = 1; attempt <= options.repeats; attempt += 1) {
          const caseLabel = options.repeats > 1 ? `${fixture.id}#${attempt}` : fixture.id;
        try {
          const audio =
            options.ttsSource === 'face'
              ? await requestFaceAppTtsAudio({ faceWsUrl: options.faceWsUrl, text: fixture.ttsInput })
              : await run.tts.speak(fixture.ttsInput);
          if (!audio.audioBase64) {
            throw new Error(`TTS returned empty audio for case ${fixture.id} [${run.speaker}]`);
          }

          const realtimePcmBytes = convertTtsAudioToRealtimePcm(audio.audioBase64, realtimeSampleRateHz);
          let realtimeResult;
          try {
            realtimeResult = await runRealtimePrimary({
              faceWsUrl: options.faceWsUrl,
              language: fixture.language,
              pcmBytes: realtimePcmBytes
            });
          } catch (error) {
            realtimeResult = {
              primaryKind: 'error',
              primaryText: error instanceof Error ? error.message : String(error),
              primaryError: error instanceof Error ? error.message : String(error)
            };
          }

          const outcome = classifyRealtimePrimaryOutcome({
            text: realtimeResult.primaryText,
            language: fixture.language,
            error: realtimeResult.primaryError,
            hasBufferedAudio: realtimePcmBytes.length > 0
          });

          let fallback = 'unused';
          let finalText = outcome.acceptedText;

          if (outcome.useFallback) {
            try {
              const wavBuffer = buildWaveBufferFromPcmBytes(realtimePcmBytes, realtimeSampleRateHz);
              const batch = await transcribeWithBatchAsr({
                asrBaseUrl: options.asrBaseUrl,
                audioBase64: wavBuffer.toString('base64'),
                mimeType: 'audio/wav',
                language: fixture.language
              });
              if (shouldAcceptOperatorBatchFallbackResult(batch, fixture.language)) {
                fallback = `accepted:${outcome.reason}`;
                finalText = batch.text;
              } else {
                fallback = `rejected:${outcome.reason}`;
                finalText = '';
              }
            } catch (error) {
              fallback = `failed:${outcome.reason}`;
              finalText = '';
              hadErrors = true;
            }
          }

          rows.push({
            speaker: run.speaker,
            caseLabel,
            fixture,
            primary:
              realtimeResult.primaryKind === 'error'
                ? `error:${realtimeResult.primaryError}`
                : `done:${outcome.reason}`,
            fallback,
            primaryText: realtimeResult.primaryText,
            finalText,
            evaluation: evaluateLoopCase(fixture, finalText)
          });
        } catch (error) {
          hadErrors = true;
          rows.push({
            speaker: run.speaker,
            caseLabel,
            fixture,
            primary: 'infra-error',
            fallback: 'n/a',
            primaryText: error instanceof Error ? error.message : String(error),
            finalText: '',
            evaluation: evaluateLoopCase(fixture, '')
          });
          break;
        }
        }
      }
    } finally {
      if (run.tts) {
        await run.tts.close();
      }
    }
  }

  const report = buildReport({
    fixturesPath: options.fixturesPath,
    reportPath: options.reportPath,
    faceWsUrl: options.faceWsUrl,
    speakerMetadata,
    rows,
    repeats: options.repeats,
    ttsSource: options.ttsSource,
    workerSpeed: options.workerSpeed
  });
  await writeFile(options.reportPath, report, 'utf8');
  process.stdout.write(`Wrote ${path.relative(repoRoot, options.reportPath)}\n`);
  if (hadErrors) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
