import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
