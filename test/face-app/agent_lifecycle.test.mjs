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
  const activeTargetRepoRoot = options.activeTargetRepoRoot ?? repoRoot;
  const activeStreamId = options.activeStreamId ?? `repo:${activeTargetRepoRoot}`;
  const stateStore = createAgentRuntimeStateStore({
    repoRoot,
    statePath,
    activeTargetRepoRoot,
    activeStreamId,
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
    activeTargetRepoRoot,
    activeStreamId,
    defaultSourceRepoPath: options.defaultSourceRepoPath ?? '',
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

test('agent lifecycle runtime inherits default external source repo path for helpers', async () => {
  const externalRepoRoot = createTempRoot('mh-agent-external-source-');
  const { repoRoot, runtime, commands } = createRuntimeHarness({
    defaultSourceRepoPath: externalRepoRoot,
    commandRunner: async (command, args) => {
      if (command === 'git' && args[1] === 'rev-parse') {
        return { stdout: 'true\n', stderr: '', code: 0 };
      }
      if (command === 'git' && args[1] === 'worktree' && args[2] === 'add') {
        return { stdout: '', stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'list-windows') {
        return { stdout: 'operator\n', stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'new-window') {
        return { stdout: '%51\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
  });

  const result = await runtime.addAgent({
    id: 'agent-external-default',
    create_tmux: false
  });

  assert.equal(result.agent.source_repo_path, externalRepoRoot);
  assert.equal(
    commands.some(
      (entry) =>
        entry[0] === 'git' &&
        entry[1] === '-C' &&
        entry[2] === externalRepoRoot &&
        entry[3] === 'rev-parse'
    ),
    true
  );

  cleanup(repoRoot);
  cleanup(externalRepoRoot);
});

test('agent lifecycle runtime reconciles only the active stream by default', async () => {
  const externalRepoRoot = createTempRoot('mh-agent-lifecycle-other-stream-');
  const { repoRoot, runtime, stateStore } = createRuntimeHarness();

  await runtime.addAgent({
    id: 'active-stream-agent',
    create_worktree: false,
    create_tmux: false,
    source_repo_path: repoRoot
  });
  stateStore.addAgent({
    id: 'hidden-stream-agent',
    session_id: 'hidden-stream-agent',
    source_repo_path: externalRepoRoot,
    target_repo_root: externalRepoRoot,
    stream_id: `repo:${externalRepoRoot}`,
    worktree_path: null,
    pane_id: null
  });

  const result = await runtime.reconcileAgents({
    recreate_missing_panes: false
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.agent_id, 'active-stream-agent');

  cleanup(repoRoot);
  cleanup(externalRepoRoot);
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

test('agent lifecycle runtime injects literal mission text into helper tmux pane', async () => {
  const { repoRoot, runtime, commands } = createRuntimeHarness();

  await runtime.addAgent({
    id: 'agent-inject',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%77',
    source_repo_path: repoRoot
  });

  const result = await runtime.injectAgent('agent-inject', {
    text: 'Mission text',
    submit: true,
    reinforce_submit: true,
    reinforce_delay_ms: 25
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, 'inject');
  assert.equal(result.injection.pane_id, '%77');
  assert.equal(
    commands.some(
      (entry) =>
        entry[0] === 'tmux' &&
        entry[1] === 'send-keys' &&
        entry[2] === '-t' &&
        entry[3] === '%77' &&
        entry[4] === '-l' &&
        entry[6] === 'Mission text'
    ),
    true
  );
  assert.equal(
    commands.filter(
      (entry) =>
        entry[0] === 'tmux' &&
        entry[1] === 'send-keys' &&
        entry[2] === '-t' &&
        entry[3] === '%77' &&
        entry[4] === 'C-m'
    ).length >= 2,
    true
  );

  cleanup(repoRoot);
});

test('agent lifecycle runtime waits for a codex prompt before injection', async () => {
  let captureCount = 0;
  const { repoRoot, runtime, commands } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message') {
        return { stdout: `${args[3]}\n`, stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'capture-pane') {
        captureCount += 1;
        if (captureCount === 1) {
          return {
            stdout: 'amari1@host:~/repo$ codex resume --last\n',
            stderr: '',
            code: 0
          };
        }
        return {
          stdout: [
            '│ >_ OpenAI Codex (v0.114.0)                         │',
            '',
            '› Implement {feature}',
            '  gpt-5.4 xhigh · 100% left · ~/repo'
          ].join('\n'),
          stderr: '',
          code: 0
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
  });

  await runtime.addAgent({
    id: 'agent-wait-ready',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%88',
    source_repo_path: repoRoot
  });

  const result = await runtime.injectAgent('agent-wait-ready', {
    text: 'Mission text',
    submit: true,
    ready_timeout_ms: 80,
    ready_poll_ms: 20
  });

  assert.equal(result.ok, true);
  assert.equal(result.injection.ready_wait.observed_agent, 'codex');
  assert.equal(result.injection.ready_wait.waited_for_ready, true);
  assert.equal(result.injection.ready_wait.timed_out, false);
  assert.equal(captureCount >= 2, true);
  assert.equal(
    commands.some(
      (entry) =>
        entry[0] === 'tmux' &&
        entry[1] === 'send-keys' &&
        entry[2] === '-t' &&
        entry[3] === '%88' &&
        entry[4] === '-l' &&
        entry[6] === 'Mission text'
    ),
    true
  );

  cleanup(repoRoot);
});

test('agent lifecycle runtime can inject after generic startup output settles', async () => {
  let captureCount = 0;
  const { repoRoot, runtime, commands } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message') {
        return { stdout: `${args[3]}\n`, stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'capture-pane') {
        captureCount += 1;
        const stdout = captureCount === 1
          ? 'Starting helper runtime...\nLoading plugins...\n'
          : 'Ready and waiting for input.\n';
        return { stdout, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
  });

  await runtime.addAgent({
    id: 'agent-startup-quiet',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%90',
    source_repo_path: repoRoot
  });

  const result = await runtime.injectAgent('agent-startup-quiet', {
    text: 'Mission text',
    submit: true,
    ready_timeout_ms: 80,
    ready_poll_ms: 20,
    ready_stable_polls: 2
  });

  assert.equal(result.ok, true);
  assert.equal(result.injection.ready_wait.ready, true);
  assert.equal(result.injection.ready_wait.ready_reason, 'startup_quiet');
  assert.equal(result.injection.ready_wait.blocked, false);
  assert.equal(captureCount >= 2, true);
  assert.equal(
    commands.some(
      (entry) =>
        entry[0] === 'tmux' &&
        entry[1] === 'send-keys' &&
        entry[2] === '-t' &&
        entry[3] === '%90' &&
        entry[4] === '-l' &&
        entry[6] === 'Mission text'
    ),
    true
  );

  cleanup(repoRoot);
});

test('agent lifecycle runtime auto-reinforces submit for multiline codex assignments', async () => {
  let captureCount = 0;
  const { repoRoot, runtime, commands } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message') {
        return { stdout: `${args[3]}\n`, stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'capture-pane') {
        captureCount += 1;
        return {
          stdout: [
            '│ >_ OpenAI Codex (v0.114.0)                         │',
            '',
            '› Implement {feature}',
            '  gpt-5.4 xhigh · 100% left · ~/repo'
          ].join('\n'),
          stderr: '',
          code: 0
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
  });

  await runtime.addAgent({
    id: 'agent-multiline-submit',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%89',
    source_repo_path: repoRoot
  });

  const result = await runtime.injectAgent('agent-multiline-submit', {
    text: 'Line one\nLine two',
    submit: true,
    reinforce_submit: false,
    ready_timeout_ms: 40,
    ready_poll_ms: 20
  });

  assert.equal(result.ok, true);
  assert.equal(result.injection.ready_wait.observed_agent, 'codex');
  assert.equal(captureCount >= 1, true);
  assert.equal(
    commands.filter(
      (entry) =>
        entry[0] === 'tmux' &&
        entry[1] === 'send-keys' &&
        entry[2] === '-t' &&
        entry[3] === '%89' &&
        entry[4] === 'C-m'
    ).length >= 2,
    true
  );
  assert.equal(result.injection.reinforce_submit, true);

  cleanup(repoRoot);
});

test('agent lifecycle runtime can probe and clear before reinstruction', async () => {
  let lineBuffer = '';
  const { repoRoot, runtime, commands } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message') {
        return { stdout: `${args[3]}\n`, stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'capture-pane') {
        return { stdout: lineBuffer === '' ? '' : `${lineBuffer}\n`, stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'send-keys' && args[3] === '-l') {
        lineBuffer += args[5] ?? '';
        return { stdout: '', stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'send-keys' && args.slice(3).every((key) => key === 'BSpace')) {
        lineBuffer = lineBuffer.slice(0, Math.max(0, lineBuffer.length - args.slice(3).length));
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
  });

  await runtime.addAgent({
    id: 'agent-probe-success',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%94',
    source_repo_path: repoRoot
  });

  const result = await runtime.injectAgent('agent-probe-success', {
    text: 'Follow-up instruction',
    submit: true,
    wait_for_ready: false,
    probe_before_send: true,
    probe_timeout_ms: 100,
    probe_poll_ms: 20
  });

  assert.equal(result.ok, true);
  assert.equal(result.injection.probe.enabled, true);
  assert.equal(result.injection.probe.ok, true);
  assert.equal(result.injection.probe.stage, 'cleared');
  assert.equal(result.injection.probe.token_length > 0, true);
  assert.equal(lineBuffer, 'Follow-up instruction');
  assert.equal(
    commands.some(
      (entry) =>
        entry[0] === 'tmux' &&
        entry[1] === 'send-keys' &&
        entry[2] === '-t' &&
        entry[3] === '%94' &&
        entry[4] === '-l' &&
        entry[6] === 'Follow-up instruction'
    ),
    true
  );

  cleanup(repoRoot);
});

test('agent lifecycle runtime can rescue buffered multiline submit with one extra enter', async () => {
  let lineBuffer = '';
  let enterCount = 0;
  const { repoRoot, runtime, commands } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message') {
        return { stdout: `${args[3]}\n`, stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'capture-pane') {
        return { stdout: lineBuffer === '' ? '' : `${lineBuffer}\n`, stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'send-keys' && args[3] === '-l') {
        lineBuffer += args[5] ?? '';
        return { stdout: '', stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'send-keys' && args[3] === 'C-m') {
        enterCount += 1;
        if (enterCount >= 2) {
          lineBuffer = '';
        }
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
  });

  await runtime.addAgent({
    id: 'agent-rescue-submit',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%96',
    source_repo_path: repoRoot
  });

  const result = await runtime.injectAgent('agent-rescue-submit', {
    text: 'Line one\nLine two',
    submit: true,
    reinforce_submit: false,
    rescue_submit_if_buffered: true,
    rescue_submit_delay_ms: 20
  });

  assert.equal(result.ok, true);
  assert.equal(result.injection.rescue_submit.enabled, true);
  assert.equal(result.injection.rescue_submit.attempted, true);
  assert.equal(result.injection.rescue_submit.rescued, true);
  assert.equal(result.injection.rescue_submit.matched_line, 'Line two');
  assert.equal(enterCount, 2);
  assert.equal(lineBuffer, '');
  assert.equal(
    commands.filter(
      (entry) =>
        entry[0] === 'tmux' &&
        entry[1] === 'send-keys' &&
        entry[2] === '-t' &&
        entry[3] === '%96' &&
        entry[4] === 'C-m'
    ).length,
    2
  );

  cleanup(repoRoot);
});

test('agent lifecycle runtime fails reinstruction when probe never appears', async () => {
  const { repoRoot, runtime, commands, stateStore } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message') {
        return { stdout: `${args[3]}\n`, stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'capture-pane') {
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
  });

  await runtime.addAgent({
    id: 'agent-probe-fail',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%95',
    source_repo_path: repoRoot
  });

  await assert.rejects(
    () => runtime.injectAgent('agent-probe-fail', {
      text: 'Follow-up instruction',
      submit: true,
      wait_for_ready: false,
      probe_before_send: true,
      probe_timeout_ms: 60,
      probe_poll_ms: 20
    }),
    (error) => error?.code === 'invalid_state' && /input probe failed/i.test(error.message)
  );

  assert.equal(stateStore.getAgent('agent-probe-fail')?.last_message, 'input probe did not appear in helper pane');
  assert.equal(
    commands.some(
      (entry) =>
        entry[0] === 'tmux' &&
        entry[1] === 'send-keys' &&
        entry[2] === '-t' &&
        entry[3] === '%95' &&
        entry[4] === '-l' &&
        entry[6] === 'Follow-up instruction'
    ),
    false
  );

  cleanup(repoRoot);
});

test('agent lifecycle runtime stops injection when startup is blocked by trust prompt', async () => {
  const { repoRoot, runtime, stateStore } = createRuntimeHarness({
    commandRunner: async (command, args) => {
      if (command === 'tmux' && args[0] === 'display-message') {
        return { stdout: `${args[3]}\n`, stderr: '', code: 0 };
      }
      if (command === 'tmux' && args[0] === 'capture-pane') {
        return {
          stdout: [
            'Gemini CLI v0.33.1',
            'Do you trust this folder?',
            '1. Trust folder',
            '2. Trust parent folder'
          ].join('\n'),
          stderr: '',
          code: 0
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
  });

  await runtime.addAgent({
    id: 'agent-trust-blocked',
    create_worktree: false,
    create_tmux: false,
    pane_id: '%91',
    source_repo_path: repoRoot
  });

  await assert.rejects(
    () => runtime.injectAgent('agent-trust-blocked', {
      text: 'Mission text',
      submit: true,
      ready_timeout_ms: 80,
      ready_poll_ms: 20
    }),
    (error) => error?.code === 'invalid_state' && /startup blocked/i.test(error.message)
  );
  assert.equal(stateStore.getAgent('agent-trust-blocked')?.last_message, 'startup blocked: trust prompt');

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
