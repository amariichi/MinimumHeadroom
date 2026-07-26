import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  selectMtpCandidate,
  summarizeBenchmarkSamples
} from '../../scripts/gemma4-mtp-benchmark.mjs';
import {
  validateGemma4MtpBenchmark
} from '../../scripts/validate-gemma4-mtp-benchmark.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');

function sample({
  totalMs,
  firstContentMs,
  predicted = 20,
  draft = 0,
  accepted = 0,
  valid = true
}) {
  return {
    totalMs,
    firstContentMs,
    schemaValid: valid,
    directionValid: valid,
    timings: {
      predicted_per_second: predicted,
      draft_n: draft,
      draft_n_accepted: accepted
    }
  };
}

test('MTP benchmark summary keeps direction validity and draft acceptance explicit', () => {
  const summary = summarizeBenchmarkSamples([
    sample({
      totalMs: 1000,
      firstContentMs: 400,
      draft: 20,
      accepted: 12
    }),
    sample({
      totalMs: 900,
      firstContentMs: 350,
      draft: 10,
      accepted: 6
    })
  ]);
  assert.equal(summary.allValid, true);
  assert.equal(summary.totalMs.median, 900);
  assert.equal(summary.totalMs.p95, 1000);
  assert.equal(summary.draft.acceptanceRate, 0.6);
});

test('MTP benchmark exposes normalized transcript accuracy when supplied', () => {
  const summary = summarizeBenchmarkSamples([
    {
      ...sample({ totalMs: 1000, firstContentMs: 400 }),
      transcriptCer: 0,
      transcriptExact: true
    },
    {
      ...sample({ totalMs: 900, firstContentMs: 350 }),
      transcriptCer: 0.1,
      transcriptExact: false
    }
  ]);
  assert.equal(summary.transcript.evaluatedCount, 2);
  assert.equal(summary.transcript.exactAccuracy, 0.5);
  assert.equal(summary.transcript.cer.median, 0);
  assert.equal(summary.transcript.cer.p95, 0.1);
  assert.equal(summary.transcript.allExact, false);
});

test('MTP candidate requires latency, first-content, acceptance, and correctness', () => {
  const baseline = {
    mode: 'off',
    draftTokens: 0,
    summary: summarizeBenchmarkSamples([
      sample({ totalMs: 1000, firstContentMs: 400 }),
      sample({ totalMs: 1100, firstContentMs: 420 })
    ])
  };
  const passing = {
    mode: 'mtp',
    draftTokens: 2,
    summary: summarizeBenchmarkSamples([
      sample({
        totalMs: 850,
        firstContentMs: 410,
        draft: 20,
        accepted: 12
      }),
      sample({
        totalMs: 900,
        firstContentMs: 420,
        draft: 20,
        accepted: 12
      })
    ])
  };
  const directionFailure = {
    mode: 'mtp',
    draftTokens: 4,
    summary: summarizeBenchmarkSamples([
      sample({
        totalMs: 700,
        firstContentMs: 350,
        draft: 20,
        accepted: 18,
        valid: false
      })
    ])
  };
  const selected = selectMtpCandidate([
    baseline,
    passing,
    directionFailure
  ]);
  assert.equal(selected.candidate.draftTokens, 2);
});

test('MTP candidate compares transcript with off instead of requiring perfect ASR', () => {
  const sharedSummary = {
    allValid: true,
    totalMs: { median: 1000 },
    firstContentMs: { median: 400 },
    draft: { acceptanceRate: null }
  };
  const baseline = {
    mode: 'off',
    summary: sharedSummary,
    samples: [{
      caseId: 'explicit',
      run: 1,
      observedTranscript: 'Buenos días.'
    }]
  };
  const preserved = {
    mode: 'mtp',
    draftTokens: 1,
    summary: {
      ...sharedSummary,
      totalMs: { median: 800 },
      firstContentMs: { median: 410 },
      draft: { acceptanceRate: 0.9 }
    },
    samples: [{
      caseId: 'explicit',
      run: 1,
      observedTranscript: 'Buenos días!'
    }]
  };
  const changed = {
    mode: 'mtp',
    draftTokens: 2,
    summary: {
      ...sharedSummary,
      totalMs: { median: 700 },
      firstContentMs: { median: 410 },
      draft: { acceptanceRate: 0.9 }
    },
    samples: [{
      caseId: 'explicit',
      run: 1,
      observedTranscript: 'Buenas tardes.'
    }]
  };
  const selected = selectMtpCandidate([baseline, preserved, changed]);
  assert.equal(selected.candidate.draftTokens, 1);
  assert.equal(
    selected.candidate.transcriptEquivalence.allEquivalent,
    true
  );
});

