#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectPcm16MonoWav } from '../face-app/dist/interpreter_api.js';
import { createStdioWorkerClient } from '../face-app/dist/tts_controller.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..');
const defaultSpec = path.join(
  repoRoot,
  'config/benchmarks/interpreter-multilingual-corpus.json'
);

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

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requireString(value, label) {
  const result = optionalString(value);
  if (!result) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return result;
}

export function validateCorpusSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('corpus spec must be a JSON object');
  }
  if (value.schemaVersion !== 1) {
    throw new Error('corpus spec schemaVersion must be 1');
  }
  const corpusId = requireString(value.corpusId, 'corpusId');
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(corpusId)) {
    throw new Error('corpusId must use lowercase filename-safe characters');
  }
  const generator = value.generator;
  if (!generator || typeof generator !== 'object' || Array.isArray(generator)) {
    throw new Error('generator must be an object');
  }
  const normalizedGenerator = {
    engine: requireString(generator.engine, 'generator.engine'),
    revision: requireString(generator.revision, 'generator.revision'),
    voice: requireString(generator.voice, 'generator.voice'),
    steps: Number.parseInt(generator.steps, 10),
    speed: finiteNumber(generator.speed),
    intraOpThreads: Number.parseInt(generator.intraOpThreads, 10),
    interOpThreads: Number.parseInt(generator.interOpThreads, 10),
    outputSampleRate: Number.parseInt(generator.outputSampleRate, 10)
  };
  if (normalizedGenerator.engine !== 'supertonic-3-onnx') {
    throw new Error('generator.engine must be supertonic-3-onnx');
  }
  if (
    !Number.isInteger(normalizedGenerator.steps)
    || normalizedGenerator.steps < 5
    || normalizedGenerator.steps > 12
  ) {
    throw new Error('generator.steps must be an integer from 5 through 12');
  }
  if (
    normalizedGenerator.speed === null
    || normalizedGenerator.speed < 0.7
    || normalizedGenerator.speed > 2
  ) {
    throw new Error('generator.speed must be from 0.7 through 2.0');
  }
  for (const name of ['intraOpThreads', 'interOpThreads']) {
    if (
      !Number.isInteger(normalizedGenerator[name])
      || normalizedGenerator[name] < 1
      || normalizedGenerator[name] > 64
    ) {
      throw new Error(`generator.${name} must be an integer from 1 through 64`);
    }
  }
  if (normalizedGenerator.outputSampleRate !== 16_000) {
    throw new Error('generator.outputSampleRate must be 16000');
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error('corpus spec must contain a non-empty cases array');
  }

  const ids = new Set();
  const cases = value.cases.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`case ${index + 1} must be an object`);
    }
    const id = requireString(item.id, `cases[${index}].id`);
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
      throw new Error(`case id must be filename-safe: ${id}`);
    }
    if (ids.has(id)) {
      throw new Error(`duplicate case id: ${id}`);
    }
    ids.add(id);
    const language = primaryLanguage(item.language);
    const expectedSource = primaryLanguage(item.expectedSource);
    const expectedTarget = primaryLanguage(item.expectedTarget);
    const expectedPipelineTarget = item.expectedPipelineTarget === null
      ? null
      : primaryLanguage(item.expectedPipelineTarget);
    if (!language || !expectedSource || language !== expectedSource) {
      throw new Error(`case ${id} language must match expectedSource`);
    }
    if (!expectedTarget || expectedTarget === expectedSource) {
      throw new Error(`case ${id} expectedTarget must differ from source`);
    }
    if (
      expectedPipelineTarget !== null
      && expectedPipelineTarget === expectedSource
    ) {
      throw new Error(
        `case ${id} expectedPipelineTarget must be null or differ from source`
      );
    }
    return {
      id,
      category: requireString(item.category, `case ${id} category`),
      language,
      text: requireString(item.text, `case ${id} text`),
      expectedTranscript: requireString(
        item.expectedTranscript,
        `case ${id} expectedTranscript`
      ),
      expectedContentText: requireString(
        item.expectedContentText,
        `case ${id} expectedContentText`
      ),
      expectedSource,
      expectedPipelineTarget,
      expectedTarget,
      referenceTranslation: requireString(
        item.referenceTranslation,
        `case ${id} referenceTranslation`
      )
    };
  });

  const requiredBaselineLanguages = Array.isArray(
    value.requiredBaselineLanguages
  )
    ? value.requiredBaselineLanguages.map(primaryLanguage)
    : [];
  if (requiredBaselineLanguages.some((language) => !language)) {
    throw new Error('requiredBaselineLanguages contains an invalid language');
  }
  for (const language of requiredBaselineLanguages) {
    const present = cases.some(
      (item) => item.category === 'baseline' && item.language === language
    );
    if (!present) {
      throw new Error(`missing baseline case for required language: ${language}`);
    }
  }

  return {
    schemaVersion: 1,
    corpusId,
    description: optionalString(value.description),
    generator: normalizedGenerator,
    requiredBaselineLanguages,
    cases
  };
}

