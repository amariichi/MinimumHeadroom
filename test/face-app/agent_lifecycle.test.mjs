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
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
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
      if (command === 'tmux' && args[0] === 'display-message') {
        return { stdout: `${args[3]}\n`, stderr: '', code: 0 };
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

test('agent lifecycle runtime blocks deleting worktree outside managed root by default', async () => {
  const { repoRoot, runtime } = createRuntimeHarness();
  const externalDir = createTempRoot('mh-agent-external-delete-');

  await runtime.addAgent({
    id: 'agent-delete',
    create_worktree: false,
    create_tmux: false,
    worktree_path: externalDir
  });

  await assert.rejects(
    () => runtime.dispatchAgentAction('agent-delete', 'delete-worktree', {}),
    (error) => error?.code === 'external_delete_forbidden'
  );

  cleanup(repoRoot);
  cleanup(externalDir);
});

test('agent lifecycle runtime delete-worktree only requires pane detachment', async () => {
  const { repoRoot, runtime, commands } = createRuntimeHarness();
  const managedWorktree = path.join(repoRoot, '.agent/worktrees/agent-worktree-only');
  fs.mkdirSync(managedWorktree, { recursive: true });

  await runtime.addAgent({
    id: 'agent-worktree-only',
    create_worktree: false,
    create_tmux: false,
    worktree_path: managedWorktree,
    source_repo_path: repoRoot
  });

  const result = await runtime.dispatchAgentAction('agent-worktree-only', 'delete-worktree', {});
  assert.equal(result.ok, true);
  assert.equal(result.action, 'delete-worktree');
  assert.equal(result.noop, false);
  assert.equal(result.deleted_path, managedWorktree);
  assert.equal(result.agent?.worktree_path, null);
  assert.equal(
    commands.some((entry) => entry[0] === 'git' && entry[3] === 'worktree' && entry[4] === 'prune'),
    true
  );

  cleanup(repoRoot);
});

test('agent lifecycle runtime records delete-worktree noop message when path is absent', async () => {
  const { repoRoot, runtime, commands } = createRuntimeHarness();
  const missingWorktreePath = path.join(repoRoot, '.agent/worktrees/agent-delete-noop');
  fs.mkdirSync(missingWorktreePath, { recursive: true });

  await runtime.addAgent({
    id: 'agent-delete-noop',
    create_worktree: false,
    create_tmux: false,
    worktree_path: missingWorktreePath
  });
  fs.rmSync(missingWorktreePath, { recursive: true, force: true });

  const result = await runtime.dispatchAgentAction('agent-delete-noop', 'delete-worktree', {});
  assert.equal(result.ok, true);
  assert.equal(result.action, 'delete-worktree');
  assert.equal(result.noop, true);
  assert.equal(result.agent?.last_message, 'worktree already absent');
  assert.equal(
    commands.some((entry) => entry[0] === 'git' && entry[3] === 'worktree' && entry[4] === 'prune'),
    true
  );

  cleanup(repoRoot);
});

test('agent lifecycle runtime delete action detaches pane, deletes worktree, and purges agent', async () => {
  const { repoRoot, runtime, commands } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message' && args[3] === '%92') {
        return { stdout: '%92\n', stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'kill-pane') {
        return { stdout: '', stderr: '', code: 0 };
      }
      if (command === 'git' && args[1] === 'worktree' && args[2] === 'remove') {
        return { stdout: '', stderr: '', code: 0 };
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
  const managedWorktree = path.join(repoRoot, '.agent/worktrees/agent-delete-all');
  fs.mkdirSync(managedWorktree, { recursive: true });

  await runtime.addAgent({
    id: 'agent-delete-all',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%92',
    worktree_path: managedWorktree,
    source_repo_path: repoRoot
  });

  const result = await runtime.dispatchAgentAction('agent-delete-all', 'delete', {});
  assert.equal(result.ok, true);
  assert.equal(result.action, 'delete');
  assert.equal(result.agent?.id, 'agent-delete-all');
  assert.equal(result.deleted_path, managedWorktree);
  assert.equal(runtime.getState().agents.some((agent) => agent.id === 'agent-delete-all'), false);
  assert.equal(
    commands.some((entry) => entry[0] === 'tmux' && entry[1] === 'display-message' && entry[4] === '%92'),
    true
  );
  assert.equal(
    commands.some((entry) => entry[0] === 'tmux' && entry[1] === 'kill-pane' && entry[3] === '%92'),
    true
  );
  assert.equal(
    commands.some(
      (entry) => entry[0] === 'git' && entry[3] === 'worktree' && entry[4] === 'remove' && entry[6] === managedWorktree
    ),
    true
  );
  assert.equal(
    commands.some((entry) => entry[0] === 'git' && entry[3] === 'worktree' && entry[4] === 'prune'),
    true
  );

  cleanup(repoRoot);
});

test('agent lifecycle runtime delete action marks stale pane as missing before purge', async () => {
  const { repoRoot, runtime, commands } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message' && args[3] === '%93') {
        const error = new Error('pane not found');
        error.code = 'command_failed';
        throw error;
      }
      if (command === 'git' && args[1] === 'worktree' && args[2] === 'remove') {
        return { stdout: '', stderr: '', code: 0 };
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
  const managedWorktree = path.join(repoRoot, '.agent/worktrees/agent-delete-stale');
  fs.mkdirSync(managedWorktree, { recursive: true });

  await runtime.addAgent({
    id: 'agent-delete-stale',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%93',
    worktree_path: managedWorktree,
    source_repo_path: repoRoot
  });

  const result = await runtime.dispatchAgentAction('agent-delete-stale', 'delete', {});
  assert.equal(result.ok, true);
  assert.equal(result.action, 'delete');
  assert.equal(runtime.getState().agents.some((agent) => agent.id === 'agent-delete-stale'), false);
  assert.equal(
    commands.some((entry) => entry[0] === 'tmux' && entry[1] === 'kill-pane' && entry[3] === '%93'),
    false
  );

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

test('agent lifecycle runtime focus marks agent missing when pane id is absent', async () => {
  const { repoRoot, runtime } = createRuntimeHarness();
  await runtime.addAgent({
    id: 'agent-focus-missing',
    create_worktree: false,
    create_tmux: false,
    pane_id: null
  });

  await assert.rejects(
    () => runtime.dispatchAgentAction('agent-focus-missing', 'focus', {}),
    (error) => error?.code === 'invalid_state'
  );

  const agent = runtime.getState().agents.find((item) => item.id === 'agent-focus-missing');
  assert.equal(agent?.status, 'missing');
  assert.equal(agent?.last_message, 'pane missing');

  cleanup(repoRoot);
});

test('agent lifecycle runtime focus marks agent missing when pane is stale', async () => {
  const { repoRoot, runtime } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message' && args[3] === '%99') {
        const error = new Error('pane not found');
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
    id: 'agent-focus-stale',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%99'
  });

  await assert.rejects(
    () => runtime.dispatchAgentAction('agent-focus-stale', 'focus', {}),
    (error) => error?.code === 'invalid_state' && /pane is unavailable/.test(error.message)
  );

  const agent = runtime.getState().agents.find((item) => item.id === 'agent-focus-stale');
  assert.equal(agent?.status, 'missing');
  assert.equal(agent?.pane_id, null);
  assert.equal(agent?.last_message, 'pane missing');

  cleanup(repoRoot);
});

test('agent lifecycle runtime reconcile recreates helper panes from existing worktrees', async () => {
  const { repoRoot, runtime, commands } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message' && args[3] === '%101') {
        const error = new Error('pane not found');
        error.code = 'command_failed';
        throw error;
      }
      if (command === 'tmux' && args[0] === 'list-windows') {
        return { stdout: 'operator\n', stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'new-window') {
        return { stdout: '%145\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
  });
  const managedWorktree = path.join(repoRoot, '.agent/worktrees/agent-recreate');
  fs.mkdirSync(managedWorktree, { recursive: true });

  await runtime.addAgent({
    id: 'agent-recreate',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%101',
    worktree_path: managedWorktree
  });

  const reconcile = await runtime.reconcileAgents();
  const record = reconcile.results.find((item) => item.agent_id === 'agent-recreate');
  assert.equal(record?.disposition, 'recreated');
  assert.equal(record?.pane_id, '%145');

  const agent = runtime.getState().agents.find((item) => item.id === 'agent-recreate');
  assert.equal(agent?.status, 'active');
  assert.equal(agent?.pane_id, '%145');
  assert.equal(agent?.last_message, 'agent restored after startup');
  assert.equal(
    commands.some((entry) => entry[0] === 'tmux' && entry[1] === 'new-window'),
    true
  );

  cleanup(repoRoot);
});

test('agent lifecycle runtime reconcile marks helper missing when worktree is gone', async () => {
  const { repoRoot, runtime } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message' && args[3] === '%102') {
        const error = new Error('pane not found');
        error.code = 'command_failed';
        throw error;
      }
      if (command === 'tmux' && args[0] === 'list-windows') {
        return { stdout: 'operator\n', stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'new-window') {
        return { stdout: '%146\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
  });
  const missingWorktree = path.join(repoRoot, '.agent/worktrees/agent-missing');
  fs.mkdirSync(missingWorktree, { recursive: true });

  await runtime.addAgent({
    id: 'agent-missing',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%102',
    worktree_path: missingWorktree
  });
  fs.rmSync(missingWorktree, { recursive: true, force: true });

  const reconcile = await runtime.reconcileAgents();
  const record = reconcile.results.find((item) => item.agent_id === 'agent-missing');
  assert.equal(record?.disposition, 'missing');
  assert.equal(record?.reason, 'worktree_missing');

  const agent = runtime.getState().agents.find((item) => item.id === 'agent-missing');
  assert.equal(agent?.status, 'missing');
  assert.equal(agent?.pane_id, null);
  assert.equal(agent?.last_message, 'worktree missing');

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

test('agent lifecycle api surfaces focus validation failure for stale pane', async () => {
  const { repoRoot, runtime } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message' && args[3] === '%77') {
        const error = new Error('pane not found');
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
    id: 'agent-http-focus',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%77'
  });

  const focusReq = createRequest({
    method: 'POST',
    url: '/api/agents/agent-http-focus/focus',
    body: {}
  });
  const focusRes = createResponseCapture();
  const handled = await api.handleHttpRequest(focusReq, focusRes);
  assert.equal(handled, true);
  const snapshot = focusRes.snapshot();
  assert.equal(snapshot.statusCode, 409);
  assert.equal(snapshot.body?.ok, false);
  assert.equal(snapshot.body?.error, 'invalid_state');
  assert.match(snapshot.body?.detail ?? '', /pane is unavailable/);

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

test('agent lifecycle api returns delete success and purged state', async () => {
  const { repoRoot, runtime } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message' && args[3] === '%98') {
        return { stdout: '%98\n', stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'kill-pane') {
        return { stdout: '', stderr: '', code: 0 };
      }
      if (command === 'git' && args[1] === 'worktree' && args[2] === 'remove') {
        return { stdout: '', stderr: '', code: 0 };
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
  const managedWorktree = path.join(repoRoot, '.agent/worktrees/agent-http-delete');
  fs.mkdirSync(managedWorktree, { recursive: true });

  await runtime.addAgent({
    id: 'agent-http-delete',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%98',
    worktree_path: managedWorktree,
    source_repo_path: repoRoot
  });

  const deleteReq = createRequest({
    method: 'POST',
    url: '/api/agents/agent-http-delete/delete',
    body: {}
  });
  const deleteRes = createResponseCapture();
  const handled = await api.handleHttpRequest(deleteReq, deleteRes);
  assert.equal(handled, true);
  const snapshot = deleteRes.snapshot();
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.body?.ok, true);
  assert.equal(snapshot.body?.result?.action, 'delete');
  assert.equal(snapshot.body?.result?.agent?.id, 'agent-http-delete');
  assert.equal(snapshot.body?.result?.state?.agents?.some((agent) => agent.id === 'agent-http-delete'), false);

  cleanup(repoRoot);
});
