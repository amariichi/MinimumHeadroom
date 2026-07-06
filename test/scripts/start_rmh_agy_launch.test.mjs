import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

test('start-rmh agy syncs rendered plugin into the CLI plugin directory', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rmh-start-agy-'));
  const fakeBinDir = path.join(tmp, 'bin');
  const fakeAgy = path.join(fakeBinDir, 'agy');
  const fakeHome = path.join(tmp, 'home');
  const callsPath = path.join(tmp, 'agy-calls.jsonl');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(fakeBinDir, { recursive: true }));
  await writeFile(fakeAgy, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.RMH_FAKE_AGY_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
`, 'utf8');
  await chmod(fakeAgy, 0o755);

  const child = spawn(launcher, ['--agent', 'agy'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: fakeHome,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
      RMH_FAKE_AGY_CALLS: callsPath
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
    const cliPlugin = path.join(fakeHome, '.gemini/antigravity-cli/plugins/minimum-headroom');
    assert.equal(await exists(path.join(cliPlugin, 'mcp_config.json')), true);
    assert.equal(await exists(path.join(cliPlugin, 'hooks.json')), true);
    assert.equal(await exists(path.join(cliPlugin, 'skills/minimum-headroom-ops/SKILL.md')), true);
    assert.equal(await exists(path.join(cliPlugin, 'skills/atoms3r-vision/SKILL.md')), true);

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

    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.some((argv) => argv[0] === 'plugin' && argv[1] === 'install'), true);
    assert.deepEqual(calls.at(-1), []);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
