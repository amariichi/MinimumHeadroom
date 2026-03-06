import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createAgentRuntimeStateStore } from '../../face-app/dist/agent_runtime_state.js';
import { createAgentLifecycleApi, createAgentLifecycleRuntime } from '../../face-app/dist/agent_lifecycle.js';

const quietLog = {
  info() {},
  warn() {},
  error() {}
};

function createTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createClock(start = 1_700_000_000_000) {
  let tick = start;
  return () => {
    tick += 10;
    return tick;
  };
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function createRequest({ method, url, body }) {
  const payload =
    body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(payload.length > 0 ? [payload] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    'content-type': 'application/json; charset=utf-8'
  };
  return stream;
}

function createResponseCapture() {
  let statusCode = null;
  let headers = null;
  let rawBody = '';

  return {
    writableEnded: false,
    writeHead(nextStatusCode, nextHeaders) {
      statusCode = nextStatusCode;
      headers = nextHeaders;
    },
    end(chunk = '') {
      rawBody += String(chunk ?? '');
      this.writableEnded = true;
    },
    snapshot() {
      return {
        statusCode,
        headers,
        rawBody,
        body: rawBody === '' ? null : JSON.parse(rawBody)
      };
    }
  };
}

function createRuntimeHarness(options = {}) {
  const repoRoot = createTempRoot('mh-agent-lifecycle-runtime-');
  const statePath = path.join(repoRoot, '.agent/runtime/agents-state.json');
  const stateStore = createAgentRuntimeStateStore({
    repoRoot,
    statePath,
    now: createClock(),
    log: quietLog
  });
  stateStore.load();

  const commands = [];
  const focusCalls = [];
  const externalCommandRunner = typeof options.commandRunner === 'function' ? options.commandRunner : null;
  const runtime = createAgentLifecycleRuntime({
    stateStore,
    repoRoot,
    tmuxEnabled: options.tmuxEnabled ?? true,
    worktreeEnabled: options.worktreeEnabled ?? true,
    allowExternalDelete: options.allowExternalDelete ?? false,
    commandRunner: async (command, args) => {
      commands.push([command, ...args]);
      if (externalCommandRunner) {
        return externalCommandRunner(command, args);
      }
      if (command === 'tmux' && args[0] === 'list-windows') {
        return { stdout: 'operator\n', stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'new-window') {
        return { stdout: '%45\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
    async onFocus(payload) {
      focusCalls.push(payload);
    },
    log: quietLog
  });

  return { repoRoot, stateStore, runtime, commands, focusCalls };
}

test('agent lifecycle runtime adds agent without worktree/tmux orchestration', async () => {
  const { repoRoot, runtime } = createRuntimeHarness();

  const result = await runtime.addAgent({
    id: 'agent-a',
    create_worktree: false,
    create_tmux: false,
    source_repo_path: repoRoot
  });

  assert.equal(result.ok, true);
  assert.equal(result.agent.id, 'agent-a');
  assert.equal(result.agent.status, 'active');
  assert.equal(result.orchestration.worktree_created, false);
  assert.equal(result.orchestration.pane_created, false);
  assert.equal(result.agent.branch.startsWith('agent/agent-a/'), true);

  cleanup(repoRoot);
});

test('agent lifecycle runtime stop action kills pane and marks stopped', async () => {
  const { repoRoot, runtime, commands } = createRuntimeHarness();

  await runtime.addAgent({
    id: 'agent-stop',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%88'
  });

  const result = await runtime.dispatchAgentAction('agent-stop', 'stop', {
    kill_pane: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'stop');
  assert.equal(result.orchestration.pane_killed, true);
  assert.equal(
    commands.some((entry) => entry[0] === 'tmux' && entry[1] === 'kill-pane' && entry[3] === '%88'),
    true
  );

  const state = runtime.getState();
  const agent = state.agents.find((item) => item.id === 'agent-stop');
  assert.equal(agent?.status, 'stopped');
  assert.equal(agent?.pane_id, null);
  assert.equal(agent?.last_message, 'stopped');

  cleanup(repoRoot);
});

test('agent lifecycle runtime stop action reports partial success when pane kill fails', async () => {
  const { repoRoot, runtime, commands } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'kill-pane') {
        const error = new Error('kill-pane failed');
        error.code = 'command_failed';
        throw error;
      }
      if (command === 'tmux' && args[0] === 'list-windows') {
        return { stdout: 'operator\n', stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'new-window') {
        return { stdout: '%45\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
  });

  await runtime.addAgent({
    id: 'agent-stop-fail',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%89'
  });

  const result = await runtime.dispatchAgentAction('agent-stop-fail', 'stop', {
    kill_pane: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'stop');
  assert.equal(result.orchestration.pane_killed, false);
  assert.equal(typeof result.orchestration.pane_kill_error, 'string');
  assert.equal(
    commands.some((entry) => entry[0] === 'tmux' && entry[1] === 'kill-pane' && entry[3] === '%89'),
    true
  );

  const state = runtime.getState();
  const agent = state.agents.find((item) => item.id === 'agent-stop-fail');
  assert.equal(agent?.status, 'stopped');
  assert.equal(agent?.pane_id, '%89');
  assert.equal(agent?.last_message, 'stopped; pane still attached');

  cleanup(repoRoot);
});

test('agent lifecycle runtime blocks deleting worktree outside managed root by default', async () => {
  const { repoRoot, runtime } = createRuntimeHarness();
  const externalDir = createTempRoot('mh-agent-external-delete-');

  await runtime.addAgent({
    id: 'agent-delete',
    create_worktree: false,
    create_tmux: false,
    worktree_path: externalDir
  });
  await runtime.dispatchAgentAction('agent-delete', 'remove', {});

  await assert.rejects(
    () => runtime.dispatchAgentAction('agent-delete', 'delete-worktree', {}),
    (error) => error?.code === 'external_delete_forbidden'
  );

  cleanup(repoRoot);
  cleanup(externalDir);
});

test('agent lifecycle runtime requires removed/stopped before delete-worktree', async () => {
  const { repoRoot, runtime } = createRuntimeHarness();

  await runtime.addAgent({
    id: 'agent-active-delete',
    create_worktree: false,
    create_tmux: false
  });

  await assert.rejects(
    () => runtime.dispatchAgentAction('agent-active-delete', 'delete-worktree', {}),
    (error) => error?.code === 'invalid_state'
  );

  cleanup(repoRoot);
});

test('agent lifecycle runtime records delete-worktree noop message when path is absent', async () => {
  const { repoRoot, runtime } = createRuntimeHarness();
  const missingWorktreePath = path.join(repoRoot, '.agent/worktrees/agent-delete-noop');
  fs.mkdirSync(missingWorktreePath, { recursive: true });

  await runtime.addAgent({
    id: 'agent-delete-noop',
    create_worktree: false,
    create_tmux: false,
    worktree_path: missingWorktreePath
  });
  fs.rmSync(missingWorktreePath, { recursive: true, force: true });
  await runtime.dispatchAgentAction('agent-delete-noop', 'remove', {});
  const result = await runtime.dispatchAgentAction('agent-delete-noop', 'delete-worktree', {});

  assert.equal(result.ok, true);
  assert.equal(result.action, 'delete-worktree');
  assert.equal(result.noop, true);
  assert.equal(result.agent?.last_message, 'worktree already absent');

  cleanup(repoRoot);
});

test('agent lifecycle runtime focus action emits focus callback and updates message', async () => {
  const { repoRoot, runtime, focusCalls } = createRuntimeHarness();
  await runtime.addAgent({
    id: 'agent-focus',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%91',
    session_id: 'session-focus'
  });

  const result = await runtime.dispatchAgentAction('agent-focus', 'focus', {
    session_id: 'session-focus'
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'focus');
  assert.equal(result.focus.pane_id, '%91');
  assert.equal(result.focus.session_id, 'session-focus');
  assert.equal(focusCalls.length, 1);
  assert.equal(focusCalls[0].agentId, 'agent-focus');
  assert.equal(focusCalls[0].paneId, '%91');

  cleanup(repoRoot);
});

test('agent lifecycle api serves state and add endpoints', async () => {
  const { repoRoot, runtime } = createRuntimeHarness();
  const api = createAgentLifecycleApi({ runtime });

  const stateReq = createRequest({
    method: 'GET',
    url: '/api/agents/state'
  });
  const stateRes = createResponseCapture();
  const stateHandled = await api.handleHttpRequest(stateReq, stateRes);

  assert.equal(stateHandled, true);
  const stateSnapshot = stateRes.snapshot();
  assert.equal(stateSnapshot.statusCode, 200);
  assert.equal(stateSnapshot.body?.ok, true);
  assert.equal(Array.isArray(stateSnapshot.body?.state?.agents), true);

  const addReq = createRequest({
    method: 'POST',
    url: '/api/agents/add',
    body: {
      id: 'agent-http',
      create_worktree: false,
      create_tmux: false
    }
  });
  const addRes = createResponseCapture();
  const addHandled = await api.handleHttpRequest(addReq, addRes);
  assert.equal(addHandled, true);
  const addSnapshot = addRes.snapshot();
  assert.equal(addSnapshot.statusCode, 200);
  assert.equal(addSnapshot.body?.ok, true);
  assert.equal(addSnapshot.body?.result?.agent?.id, 'agent-http');

  const stateAfter = runtime.getState();
  assert.equal(stateAfter.agents.some((agent) => agent.id === 'agent-http'), true);

  const listReq = createRequest({
    method: 'GET',
    url: '/api/agents?include_removed=1'
  });
  const listRes = createResponseCapture();
  const listHandled = await api.handleHttpRequest(listReq, listRes);
  assert.equal(listHandled, true);
  const listSnapshot = listRes.snapshot();
  assert.equal(listSnapshot.statusCode, 200);
  assert.equal(Array.isArray(listSnapshot.body?.agents), true);
  assert.equal(listSnapshot.body?.agents.some((agent) => agent.id === 'agent-http'), true);

  cleanup(repoRoot);
});

test('agent lifecycle api returns stop partial orchestration details', async () => {
  const { repoRoot, runtime } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'kill-pane') {
        const error = new Error('kill-pane failed');
        error.code = 'command_failed';
        throw error;
      }
      if (command === 'tmux' && args[0] === 'list-windows') {
        return { stdout: 'operator\n', stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'new-window') {
        return { stdout: '%45\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
  });
  const api = createAgentLifecycleApi({ runtime });

  await runtime.addAgent({
    id: 'agent-http-stop',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%77'
  });

  const stopReq = createRequest({
    method: 'POST',
    url: '/api/agents/agent-http-stop/stop',
    body: {
      kill_pane: true
    }
  });
  const stopRes = createResponseCapture();
  const handled = await api.handleHttpRequest(stopReq, stopRes);
  assert.equal(handled, true);
  const snapshot = stopRes.snapshot();
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.body?.ok, true);
  assert.equal(snapshot.body?.result?.orchestration?.pane_killed, false);
  assert.equal(typeof snapshot.body?.result?.orchestration?.pane_kill_error, 'string');
  assert.equal(snapshot.body?.result?.agent?.last_message, 'stopped; pane still attached');

  cleanup(repoRoot);
});

test('agent lifecycle api returns delete-worktree noop message', async () => {
  const { repoRoot, runtime } = createRuntimeHarness();
  const api = createAgentLifecycleApi({ runtime });
  const missingWorktreePath = path.join(repoRoot, '.agent/worktrees/agent-http-delete-noop');
  fs.mkdirSync(missingWorktreePath, { recursive: true });

  await runtime.addAgent({
    id: 'agent-http-delete-noop',
    create_worktree: false,
    create_tmux: false,
    worktree_path: missingWorktreePath
  });
  fs.rmSync(missingWorktreePath, { recursive: true, force: true });

  const removeReq = createRequest({
    method: 'POST',
    url: '/api/agents/agent-http-delete-noop/remove',
    body: {}
  });
  const removeRes = createResponseCapture();
  await api.handleHttpRequest(removeReq, removeRes);

  const deleteReq = createRequest({
    method: 'POST',
    url: '/api/agents/agent-http-delete-noop/delete-worktree',
    body: {}
  });
  const deleteRes = createResponseCapture();
  const handled = await api.handleHttpRequest(deleteReq, deleteRes);
  assert.equal(handled, true);
  const snapshot = deleteRes.snapshot();
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.body?.ok, true);
  assert.equal(snapshot.body?.result?.noop, true);
  assert.equal(snapshot.body?.result?.agent?.last_message, 'worktree already absent');

  cleanup(repoRoot);
});
