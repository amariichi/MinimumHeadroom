import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const repoRoot = process.cwd();
const launcher = path.join(repoRoot, 'examples/rmh-voice-mode/start-rmh.sh');

async function runLauncherWithFakeClaude(extraEnv = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rmh-start-claude-'));
  const fakeClaude = path.join(tmp, 'claude');
  const output = path.join(tmp, 'argv.json');
  await writeFile(fakeClaude, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const argValue = (name) => {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : null;
};
const mcpConfigPath = argValue('--mcp-config');
const settingsPath = argValue('--settings');
writeFileSync(process.env.RMH_FAKE_CLAUDE_ARGV, JSON.stringify({
  argv,
  cwd: process.cwd(),
  env: {
    MH_SITUATION_INJECT: process.env.MH_SITUATION_INJECT || null,
    MH_VISION_COMPANION: process.env.MH_VISION_COMPANION || null,
    VISION_BASE_URL: process.env.VISION_BASE_URL || null
  },
  mcpConfig: mcpConfigPath ? JSON.parse(readFileSync(mcpConfigPath, 'utf8')) : null,
  settings: settingsPath ? JSON.parse(readFileSync(settingsPath, 'utf8')) : null
}, null, 2));
`, 'utf8');
  await chmod(fakeClaude, 0o755);

  const child = spawn(launcher, ['--agent', 'claude', '--model', 'test-haiku'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraEnv,
      PATH: `${tmp}${path.delimiter}${process.env.PATH}`,
      RMH_FAKE_CLAUDE_ARGV: output
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
    return JSON.parse(await readFile(output, 'utf8'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

test('start-rmh claude passes generated MCP config and settings hooks', async () => {
  const captured = await runLauncherWithFakeClaude({
    MH_SITUATION_INJECT: '1',
    MH_VISION_COMPANION: '1',
    VISION_BASE_URL: 'http://127.0.0.1:8095'
  });

  assert.equal(captured.cwd, path.join(repoRoot, 'examples/rmh-voice-mode'));
  assert.equal(captured.env.MH_SITUATION_INJECT, '1');
  assert.equal(captured.env.MH_VISION_COMPANION, '1');
  assert.equal(captured.env.VISION_BASE_URL, 'http://127.0.0.1:8095');
  assert.ok(captured.argv.includes('--mcp-config'));
  assert.ok(captured.argv.includes('--settings'));
  assert.deepEqual(captured.argv.slice(-2), ['--model', 'test-haiku']);

  const server = captured.mcpConfig.mcpServers['minimum-headroom'];
  assert.equal(server.command, path.join(repoRoot, 'scripts/run-bound-mcp-server.sh'));
  assert.equal(server.env.VISION_BASE_URL, 'http://127.0.0.1:8095');
  assert.equal(server.env.MCP_TOOL_NAME_STYLE, 'underscore');

  const hooks = captured.settings.hooks;
  assert.equal(
    hooks.Notification[0].hooks[0].command,
    `${path.join(repoRoot, 'scripts/mh-hook.mjs')} --runtime claude --event permission_required`
  );
  assert.equal(
    hooks.Stop[0].hooks[0].command,
    `${path.join(repoRoot, 'scripts/mh-hook.mjs')} --runtime claude --event idle_after_response`
  );
  assert.equal(
    hooks.UserPromptSubmit[0].hooks[0].command,
    path.join(repoRoot, 'scripts/situation-context-hook.sh')
  );
});
