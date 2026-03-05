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

test('agent runtime store enforces hard cap only for non-removed agents', () => {
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

  store.removeAgent('a');
  const added = store.addAgent({ id: 'c' });
  assert.equal(added.ok, true);

  cleanup(rootDir);
});

test('agent runtime pause/resume/remove/restore transitions are idempotent and keep slot safety', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-state-transitions-');
  const store = createAgentRuntimeStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();

  store.addAgent({ id: 'a', slot: 0 });
  store.addAgent({ id: 'b', slot: 1 });

  const pause1 = store.pauseAgent('a');
  const pause2 = store.pauseAgent('a');
  assert.equal(pause1.noop, false);
  assert.equal(pause2.noop, true);
  assert.equal(store.getState().agents.find((agent) => agent.id === 'a')?.status, 'paused');

  const resume1 = store.resumeAgent('a');
  const resume2 = store.resumeAgent('a');
  assert.equal(resume1.noop, false);
  assert.equal(resume2.noop, true);
  assert.equal(store.getState().agents.find((agent) => agent.id === 'a')?.status, 'active');

  store.removeAgent('a');
  const afterRemove = store.getState().agents.find((agent) => agent.id === 'a');
  assert.equal(afterRemove?.status, 'removed');
  assert.equal(afterRemove?.slot, null);
  assert.equal(afterRemove?.removed_slot, 0);

  store.addAgent({ id: 'c', slot: 0 });
  const restore = store.restoreAgent('a');
  assert.equal(restore.noop, false);

  const afterRestore = store.getState().agents.find((agent) => agent.id === 'a');
  assert.equal(afterRestore?.status, 'active');
  assert.equal(afterRestore?.slot, 2);

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
