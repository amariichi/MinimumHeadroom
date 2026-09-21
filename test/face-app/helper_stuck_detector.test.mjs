import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createHelperStuckDetector, DEFAULT_STUCK_PATTERNS } from '../../face-app/dist/helper_stuck_detector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, 'fixtures', 'stuck_detector');

function loadFixture(cli, name) {
  const path = join(FIXTURE_ROOT, cli, `${name}.txt`);
  return readFileSync(path, 'utf8').replace(/\n$/, '').split('\n');
}

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
    listReports() {
      return reports;
    },
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

test('detector re-fires when the requested action or modal heading changes', async () => {
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

  assert.equal(inbox.reports.length, 2, 'a different requested command is a new blocking choice');

  runtime._setSnapshot('claude-1', ['Different text: Do you want to proceed? 2', '  diff']);
  await detector.tick();

  assert.equal(inbox.reports.length, 3, 'different matched line emits a new report');
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
    'agy_trust_folder',
    'claude_approval',
    'codex_approval',
    'codex_mcp_approval',
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

// Fixture-driven coverage. Each fixture under test/face-app/fixtures/stuck_detector/<cli>/
// is a verbatim ANSI-stripped tmux pane snapshot collected from a real helper. Positive
// fixtures must surface exactly one matching pattern; negative fixtures must surface none.

const FIXTURE_CASES = [
  // codex positives
  { cli: 'codex', name: 'approval_shell_command', expectPatternId: 'codex_approval' },
  { cli: 'codex', name: 'approval_mcp_tool', expectPatternId: 'codex_mcp_approval' },
  { cli: 'codex', name: 'picker_model', expectPatternId: 'codex_picker' },
  // codex negatives — these are real running / idle states that must not fire
  { cli: 'codex', name: 'idle_empty_prompt', expectPatternId: null },
  { cli: 'codex', name: 'idle_after_response', expectPatternId: null },
  { cli: 'codex', name: 'idle_after_interrupted', expectPatternId: null },
  { cli: 'codex', name: 'running_thinking', expectPatternId: null },
  // agy positives
  { cli: 'agy', name: 'trust_folder_prompt', expectPatternId: 'agy_trust_folder' },
  { cli: 'agy', name: 'approval_mcp_tool', expectPatternId: 'claude_approval' },
  // agy negatives
  { cli: 'agy', name: 'idle_empty_prompt', expectPatternId: null },
  { cli: 'agy', name: 'idle_after_response', expectPatternId: null },
  { cli: 'agy', name: 'running_loading', expectPatternId: null },
  { cli: 'agy', name: 'slash_command_picker', expectPatternId: null }
];

for (const { cli, name, expectPatternId } of FIXTURE_CASES) {
  const label = expectPatternId
    ? `fixture ${cli}/${name} triggers ${expectPatternId}`
    : `fixture ${cli}/${name} does not trigger any pattern`;
  test(label, async () => {
    const agentId = `${cli}-fixture`;
    const agents = [{ id: agentId, pane_id: '%99', stream_id: 'repo:/test', status: 'active' }];
    const runtime = createFakeRuntime(agents, { [agentId]: loadFixture(cli, name) });
    const inbox = createFakeInbox();
    const detector = createHelperStuckDetector({ runtime, inboxStore: inbox, log: quietLog });

    const result = await detector.tick();

    if (expectPatternId === null) {
      assert.equal(result.posted, 0, `expected no report, got ${inbox.reports.length}`);
      assert.equal(inbox.reports.length, 0);
    } else {
      assert.equal(inbox.reports.length, 1, `expected exactly one report from ${expectPatternId}`);
      assert.equal(result.posted, 1);
      // Confirm the matched line actually belongs to the expected pattern by re-running
      // its regex over the report detail (first line is the matched line).
      const pattern = DEFAULT_STUCK_PATTERNS.find((p) => p.id === expectPatternId);
      assert.ok(pattern, `pattern ${expectPatternId} not registered`);
      const firstLine = inbox.reports[0].detail.split('\n', 1)[0];
      assert.ok(pattern.regex.test(firstLine),
        `expected ${expectPatternId} regex to match first detail line: ${firstLine}`);
    }
  });
}

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

function notificationScenario({ lines = ['Do you want to proceed?', '  1. Yes'], assignments = [] } = {}) {
  const agents = [{ id: 'helper-2', pane_id: '%7', stream_id: 'repo:/test', status: 'active' }];
  const runtime = createFakeRuntime(agents, { 'helper-2': lines });
  const inbox = createFakeInbox();
  const byAgent = { 'helper-2': assignments };
  const detector = createHelperStuckDetector({ runtime, inboxStore: inbox,
    assignmentStore: createFakeAssignmentStore(byAgent), log: quietLog,
    dedupeWindowMs: 0 }); // Time-window expiry must never repeat a continuous modal.
  return { runtime, inbox, detector, byAgent, agents };
}

const currentMission = { stream_id: 'repo:/test', mission_id: 'current', owner_agent_id: '__operator__',
  agent_id: 'helper-2', last_sent_at: 100, created_at: 50, assignment_revision: 1 };

function finalReport(overrides = {}) {
  return { stream_id: 'repo:/test', mission_id: 'current', owner_agent_id: '__operator__',
    from_agent_id: 'helper-2', kind: 'done', accepted_at: 200, lifecycle_state: 'resolved', ...overrides };
}

test('an unchanged modal reports once despite changing clock, duration and context footer', async () => {
  const scenario = notificationScenario();
  for (let i = 0; i < 100; i += 1) {
    scenario.runtime._setSnapshot('helper-2', [
      `You've hit your usage limit. Try again at 12:${String(i % 60).padStart(2, '0')} PM`,
      'Upgrade to continue.',
      `Retry in ${100 - i}s`,
      `${100 - i}% context left`,
      `gpt-5.5 high · /test · ${i} tokens`,
      `Time: 13:15:${String(i % 60).padStart(2, '0')}`
    ]);
    await scenario.detector.tick();
  }
  assert.equal(scenario.inbox.reports.length, 1);
  assert.equal(scenario.inbox.reports[0].summary, 'helper blocked by usage limit');
});

test('a modal that clears and immediately reappears emits a new event', async () => {
  const scenario = notificationScenario();
  await scenario.detector.tick();
  scenario.runtime._setSnapshot('helper-2', ['• Working (1s • esc to interrupt)']);
  await scenario.detector.tick();
  scenario.runtime._setSnapshot('helper-2', ['Do you want to proceed?', '  1. Yes']);
  await scenario.detector.tick();
  assert.equal(scenario.inbox.reports.length, 2);
});

test('old quota and approval text in scrollback is silent while a later Working row is active', async () => {
  const scenario = notificationScenario({ lines: [
    "You've hit your usage limit. Try later.",
    'Do you want to proceed?',
    '  1. Yes',
    '› Continue the task',
    '• Working (9s • esc to interrupt)',
    '› Explain this codebase',
    'gpt-5.5 high · /test'
  ] });
  assert.equal((await scenario.detector.tick()).posted, 0);
  assert.equal(scenario.inbox.reports.length, 0);
});

test('a real active approval or quota after Working still emits its notice', async () => {
  for (const lines of [
    ['• Working (9s • esc to interrupt)', 'Would you like to run the following command?', '$ pwd', '› 1. Yes'],
    ['• Working (9s • esc to interrupt)', "You've hit your usage limit. Upgrade..."]
  ]) {
    const scenario = notificationScenario({ lines });
    assert.equal((await scenario.detector.tick()).posted, 1);
  }
});

test('stale quota in scrollback does not shadow a new real permission modal', async () => {
  const scenario = notificationScenario({ lines: [
    "You've hit your usage limit. Upgrade...", '• Working (9s • esc to interrupt)',
    'Allow the minimum_headroom MCP server to run tool "face_ping"?', '› 1. Allow'
  ] });
  await scenario.detector.tick();
  assert.equal(scenario.inbox.reports.length, 1);
  assert.equal(scenario.inbox.reports[0].summary, 'helper paused on MCP tool approval prompt');
});

test('completed current assignments do not generate modal reports', async () => {
  for (const kind of ['done', 'review_findings']) {
    const scenario = notificationScenario({ assignments: [
      { ...currentMission, last_report_kind: kind, last_report_at: 200 }
    ] });
    assert.equal((await scenario.detector.tick()).posted, 0);
    assert.equal(scenario.inbox.reports.length, 0);
  }
});

test('a resolved final report suppresses notices even after a blocked report replaced assignment metadata', async () => {
  const scenario = notificationScenario({ assignments: [
    { ...currentMission, last_report_kind: 'blocked', last_report_at: 300 }
  ] });
  scenario.inbox.reports.push(finalReport());
  assert.equal((await scenario.detector.tick()).posted, 0);
  assert.equal(scenario.inbox.reports.length, 1);
});

test('completion that arrives during asynchronous pane capture suppresses the pending notice', async () => {
  const scenario = notificationScenario({ assignments: [currentMission] });
  const snapshot = scenario.runtime.paneSnapshot.bind(scenario.runtime);
  scenario.runtime.paneSnapshot = async (agentId) => {
    const result = await snapshot(agentId);
    scenario.inbox.reports.push(finalReport());
    return result;
  };
  assert.equal((await scenario.detector.tick()).posted, 0);
  assert.equal(scenario.inbox.reports.length, 1);
});

test('other missions, helpers and streams cannot suppress a current active permission', async () => {
  const scenario = notificationScenario({ assignments: [currentMission] });
  scenario.inbox.reports.push(finalReport({ mission_id: 'previous' }),
    finalReport({ from_agent_id: 'helper-1' }), finalReport({ stream_id: 'repo:/other' }));
  assert.equal((await scenario.detector.tick()).posted, 1);
  assert.equal(scenario.inbox.reports.length, 4);
});

test('a new delivery of the same mission is not suppressed by its previous final report', async () => {
  const scenario = notificationScenario({ assignments: [
    { ...currentMission, last_sent_at: 400, last_report_kind: 'done', last_report_at: 200 }
  ] });
  scenario.inbox.reports.push(finalReport());
  assert.equal((await scenario.detector.tick()).posted, 1);
  assert.equal(scenario.inbox.reports.at(-1).kind, 'blocked');
});

test('a new unsent assignment wins over an older completed mission and gets its own notice', async () => {
  const scenario = notificationScenario({ assignments: [
    { ...currentMission, last_report_kind: 'done', last_report_at: 200, updated_at: 200 },
    { ...currentMission, mission_id: 'next', created_at: 300, updated_at: 300, last_sent_at: 0 }
  ] });
  assert.equal((await scenario.detector.tick()).posted, 1);
  assert.equal(scenario.inbox.reports[0].mission_id, 'next');
});

test('a new assignment re-arms the same modal even if no clear pane was observed', async () => {
  const scenario = notificationScenario({ assignments: [currentMission] });
  await scenario.detector.tick();
  scenario.byAgent['helper-2'] = [{ ...currentMission, mission_id: 'next', last_sent_at: 300 }];
  await scenario.detector.tick();
  assert.deepEqual(scenario.inbox.reports.map((report) => report.mission_id), ['current', 'next']);
});

test('a failed report submission is retried instead of marking the modal as notified', async () => {
  const scenario = notificationScenario();
  const submit = scenario.inbox.submitReport.bind(scenario.inbox);
  let attempts = 0;
  scenario.inbox.submitReport = (payload) => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary store failure');
    return submit(payload);
  };
  assert.equal((await scenario.detector.tick()).posted, 0);
  assert.equal((await scenario.detector.tick()).posted, 1);
  assert.equal((await scenario.detector.tick()).posted, 0);
  assert.equal(attempts, 2);
});

test('posting a notice cannot re-arm itself by updating an unsent assignment timestamp', async () => {
  const assignment = { ...currentMission, last_sent_at: 0, created_at: 100, updated_at: 100 };
  const scenario = notificationScenario({ assignments: [assignment] });
  const submit = scenario.inbox.submitReport.bind(scenario.inbox);
  scenario.inbox.submitReport = (payload) => {
    assignment.updated_at += 100;
    assignment.last_report_at = assignment.updated_at;
    assignment.last_report_kind = 'blocked';
    return submit(payload);
  };
  await scenario.detector.tick();
  await scenario.detector.tick();
  await scenario.detector.tick();
  assert.equal(scenario.inbox.reports.length, 1);
});

test('a changed modal uses the latest specific prompt instead of old approval scrollback', async () => {
  const scenario = notificationScenario();
  await scenario.detector.tick();
  scenario.runtime._setSnapshot('helper-2', [
    'Do you want to proceed?', '  1. Yes',
    "You've hit your usage limit. Upgrade...", 'Press enter to confirm'
  ]);
  await scenario.detector.tick();
  assert.deepEqual(scenario.inbox.reports.map((report) => report.summary), [
    'helper paused on approval prompt', 'helper blocked by usage limit'
  ]);
});

test('changing a duration in a requested command is not mistaken for a ticking footer', async () => {
  const scenario = notificationScenario({ lines: ['Do you want to proceed?', '$ timeout 10s command'] });
  await scenario.detector.tick();
  scenario.runtime._setSnapshot('helper-2', ['Do you want to proceed?', '$ timeout 20s command']);
  await scenario.detector.tick();
  assert.equal(scenario.inbox.reports.length, 2);
});
