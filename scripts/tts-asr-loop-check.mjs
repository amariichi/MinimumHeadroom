#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

import { defaultLoopSpeakers, evaluateLoopCase, parseLoopSpeakers } from './tts-asr-loop-lib.mjs';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const repoRoot = path.resolve(currentDir, '..');
const defaultFixturesPath = path.resolve(repoRoot, 'test/tts-asr-loop/cases.json');
const defaultReportPath = path.resolve(repoRoot, 'test/tts-asr-loop/latest-report.md');
const defaultTtsScriptPath = path.resolve(repoRoot, 'scripts/run-tts-worker.sh');
const defaultAsrBaseUrl = 'http://127.0.0.1:8091';
const ttsReadyTimeoutMs = 10_000;
const ttsSpeakTimeoutMs = 120_000;
const asrRequestTimeoutMs = 30_000;
const ttsShutdownTimeoutMs = 2_000;

function parseArgs(argv) {
  const options = {
    fixturesPath: defaultFixturesPath,
    reportPath: defaultReportPath,
    ttsScriptPath: defaultTtsScriptPath,
    asrBaseUrl: defaultAsrBaseUrl,
    speakers: [...defaultLoopSpeakers]
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
    if ((value === '--voices' || value === '--speakers') && argv[index + 1]) {
      options.speakers = parseLoopSpeakers(argv[index + 1], options.speakers);
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
      'Usage: node scripts/tts-asr-loop-check.mjs [--fixtures <path>] [--report <path>] [--tts-script <path>] [--asr-base-url <url>] [--voices <list>]',
      '',
      'The harness expects a local Qwen3 TTS worker script and a local ASR worker HTTP endpoint.',
      'It always forces MH_QWEN_TTS_SPEED=1.0 when spawning the TTS worker.',
      'It uses browser audio output, so it bypasses live playback-time stretching.',
      `Default voices: ${defaultLoopSpeakers.join(', ')}.`,
      'Use --voices with a comma-separated list such as "Serena,Vivian" to narrow the matrix.'
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

function createTtsSession({ ttsScriptPath, speaker }) {
  const child = spawn(ttsScriptPath, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TTS_ENGINE: 'qwen3',
      MH_AUDIO_TARGET: 'browser',
      MH_QWEN_TTS_SPEED: '1.0',
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

  const exitPromise = new Promise((resolve) => {
    exitResolve = resolve;
  });

  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
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
          session_id: 'tts-asr-loop',
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

async function transcribeWithAsr({ asrBaseUrl, audioBase64, mimeType, language }) {
  const endpoint = new URL(`/v1/asr/${language === 'ja' ? 'ja' : 'en'}`, asrBaseUrl).toString();
  const controller = new AbortController();
  const abortTimer = setTimeout(() => {
    controller.abort();
  }, asrRequestTimeoutMs);

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
      throw new Error(`ASR request timed out after ${asrRequestTimeoutMs}ms for ${endpoint}`);
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

function buildErrorRow({ speaker, fixture = null, message, stage }) {
  return {
    speaker,
    fixture: fixture ?? {
      id: '(startup)',
      tier: 'n/a',
      notes: `Infrastructure failure during ${stage}.`,
      displayText: ''
    },
    rawAsrText: '',
    evaluation: {
      status: 'error',
      reason: message,
      expected: fixture?.displayText ?? '',
      normalizedObserved: ''
    }
  };
}

function buildReport({ fixturesPath, reportPath, speakerMetadata, rows }) {
  const now = new Date().toISOString();
  const lines = [
    '# Latest TTS to ASR Closed-Loop Report',
    '',
    `Generated: ${now}`,
    '',
    `Fixtures: ${path.relative(repoRoot, fixturesPath)}`,
    `Report: ${path.relative(repoRoot, reportPath)}`,
    '',
    '- Machine judgment is a regression aid only.',
    '- Final human review is still required.',
    '- Rows marked `error` are infrastructure failures, not transcript mismatches.',
    '- The harness forced `MH_QWEN_TTS_SPEED=1.0` for this run.',
    '- The harness used browser audio output, so it bypassed live playback-time stretching.',
    '- The harness posts to the batch ASR HTTP endpoint, so it primarily validates the Parakeet fallback path rather than the full Voxtral realtime stream.',
    `- Voices exercised: ${speakerMetadata.map((entry) => entry.speaker).join(', ')}.`
  ];

  for (const entry of speakerMetadata) {
    const metadata =
      entry.ttsReady && typeof entry.ttsReady.voices_path === 'string'
        ? `\`${entry.ttsReady.voices_path}\``
        : 'unavailable';
    lines.push(`- TTS worker metadata [${entry.speaker}]: ${metadata}`);
  }

  lines.push('', '| Voice | Case | Tier | Machine | Reason | Expected | Raw ASR | Normalized | Notes |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');

  for (const row of rows) {
    lines.push(
      `| ${escapeMarkdownCell(row.speaker)} | ${escapeMarkdownCell(row.fixture.id)} | ${escapeMarkdownCell(row.fixture.tier)} | ${escapeMarkdownCell(row.evaluation.status)} | ${escapeMarkdownCell(row.evaluation.reason)} | ${escapeMarkdownCell(row.evaluation.expected)} | ${escapeMarkdownCell(row.rawAsrText)} | ${escapeMarkdownCell(row.evaluation.normalizedObserved)} | ${escapeMarkdownCell(row.fixture.notes || 'Human review required')} |`
    );
  }

  lines.push('', 'Human review note: synthesized pronunciation can bias the ASR output, so treat passes as “still looks good” rather than “guaranteed correct”.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = await loadFixtures(options.fixturesPath);
  const rows = [];
  const speakerMetadata = [];
  let hadErrors = false;

  for (const speaker of options.speakers) {
    const tts = createTtsSession({ ttsScriptPath: options.ttsScriptPath, speaker });
    const speakerEntry = {
      speaker,
      ttsReady: null
    };
    speakerMetadata.push(speakerEntry);

    try {
      await withTimeout(
        tts.ready,
        ttsReadyTimeoutMs,
        `Timed out waiting for TTS ready after ${ttsReadyTimeoutMs}ms [${speaker}]`
      );
      speakerEntry.ttsReady = tts.getReadyPayload();

      for (const fixture of fixtures) {
        try {
          const audio = await tts.speak(fixture.ttsInput);
          if (!audio.audioBase64) {
            throw new Error(`TTS worker returned empty audio for case ${fixture.id} [${speaker}]`);
          }
          const asr = await transcribeWithAsr({
            asrBaseUrl: options.asrBaseUrl,
            audioBase64: audio.audioBase64,
            mimeType: audio.mimeType,
            language: fixture.language
          });
          rows.push({
            speaker,
            fixture,
            rawAsrText: typeof asr.text === 'string' ? asr.text.trim() : '',
            evaluation: evaluateLoopCase(fixture, asr.text)
          });
        } catch (error) {
          hadErrors = true;
          rows.push(
            buildErrorRow({
              speaker,
              fixture,
              stage: 'case',
              message: error instanceof Error ? error.message : String(error)
            })
          );
          break;
        }
      }
    } catch (error) {
      hadErrors = true;
      rows.push(
        buildErrorRow({
          speaker,
          stage: 'startup',
          message: error instanceof Error ? error.message : String(error)
        })
      );
    } finally {
      await tts.close();
    }
  }

  const report = buildReport({
    fixturesPath: options.fixturesPath,
    reportPath: options.reportPath,
    speakerMetadata,
    rows
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
