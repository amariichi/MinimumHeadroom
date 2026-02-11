import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadFaceAppConfig, mapSpeechGateConfig, mapTtsConfig } from '../../face-app/dist/config_loader.js';

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('loadFaceAppConfig reads speech_gate overrides from config.yaml', () => {
  const tempDir = createTempDir('mh-config-loader-');
  const configPath = path.join(tempDir, 'config.yaml');

  fs.writeFileSync(
    configPath,
    [
      'tts:',
      '  default_ttl_ms: 42000',
      '  auto_interrupt_after_ms: 2500',
      'speech_gate:',
      '  min_interval_priority1_ms: 1200',
      '  global_window_ms: 45000',
      '  global_limit_low_priority: 40',
      '  session_window_ms: 45000',
      '  session_limit_low_priority: 16',
      '  dedupe_ms_low_priority: 500'
    ].join('\n'),
    'utf8'
  );

  const result = loadFaceAppConfig({
    configPath,
    log: { info: () => {}, warn: () => {} },
    env: {}
  });

  assert.equal(result.loaded, true);
  assert.deepEqual(result.tts, {
    defaultTtlMs: 42000,
    autoInterruptAfterMs: 2500
  });
  assert.deepEqual(result.speechGate, {
    minIntervalPriority1Ms: 1200,
    globalWindowMs: 45000,
    globalLimitLowPriority: 40,
    sessionWindowMs: 45000,
    sessionLimitLowPriority: 16,
    dedupeMsLowPriority: 500
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('loadFaceAppConfig falls back to defaults when file is missing', () => {
  const tempDir = createTempDir('mh-config-missing-');
  const configPath = path.join(tempDir, 'missing.yaml');
  const logs = [];

  const result = loadFaceAppConfig({
    configPath,
    log: {
      info(message) {
        logs.push(String(message));
      },
      warn: () => {}
    },
    env: {}
  });

  assert.equal(result.loaded, false);
  assert.deepEqual(result.tts, {});
  assert.deepEqual(result.speechGate, {});
  assert.equal(logs.some((line) => line.includes('using built-in defaults')), true);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('mapSpeechGateConfig accepts Japanese spec keys under 発話制御', () => {
  const mapped = mapSpeechGateConfig({
    発話制御: {
      priority1_最小間隔_ms: 2000,
      global_60s_上限: 18,
      session_60s_上限: 9,
      dedupe_ms: 700
    }
  });

  assert.deepEqual(mapped, {
    minIntervalPriority1Ms: 2000,
    globalLimitLowPriority: 18,
    sessionLimitLowPriority: 9,
    dedupeMsLowPriority: 700
  });
});

test('mapTtsConfig accepts TTS section aliases', () => {
  const mapped = mapTtsConfig({
    TTS: {
      TTL_ms: 90000,
      自動割り込み_ms: 1800
    }
  });

  assert.deepEqual(mapped, {
    defaultTtlMs: 90000,
    autoInterruptAfterMs: 1800
  });
});
