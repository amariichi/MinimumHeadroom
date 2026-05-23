import assert from 'node:assert/strict';
import test from 'node:test';
import { createHelperStuckDetector, DEFAULT_STUCK_PATTERNS } from '../../face-app/dist/helper_stuck_detector.js';

const quietLog = {
  info() {},
  warn() {},
  error() {}
};

function createFakeRuntime(initialAgents, snapshots) {
  let currentLines = snapshots;
  return {
    activeStreamId: 'repo:/test',
    listAgents() {
      return initialAgents;
    },
    async paneSnapshot(agentId) {
      const lines = currentLines[agentId];
      if (lines === undefined) {
        throw new Error(`no snapshot configured for ${agentId}`);
      }
      return { ok: true, agent_id: agentId, pane_id: '%1', tail_lines: lines.length, lines, captured_at: 0 };
    },
    _setSnapshot(agentId, lines) {
      currentLines = { ...currentLines, [agentId]: lines };
    }
  };
}

function createFakeInbox() {
  const reports = [];
  return {
    reports,
    submitReport(payload) {
      const report = { ...payload, report_id: `r-${reports.length + 1}`, accepted_at: 1 };
      reports.push(report);
      return { ok: true, report };
    }
  };
}

function createFakeAssignmentStore(assignmentsByAgent = {}) {
  return {
    listAssignments(filter = {}) {
      const agentId = filter.agent_id;
      if (!agentId) return [];
      return assignmentsByAgent[agentId] ?? [];
    }
  };
}

test('detector posts a blocked report when claude approval pattern matches', async () => {
  const agents = [{ id: 'claude-1', pane_id: '%7', stream_id: 'repo:/test', status: 'active' }];
  const runtime = createFakeRuntime(agents, {
    'claude-1': ['some output', 'Do you want to proceed?', '  1. Yes', '  2. No']
  });
  const inbox = createFakeInbox();
  const assignments = createFakeAssignmentStore({
    'claude-1': [{
      stream_id: 'repo:/test',
      mission_id: 'mission-A',
      owner_agent_id: '__operator__',
      agent_id: 'claude-1',
      last_sent_at: 1000
    }]
  });
  const detector = createHelperStuckDetector({
    runtime, inboxStore: inbox, assignmentStore: assignments, log: quietLog
  });

  const result = await detector.tick();

  assert.equal(result.posted, 1);
  assert.equal(result.scanned, 1);
  assert.equal(inbox.reports.length, 1);
  const report = inbox.reports[0];
  assert.equal(report.kind, 'blocked');
  assert.equal(report.from_agent_id, 'claude-1');
  assert.equal(report.owner_agent_id, '__operator__');
  assert.equal(report.mission_id, 'mission-A');
  assert.equal(report.stream_id, 'repo:/test');
  assert.equal(report.summary, 'helper paused on approval prompt');
  assert.ok(report.detail.startsWith('Do you want to proceed?'));
  assert.ok(report.detail.includes('---'));
  assert.equal(report.requested_action, 'check pane');
});

test('detector dedupes when the same line persists across ticks', async () => {
  const agents = [{ id: 'claude-1', pane_id: '%7', stream_id: 'repo:/test', status: 'active' }];
  const runtime = createFakeRuntime(agents, {
    'claude-1': ['Do you want to proceed?', '  1. Yes']
  });
  const inbox = createFakeInbox();
  const detector = createHelperStuckDetector({
    runtime, inboxStore: inbox, dedupeWindowMs: 60_000, log: quietLog
  });

  await detector.tick();
  await detector.tick();
  await detector.tick();

  assert.equal(inbox.reports.length, 1);
});

test('detector re-fires when matched line changes', async () => {
  const agents = [{ id: 'claude-1', pane_id: '%7', stream_id: 'repo:/test', status: 'active' }];
  const runtime = createFakeRuntime(agents, {
    'claude-1': ['Do you want to proceed?', '  Bash: ls']
  });
  const inbox = createFakeInbox();
  const detector = createHelperStuckDetector({
    runtime, inboxStore: inbox, dedupeWindowMs: 60_000, log: quietLog
  });

  await detector.tick();
  runtime._setSnapshot('claude-1', ['Do you want to proceed?', '  Bash: rm -rf']);
  await detector.tick();

  assert.equal(inbox.reports.length, 1, 'same matched line text on both ticks dedupes');

  runtime._setSnapshot('claude-1', ['Different text: Do you want to proceed? 2', '  diff']);
  await detector.tick();

  assert.equal(inbox.reports.length, 2, 'different matched line emits a new report');
});

test('detector stays silent when no pattern matches', async () => {
  const agents = [{ id: 'claude-1', pane_id: '%7', stream_id: 'repo:/test', status: 'active' }];
  const runtime = createFakeRuntime(agents, {
    'claude-1': ['Reading files', 'all good']
  });
  const inbox = createFakeInbox();
  const detector = createHelperStuckDetector({ runtime, inboxStore: inbox, log: quietLog });

  const result = await detector.tick();

  assert.equal(result.posted, 0);
  assert.equal(inbox.reports.length, 0);
});

