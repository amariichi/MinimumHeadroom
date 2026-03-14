import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentAssignmentStateStore } from '../../face-app/dist/agent_assignment_state.js';

const quietLog = {
  info() {},
  warn() {},
  error() {}
};

function createTempStatePath(prefix) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    rootDir,
    statePath: path.join(rootDir, '.agent/runtime/agent-assignment-state.json')
  };
}

function createClock(start = 1_700_300_000_000) {
  let tick = start;
  return () => {
    tick += 23;
    return tick;
  };
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

test('agent assignment store bootstraps missing state file', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-assignment-bootstrap-');
  const store = createAgentAssignmentStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });

  const state = store.load();

  assert.equal(fs.existsSync(statePath), true);
  assert.equal(state.schema_version, 1);
  assert.deepEqual(state.assignments, []);

  cleanup(rootDir);
});

test('agent assignment store upserts missions and resets delivery state on update', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-assignment-upsert-');
  const store = createAgentAssignmentStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();

  const created = store.upsertAssignment({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-a',
    owner_agent_id: '__operator__',
    agent_id: 'helper-a',
    role: 'implementation',
    goal: 'Add one test',
    target_paths: ['README.md'],
    completion_criteria: 'Return one finding or done.',
    timebox_minutes: 3,
    max_findings: 1
  });
  store.markDeliverySent({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-a',
    agent_id: 'helper-a',
    ack_timeout_ms: 5000
  });
  const updated = store.upsertAssignment({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-a',
    owner_agent_id: '__operator__',
    agent_id: 'helper-a',
    role: 'review',
    goal: 'Review the patch',
    target_paths: ['doc/examples/AGENT_RULES.md', 'doc/examples/AGENT_RULES.md'],
    completion_criteria: 'Return one finding or done.',
    timebox_minutes: 5,
    max_findings: 2
  });

  assert.equal(created.action, 'created');
  assert.equal(updated.action, 'updated');
  assert.equal(updated.assignment.assignment_revision, 2);
  assert.equal(updated.assignment.delivery_state, 'pending');
  assert.equal(updated.assignment.delivery_attempts, 0);
  assert.equal(updated.assignment.goal, 'Review the patch');
  assert.deepEqual(updated.assignment.target_paths, ['doc/examples/AGENT_RULES.md']);
  assert.equal(updated.assignment.completion_criteria, 'Return one finding or done.');
  assert.equal(updated.assignment.timebox_minutes, 5);
  assert.equal(updated.assignment.max_findings, 2);

  cleanup(rootDir);
});

test('agent assignment store marks sent deliveries and acknowledges them through matching reports', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-assignment-ack-');
  const store = createAgentAssignmentStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();

  store.upsertAssignment({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-a',
    owner_agent_id: '__operator__',
    agent_id: 'helper-a',
    goal: 'Implement a helper patch'
  });
  const sent = store.markDeliverySent({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-a',
    agent_id: 'helper-a',
    ack_timeout_ms: 5000
  });
  const acked = store.noteReport({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-a',
    from_agent_id: 'helper-a',
    kind: 'progress',
    report_id: 'rpt-ack',
    accepted_at: sent.assignment.last_sent_at + 100
  });

  assert.equal(sent.assignment.delivery_state, 'sent_to_tmux');
  assert.equal(acked.noop, false);
  assert.equal(acked.assignment?.delivery_state, 'acked');
  assert.equal(acked.assignment?.last_report_id, 'rpt-ack');

  cleanup(rootDir);
});

test('agent assignment store lazily times out unacknowledged deliveries', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-assignment-timeout-');
  let tick = 1_700_400_000_000;
  const store = createAgentAssignmentStateStore({
    statePath,
    now: () => tick,
    log: quietLog
  });
  store.load();

  store.upsertAssignment({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-timeout',
    owner_agent_id: '__operator__',
    agent_id: 'helper-timeout',
    goal: 'Wait for timeout'
  });
  store.markDeliverySent({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-timeout',
    ack_timeout_ms: 1000
  });

  tick += 1500;
  const view = store.getAssignmentsView({
    stream_id: 'repo:/tmp/target'
  });
  const assignment = view.assignments.find((item) => item.mission_id === 'mission-timeout');

  assert.equal(assignment?.delivery_state, 'timeout');
  assert.equal(view.summary.by_delivery_state.timeout, 1);

  cleanup(rootDir);
});
