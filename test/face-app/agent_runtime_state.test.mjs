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
  assert.equal(state.policy.hard_cap, 8);
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

test('agent runtime store normalizes legacy removed entries away on load', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-state-legacy-');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      schema_version: 1,
      updated_at: 1,
      policy: { default_cap: 4, hard_cap: 8 },
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
