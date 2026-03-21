import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentAssignmentStateStore } from '../../face-app/dist/agent_assignment_state.js';
import { createOwnerInboxStateStore } from '../../face-app/dist/owner_inbox_state.js';

const quietLog = {
  info() {},
  warn() {},
  error() {}
};

function createTempStatePath(prefix) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    rootDir,
    statePath: path.join(rootDir, '.agent/runtime/owner-inbox-state.json')
  };
}

function createClock(start = 1_700_100_000_000) {
  let tick = start;
  return () => {
    tick += 17;
    return tick;
  };
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

test('owner inbox store bootstraps missing state file', () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-bootstrap-');
  const store = createOwnerInboxStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });

  const state = store.load();

  assert.equal(fs.existsSync(statePath), true);
  assert.equal(state.schema_version, 1);
  assert.deepEqual(state.streams, []);
  assert.deepEqual(state.missions, []);
  assert.deepEqual(state.reports, []);

  cleanup(rootDir);
});

test('owner inbox store appends reports idempotently and assigns stable acceptance order', () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-order-');
  const store = createOwnerInboxStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();

  const first = store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-a',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-a',
    kind: 'blocked',
    summary: 'Need approval',
    report_id: 'rpt-1'
  });
  const duplicate = store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-a',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-a',
    kind: 'blocked',
    summary: 'Need approval',
    report_id: 'rpt-1'
  });
  const second = store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-a',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-a',
    kind: 'done',
    summary: 'Patch ready',
    report_id: 'rpt-2'
  });

  assert.equal(first.transport_state, 'accepted');
  assert.equal(first.report.acceptance_order, 1);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.report.acceptance_order, 1);
  assert.equal(second.report.acceptance_order, 2);
  assert.equal(store.getState().reports.length, 2);

  cleanup(rootDir);
});

test('owner inbox store supersedes earlier helper reports and resolves explicitly', () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-supersede-');
  const store = createOwnerInboxStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();

  store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-review',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-review',
    kind: 'question',
    summary: 'Need direction',
    report_id: 'rpt-old'
  });
  const next = store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-review',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-review',
    kind: 'done',
    summary: 'Resolved locally',
    report_id: 'rpt-new',
    supersedes_report_id: 'rpt-old'
  });
  const resolved = store.updateReportLifecycle({
    stream_id: 'operator-default',
    report_id: 'rpt-new',
    action: 'resolved'
  });

  const state = store.getState();
  const oldReport = state.reports.find((report) => report.report_id === 'rpt-old');
  const newReport = state.reports.find((report) => report.report_id === 'rpt-new');

  assert.equal(oldReport?.lifecycle_state, 'superseded');
  assert.equal(next.report.lifecycle_state, 'delivered_to_inbox');
  assert.equal(resolved.report.lifecycle_state, 'resolved');
  assert.equal(newReport?.resolved_at > 0, true);

  cleanup(rootDir);
});

test('owner inbox store accepts resolve as an action alias for resolved', () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-resolve-alias-');
  const store = createOwnerInboxStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();

  store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-resolve',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-resolve',
    kind: 'done',
    summary: 'Ready to resolve',
    report_id: 'rpt-resolve'
  });
  const resolved = store.updateReportLifecycle({
    stream_id: 'operator-default',
    report_id: 'rpt-resolve',
    action: 'resolve'
  });

  assert.equal(resolved.ok, true);
  assert.equal(resolved.noop, false);
  assert.equal(resolved.report.lifecycle_state, 'resolved');
  assert.equal(resolved.report.resolved_at > 0, true);

  cleanup(rootDir);
});

test('owner inbox store normalizes owner_agent_id so "operator" matches "__operator__"', () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-normalize-');
  const store = createOwnerInboxStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();

  // Submit with canonical __operator__
  store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-norm',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-norm',
    kind: 'progress',
    summary: 'Started',
    report_id: 'rpt-norm-1'
  });

  // Submit with bare "operator" — should land in the same stream
  const aliased = store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-norm',
    owner_agent_id: 'operator',
    from_agent_id: 'helper-norm',
    kind: 'done',
    summary: 'Finished',
    report_id: 'rpt-norm-2'
  });

  assert.equal(aliased.transport_state, 'accepted');
  assert.equal(store.getState().reports.length, 2);

  // getInboxView with bare "operator" should find both reports
  const view = store.getInboxView({
    stream_id: 'operator-default',
    owner_agent_id: 'operator',
    include_resolved: true
  });
  assert.equal(view.reports.length, 2);

  // getInboxView with canonical __operator__ should also find both
  const viewCanonical = store.getInboxView({
    stream_id: 'operator-default',
    owner_agent_id: '__operator__',
    include_resolved: true
  });
  assert.equal(viewCanonical.reports.length, 2);

  cleanup(rootDir);
});

test('owner inbox store rejects late reports for closed streams', () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-closed-');
  const store = createOwnerInboxStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();

  store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-a',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-a',
    kind: 'done',
    summary: 'Initial result',
    report_id: 'rpt-initial'
  });
  store.closeStream({
    stream_id: 'operator-default',
    status: 'closed'
  });
  const late = store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-a',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-a',
    kind: 'done',
    summary: 'Late arrival',
    report_id: 'rpt-late'
  });

  assert.equal(late.transport_state, 'rejected');
  assert.equal(late.reason, 'closed_stream');
  assert.equal(store.getState().reports.some((report) => report.report_id === 'rpt-late'), false);

  cleanup(rootDir);
});

