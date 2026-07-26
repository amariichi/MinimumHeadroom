#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..');

function optionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeGpuName(value) {
  return optionalString(value)?.replace(/\s+/gu, ' ').toLowerCase() ?? null;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      throw new Error(`unexpected argument: ${item}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      options[item.slice(2)] = true;
    } else {
      options[item.slice(2)] = value;
      index += 1;
    }
  }
  return options;
}

export function validateGemma4MtpBenchmark({
  report,
  gemmaManifest,
  gpuName,
  gpuMemoryTotalMiB,
  llamaCppCommit
}) {
  const errors = [];
  if (report?.schemaVersion !== 1) errors.push('schema_version');
  if (report?.recommended !== true) errors.push('not_recommended');
  const draftTokens = Number(report?.draftTokens);
  if (!Number.isInteger(draftTokens) || draftTokens < 1 || draftTokens > 32) {
    errors.push('invalid_draft_tokens');
  }
  if (report?.approval?.explicit !== true) {
    errors.push('missing_explicit_approval');
  }
  if (report?.selection?.candidate?.draftTokens !== draftTokens) {
    errors.push('candidate_mismatch');
  }
  if (
    report?.environment?.contendedGpuAllowed === true
    || (
      Array.isArray(report?.environment?.preexistingGpuProcesses)
      && report.environment.preexistingGpuProcesses.length > 0
    )
  ) {
    errors.push('contended_gpu');
  }

  const expectedGpuName = normalizeGpuName(report?.environment?.gpu?.name);
  const actualGpuName = normalizeGpuName(gpuName);
  if (!expectedGpuName || !actualGpuName || expectedGpuName !== actualGpuName) {
    errors.push('gpu_name_mismatch');
  }
  const expectedMemory = Number(report?.environment?.gpu?.memoryTotalMiB);
  const actualMemory = Number(gpuMemoryTotalMiB);
  if (
    !Number.isFinite(expectedMemory)
    || !Number.isFinite(actualMemory)
    || Math.abs(expectedMemory - actualMemory) > 16
  ) {
    errors.push('gpu_memory_mismatch');
  }
  if (
    !optionalString(llamaCppCommit)
    || llamaCppCommit === 'unknown'
    || report?.environment?.llamaCpp?.commit !== llamaCppCommit
  ) {
    errors.push('llama_commit_mismatch');
  }

  const main = gemmaManifest?.runtime?.files?.find((item) => item.role === 'main');
  const mmproj = gemmaManifest?.runtime?.files?.find((item) => item.role === 'mmproj');
  const environmentModel = report?.environment?.model;
  if (environmentModel?.revision !== gemmaManifest?.runtime?.revision) {
    errors.push('model_revision_mismatch');
  }
  if (environmentModel?.mainSha256 !== main?.sha256) {
    errors.push('main_hash_mismatch');
  }
  if (environmentModel?.mmprojSha256 !== mmproj?.sha256) {
    errors.push('mmproj_hash_mismatch');
  }
  if (
    environmentModel?.assistantSha256
    !== gemmaManifest?.assistantGguf?.sha256
  ) {
    errors.push('assistant_hash_mismatch');
  }

  const measured = Array.isArray(report?.results)
    ? report.results.find(
        (result) => result.mode === 'mtp'
          && result.draftTokens === draftTokens
      )
    : null;
  if (!measured?.summary?.allValid) {
    errors.push('measured_result_invalid');
  }
  return {
    ok: errors.length === 0,
    draftTokens: errors.length === 0 ? draftTokens : null,
    errors
  };
}

function usage() {
  return `Usage: node scripts/validate-gemma4-mtp-benchmark.mjs \\
  --manifest FILE --gpu-name NAME --gpu-memory-mib N --llama-commit SHA

Prints the approved draft-token count on success. Exits nonzero when the
manifest is unapproved or does not match this GPU, llama.cpp commit, or the
checked-in Gemma artifact provenance.
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const manifestPath = optionalString(options.manifest);
  if (!manifestPath) {
    throw new Error('--manifest is required');
  }
  const report = JSON.parse(await readFile(path.resolve(manifestPath), 'utf8'));
  const gemmaManifest = JSON.parse(
    await readFile(
      path.join(repoRoot, 'config/models/gemma4-interpreter.json'),
      'utf8'
    )
  );
  const result = validateGemma4MtpBenchmark({
    report,
    gemmaManifest,
    gpuName: options['gpu-name'],
    gpuMemoryTotalMiB: options['gpu-memory-mib'],
    llamaCppCommit: options['llama-commit']
  });
  if (!result.ok) {
    throw new Error(`manifest rejected: ${result.errors.join(',')}`);
  }
  process.stdout.write(`${result.draftTokens}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[validate-gemma4-mtp] ${error.message}\n`);
    process.exitCode = 1;
  });
}