function parseArguments(argv) {
  const options = {
    spec: defaultSpec,
    output: null,
    force: false,
    dryRun: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--force') {
      options.force = true;
    } else if (item === '--dry-run') {
      options.dryRun = true;
    } else if (item === '-h' || item === '--help') {
      options.help = true;
    } else if (item === '--spec' || item === '--output') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        throw new Error(`${item} requires a value`);
      }
      options[item.slice(2)] = next;
      index += 1;
    } else {
      throw new Error(`unknown option: ${item}`);
    }
  }
  return options;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filename) {
  return sha256Bytes(await readFile(filename));
}

async function existingManifestIsReusable({
  outputDir,
  specSha256,
  corpusId
}) {
  const manifestPath = path.join(outputDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return false;
  }
  if (
    manifest?.schemaVersion !== 1
    || manifest?.corpusId !== corpusId
    || manifest?.spec?.sha256 !== specSha256
    || !Array.isArray(manifest?.cases)
    || manifest.cases.length === 0
  ) {
    return false;
  }
  for (const item of manifest.cases) {
    const filename = optionalString(item?.file);
    const expectedHash = optionalString(item?.sha256);
    if (!filename || !expectedHash) {
      return false;
    }
    const absolute = path.resolve(outputDir, filename);
    if (
      absolute !== outputDir
      && !absolute.startsWith(`${outputDir}${path.sep}`)
    ) {
      return false;
    }
    try {
      if (await sha256File(absolute) !== expectedHash) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      };
      if (code === 0) {
        resolve(result);
      } else {
        reject(new Error(
          `${command} exited ${code ?? signal}: ${result.stderr.trim()}`
        ));
      }
    });
  });
}