test('owner inbox store prunes aged terminal reports on load but keeps unresolved ones', () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-ttl-load-');
  const initialNow = createClock(1_700_230_000_000);
  const store = createOwnerInboxStateStore({
    statePath,
    now: initialNow,
    terminalReportRetentionMs: 1000,
    log: quietLog
  });
  store.load();

  store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-terminal',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-terminal',
    kind: 'done',
    summary: 'Terminal history',
    report_id: 'rpt-terminal'
  });
  store.updateReportLifecycle({
    stream_id: 'operator-default',
    report_id: 'rpt-terminal',
    action: 'resolved'
  });
  store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-open',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-open',
    kind: 'question',
    summary: 'Still unresolved',
    report_id: 'rpt-open'
  });

  const laterStore = createOwnerInboxStateStore({
    statePath,
    now: () => 1_700_230_010_000,
    terminalReportRetentionMs: 1000,
    log: quietLog
  });
  const state = laterStore.load();

  assert.deepEqual(state.reports.map((report) => report.report_id), ['rpt-open']);
  assert.deepEqual(state.missions.map((mission) => mission.mission_id), ['helper-open']);
  assert.deepEqual(state.streams.map((stream) => stream.stream_id), ['operator-default']);

  cleanup(rootDir);
});

test('owner inbox store archives a stream and prunes only terminal reports in that stream', () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-archive-prune-');
  const store = createOwnerInboxStateStore({
    statePath,
    now: createClock(),
    terminalReportRetentionMs: 1000 * 60 * 60,
    log: quietLog
  });
  store.load();

  store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-terminal',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-terminal',
    kind: 'done',
    summary: 'Finished work',
    report_id: 'rpt-terminal'
  });
  store.updateReportLifecycle({
    stream_id: 'operator-default',
    report_id: 'rpt-terminal',
    action: 'resolved'
  });
  store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-open',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-open',
    kind: 'blocked',
    summary: 'Still blocked',
    report_id: 'rpt-open'
  });

  const archived = store.closeStream({
    stream_id: 'operator-default',
    status: 'archived'
  });
  const state = store.getState();

  assert.equal(archived.ok, true);
  assert.equal(archived.archived_terminal_purge.removed.reports, 1);
  assert.deepEqual(state.reports.map((report) => report.report_id), ['rpt-open']);
  assert.deepEqual(state.missions.map((mission) => mission.mission_id), ['helper-open']);
  assert.equal(state.streams[0]?.status, 'archived');

  cleanup(rootDir);
});

test('owner inbox store purges helper missions and reports and removes empty streams', () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-purge-');
  const store = createOwnerInboxStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();

  store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-a',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-a',
    kind: 'progress',
    summary: 'Keep nothing',
    report_id: 'rpt-a'
  });
  store.submitReport({
    stream_id: 'operator-other',
    mission_id: 'helper-b',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-b',
    kind: 'done',
    summary: 'Leave this one',
    report_id: 'rpt-b'
  });

  const purged = store.purgeRecords({
    stream_id: 'operator-default',
    from_agent_id: 'helper-a'
  });

  assert.equal(purged.removed.streams, 1);
  assert.equal(purged.removed.missions, 1);
  assert.equal(purged.removed.reports, 1);
  assert.equal(store.getInboxView({
    stream_id: 'operator-default',
    owner_agent_id: '__operator__',
    include_resolved: true
  }).reports.length, 0);
  assert.equal(store.getInboxView({
    stream_id: 'operator-other',
    owner_agent_id: '__operator__',
    include_resolved: true
  }).reports.length, 1);

  cleanup(rootDir);
});

test('owner inbox store rejects late reports when assignment and mission were already purged', () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-late-guard-');
  const assignmentStatePath = path.join(rootDir, '.agent/runtime/agent-assignment-state.json');
  const assignmentStore = createAgentAssignmentStateStore({
    statePath: assignmentStatePath,
    now: createClock(1_700_220_000_000),
    log: quietLog
  });
  assignmentStore.load();
  assignmentStore.upsertAssignment({
    stream_id: 'operator-default',
    mission_id: 'helper-late',
    owner_agent_id: '__operator__',
    agent_id: 'helper-late',
    goal: 'Initial mission'
  });

  const store = createOwnerInboxStateStore({
    statePath,
    assignmentStateStore: assignmentStore,
    now: createClock(),
    log: quietLog
  });
  store.load();

  const accepted = store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-late',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-late',
    kind: 'progress',
    summary: 'Mission accepted',
    report_id: 'rpt-accepted'
  });
  assignmentStore.purgeAssignments({
    stream_id: 'operator-default',
    agent_id: 'helper-late'
  });
  store.purgeRecords({
    stream_id: 'operator-default',
    from_agent_id: 'helper-late'
  });

  const late = store.submitReport({
    stream_id: 'operator-default',
    mission_id: 'helper-late',
    owner_agent_id: '__operator__',
    from_agent_id: 'helper-late',
    kind: 'done',
    summary: 'Late ghost report',
    report_id: 'rpt-late'
  });

  assert.equal(accepted.transport_state, 'accepted');
  assert.equal(late.transport_state, 'rejected');
  assert.equal(late.reason, 'unknown_assignment');
  assert.equal(store.getState().missions.length, 0);
  assert.equal(store.getState().reports.length, 0);

  cleanup(rootDir);
});