test('approved MTP manifest must match GPU, llama.cpp, and all Gemma hashes', async () => {
  const gemmaManifest = JSON.parse(
    await readFile(
      path.join(repoRoot, 'config/models/gemma4-interpreter.json'),
      'utf8'
    )
  );
  const main = gemmaManifest.runtime.files.find((item) => item.role === 'main');
  const mmproj = gemmaManifest.runtime.files.find((item) => item.role === 'mmproj');
  const measured = {
    mode: 'mtp',
    draftTokens: 2,
    summary: {
      allValid: true
    }
  };
  const report = {
    schemaVersion: 1,
    recommended: true,
    draftTokens: 2,
    approval: { explicit: true },
    selection: {
      candidate: {
        draftTokens: 2
      }
    },
    environment: {
      gpu: {
        name: 'NVIDIA RTX PRO 4500 Blackwell',
        memoryTotalMiB: 32623
      },
      llamaCpp: {
        commit: gemmaManifest.llamaCpp.knownGoodCommit
      },
      model: {
        revision: gemmaManifest.runtime.revision,
        mainSha256: main.sha256,
        mmprojSha256: mmproj.sha256,
        assistantSha256: gemmaManifest.assistantGguf.sha256
      }
    },
    results: [measured]
  };
  const accepted = validateGemma4MtpBenchmark({
    report,
    gemmaManifest,
    gpuName: 'NVIDIA RTX PRO 4500 Blackwell',
    gpuMemoryTotalMiB: 32623,
    llamaCppCommit: gemmaManifest.llamaCpp.knownGoodCommit
  });
  assert.deepEqual(accepted, {
    ok: true,
    draftTokens: 2,
    errors: []
  });

  const rejected = validateGemma4MtpBenchmark({
    report,
    gemmaManifest,
    gpuName: 'Different GPU',
    gpuMemoryTotalMiB: 32623,
    llamaCppCommit: gemmaManifest.llamaCpp.knownGoodCommit
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errors.includes('gpu_name_mismatch'), true);

  const contended = validateGemma4MtpBenchmark({
    report: {
      ...report,
      environment: {
        ...report.environment,
        contendedGpuAllowed: true,
        preexistingGpuProcesses: ['1234, old-server, 4096']
      }
    },
    gemmaManifest,
    gpuName: 'NVIDIA RTX PRO 4500 Blackwell',
    gpuMemoryTotalMiB: 32623,
    llamaCppCommit: gemmaManifest.llamaCpp.knownGoodCommit
  });
  assert.equal(contended.ok, false);
  assert.equal(contended.errors.includes('contended_gpu'), true);

  const hiddenContention = validateGemma4MtpBenchmark({
    report: {
      ...report,
      environment: {
        ...report.environment,
        contendedGpuAllowed: false,
        preexistingGpuProcesses: ['1234, old-server, 4096']
      }
    },
    gemmaManifest,
    gpuName: 'NVIDIA RTX PRO 4500 Blackwell',
    gpuMemoryTotalMiB: 32623,
    llamaCppCommit: gemmaManifest.llamaCpp.knownGoodCommit
  });
  assert.equal(hiddenContention.ok, false);
  assert.equal(hiddenContention.errors.includes('contended_gpu'), true);
});
