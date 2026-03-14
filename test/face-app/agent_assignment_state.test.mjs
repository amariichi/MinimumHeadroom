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

test('agent assignment store promotes late reports after timeout to acked_late', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-assignment-late-ack-');
  let tick = 1_700_450_000_000;
  const store = createAgentAssignmentStateStore({
    statePath,
    now: () => tick,
    log: quietLog
  });
  store.load();

  const created = store.upsertAssignment({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-late-ack',
    owner_agent_id: '__operator__',
    agent_id: 'helper-late-ack',
    goal: 'Return a late acknowledgment'
  });
  store.markDeliverySent({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-late-ack',
    agent_id: 'helper-late-ack',
    ack_timeout_ms: 1000
  });

  tick += 1500;
  const timedOut = store.getAssignment({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-late-ack'
  });
  assert.equal(timedOut?.delivery_state, 'timeout');

  tick += 250;
  const acked = store.noteReport({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-late-ack',
    from_agent_id: 'helper-late-ack',
    kind: 'progress',
    report_id: 'rpt-late-ack',
    accepted_at: tick
  });
  assert.equal(created.assignment.delivery_state, 'pending');
  assert.equal(acked.noop, false);
  assert.equal(acked.assignment?.delivery_state, 'acked_late');
  assert.equal(acked.assignment?.last_report_id, 'rpt-late-ack');

  const view = store.getAssignmentsView({
    stream_id: 'repo:/tmp/target'
  });
  assert.equal(view.summary.by_delivery_state.acked_late, 1);
  assert.equal(view.summary.by_delivery_state.timeout, 0);
  assert.equal(view.summary.by_agent_id['helper-late-ack']?.acked_late, 1);

  cleanup(rootDir);
});

test('agent assignment view exposes a grace window before completion rescue is recommended', () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-assignment-rescue-grace-');
  let tick = 1_700_460_000_000;
  const store = createAgentAssignmentStateStore({
    statePath,
    now: () => tick,
    log: quietLog
  });
  store.load();

  store.upsertAssignment({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-rescue-grace',
    owner_agent_id: '__operator__',
    agent_id: 'helper-rescue-grace',
    goal: 'Return one finding or done'
  });
  store.markDeliverySent({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-rescue-grace',
    agent_id: 'helper-rescue-grace',
    ack_timeout_ms: 1000
  });
  tick += 500;
  store.noteReport({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-rescue-grace',
    from_agent_id: 'helper-rescue-grace',
    kind: 'progress',
    report_id: 'rpt-rescue-grace',
    accepted_at: tick
  });

  const earlyView = store.getAssignmentsView({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-rescue-grace'
  });
  assert.equal(earlyView.assignments[0]?.completion_rescue_grace_ms, 10_000);
  assert.equal(earlyView.assignments[0]?.completion_rescue_recommended, false);
  assert.ok((earlyView.assignments[0]?.completion_rescue_wait_ms ?? 0) > 0);

  tick += 10_500;
  const lateView = store.getAssignmentsView({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-rescue-grace'
  });
  assert.equal(lateView.assignments[0]?.completion_rescue_recommended, true);
  assert.equal(lateView.assignments[0]?.completion_rescue_wait_ms, 0);

  store.noteReport({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-rescue-grace',
    from_agent_id: 'helper-rescue-grace',
    kind: 'review_findings',
    report_id: 'rpt-rescue-final',
    accepted_at: tick + 10
  });
  const finalView = store.getAssignmentsView({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-rescue-grace'
  });
  assert.equal(finalView.assignments[0]?.completion_rescue_recommended, false);
  assert.equal(finalView.assignments[0]?.completion_rescue_ready_at, 0);

  cleanup(rootDir);
});
