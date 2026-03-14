import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentRuntimeStateStore } from '../../face-app/dist/agent_runtime_state.js';

const quietLog = {
  info() {},
  warn() {},
  error() {}
};

function createTempStatePath(prefix) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    rootDir,
    statePath: path.join(rootDir, '.agent/runtime/agents-state.json')
  };
}

function createClock(start = 1_700_000_000_000) {
  let tick = start;
  return () => {
    tick += 13;
    return tick;
  };
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

test('agent runtime store bootstraps missing state file', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-state-bootstrap-');
  const store = createAgentRuntimeStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });

  const state = store.load();

  assert.equal(fs.existsSync(statePath), true);
  assert.equal(state.schema_version, 1);
  assert.equal(state.policy.hard_cap, 7);
  assert.deepEqual(state.agents, []);

  cleanup(rootDir);
});

test('agent runtime store backs up malformed state file and resets', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-state-malformed-');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, '{ not-json', 'utf8');

  const store = createAgentRuntimeStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  const state = store.load();

  assert.equal(state.agents.length, 0);
  assert.equal(fs.existsSync(`${statePath}.bak`), true);
  assert.equal(fs.existsSync(statePath), true);

  cleanup(rootDir);
});

test('agent runtime store enforces hard cap for all tracked agents', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-state-cap-');
  const store = createAgentRuntimeStateStore({
    statePath,
    hardCap: 2,
    now: createClock(),
    log: quietLog
  });
  store.load();

  store.addAgent({ id: 'a', slot: 0 });
  store.addAgent({ id: 'b', slot: 1 });

  assert.throws(
    () => store.addAgent({ id: 'c', slot: 2 }),
    (error) => error?.code === 'hard_cap_reached'
  );

  cleanup(rootDir);
});

test('agent runtime store scopes default listing to the active stream', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-state-stream-scope-');
  const repoA = path.join(rootDir, 'repo-a');
  const repoB = path.join(rootDir, 'repo-b');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });

  const store = createAgentRuntimeStateStore({
    statePath,
    activeTargetRepoRoot: repoB,
    activeStreamId: `repo:${repoB}`,
    now: createClock(),
    log: quietLog
  });
  store.load();

  store.addAgent({ id: 'a-helper', source_repo_path: repoA });
  store.addAgent({ id: 'b-helper', source_repo_path: repoB });

  const activeState = store.getState();
  const allState = store.getState({ scope: 'all' });

  assert.deepEqual(activeState.agents.map((agent) => agent.id), ['b-helper']);
  assert.equal(activeState.active_stream_id, `repo:${repoB}`);
  assert.equal(activeState.hidden_agent_count, 1);
  assert.deepEqual(allState.agents.map((agent) => agent.id), ['a-helper', 'b-helper']);

  cleanup(rootDir);
});

test('agent runtime store enforces hard cap per stream', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-state-stream-cap-');
  const repoA = path.join(rootDir, 'repo-a');
  const repoB = path.join(rootDir, 'repo-b');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });

  const store = createAgentRuntimeStateStore({
    statePath,
    hardCap: 2,
    activeTargetRepoRoot: repoA,
    activeStreamId: `repo:${repoA}`,
    now: createClock(),
    log: quietLog
  });
  store.load();

  store.addAgent({ id: 'a-1', source_repo_path: repoA });
  store.addAgent({ id: 'a-2', source_repo_path: repoA });
  store.addAgent({ id: 'b-1', source_repo_path: repoB });
  store.addAgent({ id: 'b-2', source_repo_path: repoB });

  assert.throws(
    () => store.addAgent({ id: 'a-3', source_repo_path: repoA }),
    (error) => error?.code === 'hard_cap_reached'
  );
  assert.throws(
    () => store.addAgent({ id: 'b-3', source_repo_path: repoB }),
    (error) => error?.code === 'hard_cap_reached'
  );

  cleanup(rootDir);
});

test('agent runtime store normalizes legacy removed entries away on load', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-state-legacy-');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      schema_version: 1,
      updated_at: 1,
      policy: { default_cap: 4, hard_cap: 7 },
      agents: [
        { id: 'a', status: 'removed', slot: 0 },
        { id: 'b', status: 'paused', slot: 1 },
        { id: 'c', status: 'active', slot: 2 }
      ]
    }),
    'utf8'
  );

  const store = createAgentRuntimeStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  const state = store.load();

  assert.deepEqual(
    state.agents.map((agent) => [agent.id, agent.status]),
    [
      ['b', 'active'],
      ['c', 'active']
    ]
  );

  cleanup(rootDir);
});

test('agent runtime store derives legacy stream and target repo roots from source repo path', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-state-legacy-stream-');
  const repoA = path.join(rootDir, 'repo-a');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      schema_version: 1,
      updated_at: 1,
      policy: { default_cap: 4, hard_cap: 7 },
      agents: [
        { id: 'a', status: 'active', slot: 0, source_repo_path: repoA }
      ]
    }),
    'utf8'
  );

  const store = createAgentRuntimeStateStore({
    statePath,
    activeTargetRepoRoot: repoA,
    activeStreamId: `repo:${repoA}`,
    now: createClock(),
    log: quietLog
  });
  const state = store.load();

  assert.equal(state.agents[0]?.target_repo_root, repoA);
  assert.equal(state.agents[0]?.stream_id, `repo:${repoA}`);

  cleanup(rootDir);
});

test('agent runtime setAgentStatus updates to missing with noop detection', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-state-transitions-');
  const store = createAgentRuntimeStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();

  store.addAgent({ id: 'a', slot: 0 });

  const setMissing = store.setAgentStatus('a', 'missing', {
    message: 'pane missing'
  });
  const setMissingAgain = store.setAgentStatus('a', 'missing', {
    message: 'pane missing'
  });

  assert.equal(setMissing.noop, false);
  assert.equal(setMissingAgain.noop, true);

  const afterMissing = store.getState().agents.find((agent) => agent.id === 'a');
  assert.equal(afterMissing?.status, 'missing');
  assert.equal(afterMissing?.last_message, 'pane missing');

  cleanup(rootDir);
});

test('agent runtime stores per-agent short message with noop detection', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-state-message-');
  const store = createAgentRuntimeStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();
  store.addAgent({ id: 'a', slot: 0 });

  const update1 = store.setAgentMessage('a', 'build started', 'status');
  const update2 = store.setAgentMessage('a', 'build started', 'status');
  const update3 = store.setAgentMessage('a', 'tests passed', 'speech');

  assert.equal(update1.noop, false);
  assert.equal(update2.noop, true);
  assert.equal(update3.noop, false);

  const agent = store.getState().agents.find((item) => item.id === 'a');
  assert.equal(agent?.last_message, 'tests passed');
  assert.equal(agent?.message_source, 'speech');

  cleanup(rootDir);
});

test('agent runtime purge removes fully detached agent records', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-state-purge-');
  const store = createAgentRuntimeStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();
  store.addAgent({ id: 'a', slot: 0, pane_id: null, worktree_path: null });

  const purged = store.purgeAgent('a');
  assert.equal(purged.ok, true);
  assert.equal(purged.action, 'purge');
  assert.equal(purged.agent?.id, 'a');
  assert.equal(store.getState().agents.some((agent) => agent.id === 'a'), false);

  cleanup(rootDir);
});
