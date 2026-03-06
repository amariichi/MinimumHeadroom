import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    server.on('error', reject);
    server.on('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForHttpReady(url, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`face-app did not become ready: ${url}`);
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }
    const done = () => resolve();
    child.once('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 1200);
  });
}

async function startFaceAppE2e() {
  const port = await allocatePort();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-face-app-e2e-'));
  const statePath = path.join(stateRoot, 'agents-state.json');

  const child = spawn(process.execPath, ['face-app/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FACE_WS_HOST: '127.0.0.1',
      FACE_WS_PORT: String(port),
      FACE_WS_PATH: '/ws',
      FACE_TTS_ENABLED: '0',
      FACE_UI_MODE: 'pc',
      FACE_OPERATOR_PANEL_ENABLED: '1',
      MH_AGENT_STATE_PATH: statePath,
      MH_AGENT_TMUX_ENABLED: '0',
      MH_AGENT_WORKTREE_ENABLED: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.resume();
  child.stderr.resume();

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHttpReady(`${baseUrl}/api/operator/ui-config`);
  return { child, baseUrl, stateRoot };
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

test('face-app e2e serves operator UI config and dashboard markup', async () => {
  const { child, baseUrl, stateRoot } = await startFaceAppE2e();
  try {
    const configResponse = await fetch(`${baseUrl}/api/operator/ui-config`, {
      method: 'GET'
    });
    assert.equal(configResponse.ok, true);
    const configPayload = await configResponse.json();
    assert.equal(configPayload?.ok, true);
    assert.equal(configPayload?.uiMode, 'pc');
    assert.equal(configPayload?.operatorPanelEnabled, true);

    const htmlResponse = await fetch(`${baseUrl}/`, {
      method: 'GET'
    });
    assert.equal(htmlResponse.ok, true);
    const html = await htmlResponse.text();
    assert.match(html, /id="agent-dashboard"/);
    assert.match(html, /id="operator-agent-list"/);
  } finally {
    await stopChild(child);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('face-app e2e lifecycle HTTP flow updates state end to end', async () => {
  const { child, baseUrl, stateRoot } = await startFaceAppE2e();
  try {
    const add = await postJson(`${baseUrl}/api/agents/add`, {
      id: 'agent-e2e',
      create_worktree: false,
      create_tmux: false
    });
    assert.equal(add.response.status, 200);
    assert.equal(add.payload?.ok, true);

    const pause = await postJson(`${baseUrl}/api/agents/agent-e2e/pause`, {});
    assert.equal(pause.response.status, 200);
    assert.equal(pause.payload?.ok, true);

    const stateAfterPause = await fetch(`${baseUrl}/api/agents/state`, { method: 'GET' });
    assert.equal(stateAfterPause.ok, true);
    const pauseStatePayload = await stateAfterPause.json();
    const pausedAgent = pauseStatePayload?.state?.agents?.find((agent) => agent.id === 'agent-e2e');
    assert.equal(pausedAgent?.status, 'paused');

    const resume = await postJson(`${baseUrl}/api/agents/agent-e2e/resume`, {});
    assert.equal(resume.response.status, 200);
    assert.equal(resume.payload?.ok, true);

    const remove = await postJson(`${baseUrl}/api/agents/agent-e2e/remove`, {});
    assert.equal(remove.response.status, 200);
    assert.equal(remove.payload?.ok, true);

    const restore = await postJson(`${baseUrl}/api/agents/agent-e2e/restore`, {});
    assert.equal(restore.response.status, 200);
    assert.equal(restore.payload?.ok, true);

    const finalStateResponse = await fetch(`${baseUrl}/api/agents/state`, { method: 'GET' });
    const finalStatePayload = await finalStateResponse.json();
    const finalAgent = finalStatePayload?.state?.agents?.find((agent) => agent.id === 'agent-e2e');
    assert.equal(finalAgent?.status, 'active');
  } finally {
    await stopChild(child);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
