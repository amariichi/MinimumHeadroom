import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const repoRoot = process.cwd();
const launcher = path.join(repoRoot, 'examples/rmh-voice-mode/start-rmh.sh');

async function runLauncherWithFakeCodex(extraEnv = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rmh-start-codex-'));
  const fakeCodex = path.join(tmp, 'codex');
  const output = path.join(tmp, 'argv.json');
  await writeFile(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.RMH_FAKE_CODEX_ARGV, JSON.stringify({
  argv: process.argv.slice(2),
  env: {
    CODEX_HOME: process.env.CODEX_HOME || null,
    MH_SITUATION_INJECT: process.env.MH_SITUATION_INJECT || null,
    MH_VISION_COMPANION: process.env.MH_VISION_COMPANION || null
  }
}, null, 2));
`, 'utf8');
  await chmod(fakeCodex, 0o755);

  const child = spawn(launcher, ['--agent', 'codex', '--model', 'test-model'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${tmp}${path.delimiter}${process.env.PATH}`,
      CODEX_HOME: '/tmp/rmh-existing-codex-home',
      RMH_FAKE_CODEX_ARGV: output
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  try {
    assert.equal(code, 0, `stdout=${stdout}\nstderr=${stderr}`);
    const captured = JSON.parse(await readFile(output, 'utf8'));
    return captured;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

test('start-rmh codex keeps normal CODEX_HOME and adds UserPromptSubmit only when situation injection is enabled', async () => {
  const withInjection = await runLauncherWithFakeCodex({
    MH_SITUATION_INJECT: '1',
    MH_VISION_COMPANION: '1'
  });
  assert.equal(withInjection.env.CODEX_HOME, '/tmp/rmh-existing-codex-home');
  assert.equal(withInjection.env.MH_SITUATION_INJECT, '1');
  assert.ok(withInjection.argv.some((arg) => arg.includes('hooks.UserPromptSubmit')));
  assert.ok(withInjection.argv.some((arg) => arg.includes('scripts/situation-context-hook-codex.mjs')));

  const withoutInjection = await runLauncherWithFakeCodex({
    MH_SITUATION_INJECT: '0',
    MH_VISION_COMPANION: '0'
  });
  assert.equal(withoutInjection.env.CODEX_HOME, '/tmp/rmh-existing-codex-home');
  assert.equal(withoutInjection.env.MH_SITUATION_INJECT, '0');
  assert.equal(withoutInjection.argv.some((arg) => arg.includes('hooks.UserPromptSubmit')), false);
});
