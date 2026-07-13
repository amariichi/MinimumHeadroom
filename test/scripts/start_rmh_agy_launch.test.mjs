import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const repoRoot = process.cwd();
const launcher = path.join(repoRoot, 'examples/rmh-voice-mode/start-rmh.sh');

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runLauncher(args, env) {
  const child = spawn(launcher, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
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
  return { code, stdout, stderr };
}

test('start-rmh agy syncs rendered plugin into the CLI plugin directory', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rmh-start-agy-'));
  const fakeBinDir = path.join(tmp, 'bin');
  const fakeAgy = path.join(fakeBinDir, 'agy');
  const fakeHome = path.join(tmp, 'home');
  const callsPath = path.join(tmp, 'agy-calls.jsonl');
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(fakeAgy, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.RMH_FAKE_AGY_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
`, 'utf8');
  await chmod(fakeAgy, 0o755);

  const sharedOps = path.join(fakeHome, '.agents/skills/minimum-headroom-ops/SKILL.md');
  const sharedVision = path.join(fakeHome, '.agents/skills/atoms3r-vision/SKILL.md');
  await mkdir(path.dirname(sharedOps), { recursive: true });
  await mkdir(path.dirname(sharedVision), { recursive: true });
  await writeFile(sharedOps, 'canonical minimum-headroom-ops\n', 'utf8');
  await writeFile(sharedVision, 'canonical atoms3r-vision\n', 'utf8');

  const result = await runLauncher(
    ['--agent', 'agy', '--model', 'Gemini 3.5 Flash (Low)'],
    {
      HOME: fakeHome,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      RMH_FAKE_AGY_CALLS: callsPath
    }
  );
  try {
    assert.equal(result.code, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    const cliPlugin = path.join(fakeHome, '.gemini/antigravity-cli/plugins/minimum-headroom');
    assert.equal(await exists(path.join(cliPlugin, 'mcp_config.json')), true);
    assert.equal(await exists(path.join(cliPlugin, 'hooks.json')), true);
    assert.equal(await exists(path.join(cliPlugin, 'skills/minimum-headroom-ops/SKILL.md')), true);
    assert.equal(await exists(path.join(cliPlugin, 'skills/atoms3r-vision/SKILL.md')), true);
    assert.equal(
      await readFile(path.join(cliPlugin, 'skills/minimum-headroom-ops/SKILL.md'), 'utf8'),
      'canonical minimum-headroom-ops\n'
    );
    assert.equal(
      await readFile(path.join(cliPlugin, 'skills/atoms3r-vision/SKILL.md'), 'utf8'),
      'canonical atoms3r-vision\n'
    );

    // The situation digest must reach agy via its PreInvocation hook: without
    // this registration agy gets no camera context at all (claude/codex use
    // UserPromptSubmit hooks instead).
    const hooks = JSON.parse(await readFile(path.join(cliPlugin, 'hooks.json'), 'utf8'));
    const situation = hooks['minimum-headroom-situation'];
    assert.ok(situation, 'hooks.json must register minimum-headroom-situation');
    assert.equal(situation.PreInvocation.length, 1);
    assert.equal(
      situation.PreInvocation[0].command,
      path.join(repoRoot, 'scripts/situation-context-hook-agy.mjs')
    );
    assert.equal(
      hooks['minimum-headroom-helper-policy'],
      undefined,
      'the helper-only policy must not be installed in the global operator plugin'
    );

    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.some((argv) => argv[0] === 'plugin' && argv[1] === 'install'), true);
    assert.deepEqual(calls.at(-1), ['--model', 'Gemini 3.5 Flash (Low)']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('start-rmh agy falls back to bundled skills and does not invent a model', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rmh-start-agy-fallback-'));
  const fakeBinDir = path.join(tmp, 'bin');
  const fakeAgy = path.join(fakeBinDir, 'agy');
  const fakeHome = path.join(tmp, 'home');
  const callsPath = path.join(tmp, 'agy-calls.jsonl');
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(fakeAgy, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.RMH_FAKE_AGY_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
`, 'utf8');
  await chmod(fakeAgy, 0o755);

  const result = await runLauncher(['--agent', 'agy'], {
    HOME: fakeHome,
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
    RMH_FAKE_AGY_CALLS: callsPath
  });
  try {
    assert.equal(result.code, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    const installed = path.join(
      fakeHome,
      '.gemini/antigravity-cli/plugins/minimum-headroom/skills/minimum-headroom-ops/SKILL.md'
    );
    assert.equal(
      await readFile(installed, 'utf8'),
      await readFile(path.join(repoRoot, 'doc/examples/skills/minimum-headroom-ops/SKILL.md'), 'utf8')
    );
    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.at(-1), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('start-rmh agy setup-only synchronizes the plugin without opening the TUI', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rmh-start-agy-setup-'));
  const fakeBinDir = path.join(tmp, 'bin');
  const fakeAgy = path.join(fakeBinDir, 'agy');
  const fakeHome = path.join(tmp, 'home');
  const callsPath = path.join(tmp, 'agy-calls.jsonl');
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(fakeAgy, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.RMH_FAKE_AGY_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
`, 'utf8');
  await chmod(fakeAgy, 0o755);

  const result = await runLauncher(['--agent', 'agy', '--setup-only'], {
    HOME: fakeHome,
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
    RMH_FAKE_AGY_CALLS: callsPath
  });
  try {
    assert.equal(result.code, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /setup-only complete/);
    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'plugin');
    assert.equal(calls[0][1], 'install');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