function createCorpusWorker(spec) {
  const waiters = new Map();
  let readyResolve;
  let readyReject;
  let workerExited = false;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const client = createStdioWorkerClient({
    cwd: repoRoot,
    command: {
      cmd: './scripts/run-tts-worker.sh',
      args: []
    },
    env: {
      TTS_ENGINE: 'supertonic',
      MH_AUDIO_TARGET: 'browser',
      MH_TTS_REMOTE_PREFETCH_MS: '0',
      MH_SUPERTONIC_VOICE: spec.generator.voice,
      MH_SUPERTONIC_STEPS: String(spec.generator.steps),
      MH_SUPERTONIC_SPEED: String(spec.generator.speed),
      MH_SUPERTONIC_INTRA_OP_THREADS: String(
        spec.generator.intraOpThreads
      ),
      MH_SUPERTONIC_INTER_OP_THREADS: String(
        spec.generator.interOpThreads
      ),
      SUPERTONIC_MODEL_REVISION: spec.generator.revision
    },
    log: {
      warn(message) {
        process.stderr.write(`${message}\n`);
      }
    }
  });

  client.on('message', (message) => {
    if (message?.type === 'ready') {
      if (
        message.engine !== spec.generator.engine
        || message.voice !== spec.generator.voice
        || !String(message.voices_path ?? '').includes(spec.generator.revision)
      ) {
        readyReject(new Error(
          'Supertonic worker provenance does not match the corpus spec'
        ));
        return;
      }
      readyResolve(message);
      return;
    }
    const waiter = waiters.get(message?.utterance_id);
    if (!waiter) {
      return;
    }
    if (message.type === 'event' && optionalString(message.phase)) {
      process.stdout.write(
        `[generate-interpreter-corpus] worker_phase=${message.phase} utterance=${message.utterance_id}\n`
      );
    }
    if (message.type === 'audio') {
      if (
        message.mime_type !== 'audio/wav'
        || typeof message.audio_base64 !== 'string'
      ) {
        waiter.reject(new Error('TTS worker returned invalid audio payload'));
      } else {
        waiter.resolve({
          bytes: Buffer.from(message.audio_base64, 'base64'),
          sampleRate: Number(message.sample_rate)
        });
      }
      waiters.delete(message.utterance_id);
    } else if (
      message.type === 'event'
      && ['error', 'dropped'].includes(message.phase)
    ) {
      waiter.reject(new Error(
        `TTS ${message.phase}: ${message.reason ?? 'unknown'}`
      ));
      waiters.delete(message.utterance_id);
    }
  });
  client.on('error', (error) => {
    readyReject(error);
    for (const waiter of waiters.values()) {
      waiter.reject(error);
    }
    waiters.clear();
  });
  client.on('exit', ({ code, signal }) => {
    workerExited = true;
    const error = new Error(
      `TTS worker exited before completion (${code ?? signal ?? 'unknown'})`
    );
    readyReject(error);
    for (const waiter of waiters.values()) {
      waiter.reject(error);
    }
    waiters.clear();
  });

  async function waitUntilReady(timeoutMs = 180_000) {
    let timer;
    try {
      return await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Supertonic worker readiness timeout')),
            timeoutMs
          );
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function synthesize(item, generation, timeoutMs = 300_000) {
    if (workerExited) {
      throw new Error('Supertonic worker is not running');
    }
    const utteranceId = `corpus-${process.pid}-${item.id}-${generation}`;
    let timer;
    const audio = new Promise((resolve, reject) => {
      waiters.set(utteranceId, { resolve, reject });
      timer = setTimeout(() => {
        waiters.delete(utteranceId);
        reject(new Error(`TTS timeout for ${item.id}`));
      }, timeoutMs);
    });
    const now = Date.now();
    if (!client.send({
      op: 'speak',
      id: `request-${utteranceId}`,
      generation,
      session_id: 'interpreter-corpus-generator',
      utterance_id: utteranceId,
      text: item.text,
      speaker: spec.generator.voice,
      language: item.language,
      expires_at: now + timeoutMs,
      message_id: item.id,
      revision: now
    })) {
      clearTimeout(timer);
      waiters.delete(utteranceId);
      throw new Error('failed to write to the TTS worker');
    }
    try {
      return await audio;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    waitUntilReady,
    synthesize,
    stop() {
      client.stop();
    }
  };
}

function displayPath(filename) {
  const relative = path.relative(repoRoot, filename);
  return relative.startsWith('..') ? filename : relative;
}

async function generate(options) {
  const absoluteSpec = path.resolve(options.spec);
  const specBytes = await readFile(absoluteSpec);
  const spec = validateCorpusSpec(JSON.parse(specBytes.toString('utf8')));
  const specSha256 = sha256Bytes(specBytes);
  const outputDir = path.resolve(
    options.output
      ?? path.join(
        repoRoot,
        '.local/state/interpreter/corpus',
        spec.corpusId
      )
  );

  process.stdout.write(
    `[generate-interpreter-corpus] corpus=${spec.corpusId} cases=${spec.cases.length}\n`
  );
  process.stdout.write(
    `[generate-interpreter-corpus] spec=${displayPath(absoluteSpec)} sha256=${specSha256}\n`
  );
  process.stdout.write(
    `[generate-interpreter-corpus] output=${displayPath(outputDir)}\n`
  );
  for (const item of spec.cases) {
    process.stdout.write(
      `[generate-interpreter-corpus] case=${item.id} language=${item.language} pipeline_target=${item.expectedPipelineTarget ?? 'none'} direct_target=${item.expectedTarget}\n`
    );
  }
  if (options.dryRun) {
    process.stdout.write(
      '[generate-interpreter-corpus] dry-run: no model load and no file writes\n'
    );
    return;
  }

  if (await existingManifestIsReusable({
    outputDir,
    specSha256,
    corpusId: spec.corpusId
  })) {
    process.stdout.write(
      `[generate-interpreter-corpus] reuse=${displayPath(path.join(outputDir, 'manifest.json'))}\n`
    );
    return;
  }
  try {
    const entries = await readdir(outputDir);
    if (entries.length > 0 && !options.force) {
      throw new Error(
        `output exists but does not match the spec: ${displayPath(outputDir)}; use --force to replace listed artifacts`
      );
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  await mkdir(path.join(outputDir, 'audio'), { recursive: true });
  const ffmpegVersion = (
    await runProcess('ffmpeg', ['-version'])
  ).stdout.split(/\r?\n/u)[0].trim();
  const worker = createCorpusWorker(spec);
  const manifestCases = [];
  try {
    const ready = await worker.waitUntilReady();
    for (const [index, item] of spec.cases.entries()) {
      process.stdout.write(
        `[generate-interpreter-corpus] synthesizing ${index + 1}/${spec.cases.length} ${item.id}\n`
      );
      const generated = await worker.synthesize(item, index + 1);
      const rawPath = path.join(
        outputDir,
        `.${item.id}.${process.pid}.source.wav`
      );
      const temporaryPath = path.join(
        outputDir,
        'audio',
        `.${item.id}.${process.pid}.wav`
      );
      const finalPath = path.join(outputDir, 'audio', `${item.id}.wav`);
      await writeFile(rawPath, generated.bytes);
      try {
        await runProcess('ffmpeg', [
          '-hide_banner',
          '-loglevel', 'error',
          '-y',
          '-i', rawPath,
          '-ac', '1',
          '-ar', String(spec.generator.outputSampleRate),
          '-c:a', 'pcm_s16le',
          temporaryPath
        ]);
        const finalBytes = await readFile(temporaryPath);
        const inspected = inspectPcm16MonoWav(finalBytes);
        if (!inspected.ok) {
          throw new Error(
            `normalized fixture is invalid for ${item.id}: ${inspected.error}`
          );
        }
        await rename(temporaryPath, finalPath);
        const metadata = await stat(finalPath);
        manifestCases.push({
          ...item,
          file: `audio/${item.id}.wav`,
          sha256: sha256Bytes(finalBytes),
          bytes: metadata.size,
          durationMs: inspected.durationMs,
          sourceAudio: {
            sha256: sha256Bytes(generated.bytes),
            sampleRate: generated.sampleRate
          }
        });
      } finally {
        await unlink(rawPath).catch(() => {});
        await unlink(temporaryPath).catch(() => {});
      }
    }

    const manifest = {
      schemaVersion: 1,
      corpusId: spec.corpusId,
      description: spec.description,
      syntheticCleanBaseline: true,
      realWorldAccuracyClaim: false,
      spec: {
        path: displayPath(absoluteSpec),
        sha256: specSha256
      },
      generator: {
        ...spec.generator,
        workerEngine: ready.engine,
        workerVoice: ready.voice,
        workerModelPath: ready.model_path,
        workerVoicesPath: ready.voices_path,
        ffmpeg: ffmpegVersion
      },
      createdAt: new Date().toISOString(),
      cases: manifestCases
    };
    const manifestPath = path.join(outputDir, 'manifest.json');
    const temporaryManifest = `${manifestPath}.${process.pid}.tmp`;
    await writeFile(
      temporaryManifest,
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    await rename(temporaryManifest, manifestPath);
    process.stdout.write(
      `[generate-interpreter-corpus] manifest=${displayPath(manifestPath)}\n`
    );
  } finally {
    worker.stop();
  }
}

function usage() {
  return `Usage: node scripts/generate-interpreter-corpus.mjs [options]

Generate a pinned Supertonic clean-speech corpus and normalize every WAV to
16 kHz mono PCM16. Generated audio and its hash manifest stay under .local.

Options:
  --spec FILE       Checked-in corpus specification
  --output DIR      Override the generated corpus directory
  --force           Replace listed artifacts when provenance does not match
  --dry-run         Validate and print cases without model load or file writes
  -h, --help        Show this help
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  await generate(options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[generate-interpreter-corpus] ${error.message}\n`);
    process.exitCode = 1;
  });
}