test('detector recognizes codex quota and agy survey patterns', async () => {
  const agents = [
    { id: 'codex-1', pane_id: '%6', stream_id: 'repo:/test', status: 'active' },
    { id: 'agy-1', pane_id: '%8', stream_id: 'repo:/test', status: 'active' }
  ];
  const runtime = createFakeRuntime(agents, {
    'codex-1': ['working', "You've hit your usage limit. Upgrade..."],
    'agy-1': ['Done', "How's the CLI experience so far?", '[0] Skip']
  });
  const inbox = createFakeInbox();
  const detector = createHelperStuckDetector({ runtime, inboxStore: inbox, log: quietLog });

  await detector.tick();

  const summaries = inbox.reports.map((r) => r.summary).sort();
  assert.deepEqual(summaries, [
    'helper blocked by usage limit',
    'helper paused on CLI feedback survey'
  ]);
});

test('detector falls back to __operator__ and ambient mission when no assignment exists', async () => {
  const agents = [{ id: 'claude-2', pane_id: '%9', stream_id: 'repo:/test', status: 'active' }];
  const runtime = createFakeRuntime(agents, {
    'claude-2': ['Do you want to proceed?']
  });
  const inbox = createFakeInbox();
  const detector = createHelperStuckDetector({
    runtime, inboxStore: inbox, assignmentStore: createFakeAssignmentStore(), log: quietLog
  });

  await detector.tick();

  assert.equal(inbox.reports.length, 1);
  assert.equal(inbox.reports[0].owner_agent_id, '__operator__');
  assert.equal(inbox.reports[0].mission_id, 'ambient');
});

test('detector skips agents without pane_id or with status != active', async () => {
  const agents = [
    { id: 'no-pane', pane_id: null, stream_id: 'repo:/test', status: 'active' },
    { id: 'inactive', pane_id: '%5', stream_id: 'repo:/test', status: 'detached' }
  ];
  const runtime = createFakeRuntime(agents, {});
  const inbox = createFakeInbox();
  const detector = createHelperStuckDetector({ runtime, inboxStore: inbox, log: quietLog });

  const result = await detector.tick();

  assert.equal(result.scanned, 2);
  assert.equal(result.posted, 0);
  assert.equal(inbox.reports.length, 0);
});

test('DEFAULT_STUCK_PATTERNS exports the documented pattern ids', () => {
  const ids = DEFAULT_STUCK_PATTERNS.map((p) => p.id).sort();
  assert.deepEqual(ids, [
    'agy_survey',
    'claude_approval',
    'codex_approval',
    'codex_picker',
    'codex_quota',
    'generic_press_enter'
  ]);
});

test('codex_approval pattern matches the Codex shell-command approval modal', async () => {
  const agents = [{ id: 'codex-1', pane_id: '%9', stream_id: 'repo:/test', status: 'active' }];
  const runtime = createFakeRuntime(agents, {
    'codex-1': [
      '  Would you like to run the following command?',
      '',
      '  Reason: demo',
      '',
      '  $ true',
      '',
      '› 1. Yes, proceed (y)',
      '  2. Yes, and don\'t ask again for commands that start with `true` (p)',
      '  3. No, and tell Codex what to do differently (esc)'
    ]
  });
  const inbox = createFakeInbox();
  const detector = createHelperStuckDetector({
    runtime, inboxStore: inbox, log: quietLog
  });

  const result = await detector.tick();

  assert.equal(result.posted, 1);
  assert.equal(inbox.reports.length, 1);
  const report = inbox.reports[0];
  assert.equal(report.kind, 'blocked');
  assert.equal(report.from_agent_id, 'codex-1');
  assert.equal(report.summary, 'helper paused on approval prompt');
  assert.ok(report.detail.includes('Would you like to run the following command?'));
});

test('claude_approval pattern also matches the Antigravity permission modal', async () => {
  // Antigravity uses the same "Do you want to proceed?" phrase as Claude, so
  // the existing claude_approval pattern covers it without a separate rule.
  const agents = [{ id: 'agy-1', pane_id: '%11', stream_id: 'repo:/test', status: 'active' }];
  const runtime = createFakeRuntime(agents, {
    'agy-1': [
      '  Requesting permission for: whoami',
      '',
      'Do you want to proceed?',
      '> 1. Yes',
      '  2. Yes, and always allow in this conversation for commands that start with \'whoami\'',
      '  3. Yes, and always allow for commands that start with \'whoami\' (Persist to settings.json)',
      '  4. No'
    ]
  });
  const inbox = createFakeInbox();
  const detector = createHelperStuckDetector({
    runtime, inboxStore: inbox, log: quietLog
  });

  const result = await detector.tick();

  assert.equal(result.posted, 1);
  assert.equal(inbox.reports.length, 1);
  assert.equal(inbox.reports[0].from_agent_id, 'agy-1');
});
