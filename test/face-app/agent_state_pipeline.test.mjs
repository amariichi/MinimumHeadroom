import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runHookCli } from '../../scripts/mh-hook.mjs';
import { classifyAgentHook } from '../../scripts/agent-hook-events.mjs';
import { createHookBridge } from '../../face-app/dist/hook_bridge.js';
import { createOwnerReportPipeline } from '../../face-app/dist/owner_report_pipeline.js';
import { createOwnerInboxStateStore } from '../../face-app/dist/owner_inbox_state.js';
import { createAgentAssignmentStateStore } from '../../face-app/dist/agent_assignment_state.js';
import { createOwnerInboxNotifier } from '../../face-app/dist/owner_inbox_notifier.js';
import { createHelperStuckDetector } from '../../face-app/dist/helper_stuck_detector.js';
import { createOwnerInboxApi } from '../../face-app/dist/owner_inbox_api.js';
import { deriveAgentTransientUpdate } from '../../face-app/public/agent_dashboard_feed.js';
import { deriveAgentOperationalState, deriveOwnerInboxToneOptions } from '../../face-app/public/agent_dashboard_state.js';

// Synthetic cases use documented shapes. Explicitly marked recording cases
// load whitelisted live inputs from the fixture; no CLI or transport is started.
// Public regression fixtures use fictitious identities and paths, not live captures.
const recordings = JSON.parse(fs.readFileSync(new URL('../fixtures/agent-state.synthetic.json', import.meta.url)));
const wrappedApproval = JSON.parse(fs.readFileSync(new URL('../fixtures/codex-wrapped-approval.synthetic.json', import.meta.url)));
const claudeReminders = JSON.parse(fs.readFileSync(new URL('../fixtures/claude-permission-reminders.synthetic.json', import.meta.url)));
const claudeTerminalAmbiguity = JSON.parse(fs.readFileSync(new URL('../fixtures/claude-terminal-ambiguity.synthetic.json', import.meta.url)));
const claudeBox = JSON.parse(fs.readFileSync(new URL('../fixtures/claude-bash-box.synthetic.json', import.meta.url)));
const log = { warn() {}, info() {}, error() {} };
const familyCases = [
  { runtime: 'codex', tool: 'request_user_input', fields: id => ({ session_id: 'session', tool_use_id: id }),
    input: q => ({ tool_input: { questions: q } }), modal: 'Would you like to run the following command?' },
  { runtime: 'claude', tool: 'AskUserQuestion', fields: id => ({ session_id: 'session', tool_use_id: id }),
    input: q => ({ tool_input: { questions: q } }), modal: 'Do you want to proceed?' },
  { runtime: 'antigravity', tool: 'ask_question', fields: id => ({ conversationId: 'session', stepIdx: Number(id) }),
    input: q => ({ questions: q }), modal: 'Do you want to proceed?' }
];

function failNextStateWrite(t, store) {
  const original = fs.writeFileSync;
  let failures = 1;
  const restore = () => { fs.writeFileSync = original; };
  // Fail inside the real atomic writer, after the store has mutated memory.
  fs.writeFileSync = (filename, ...args) => {
    if (String(filename).startsWith(`${store.statePath}.tmp-`) && failures-- > 0) {
      throw new Error('temporary state-file write failure');
    }
    return original(filename, ...args);
  };
  t.after(restore);
  return restore;
}

function harness(t, { ack = true, afterNotify = async () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-agent-state-pipeline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assignments = createAgentAssignmentStateStore({ statePath: path.join(root, 'assignments.json'), log });
  assignments.upsertAssignment({ stream_id: 'stream', mission_id: 'mission', owner_agent_id: '__operator__', agent_id: 'helper', goal: 'Test mission' });
  assignments.markDeliverySent({ stream_id: 'stream', mission_id: 'mission', agent_id: 'helper' });
  const store = createOwnerInboxStateStore({ statePath: path.join(root, 'inbox.json'), assignmentStateStore: assignments, log });
  const sent = [], transient = new Map();
  const server = { broadcast(payload) {
    sent.push(payload);
    const current = transient.get(payload.agent_id) ?? {};
    Object.assign(current, deriveAgentTransientUpdate(payload) ?? {});
    transient.set(payload.agent_id, current);
  } };
  const notifier = createOwnerInboxNotifier({ log });
  const pipeline = createOwnerReportPipeline({ store, assignmentStore: assignments,
    notify: async report => { await notifier.notify({ report, server }); await afterNotify(report); }, log });
  const report = input => pipeline.submitReport({ stream_id: 'stream', mission_id: 'mission',
    owner_agent_id: '__operator__', from_agent_id: 'helper', summary: 'Test report', ...input });
  const ready = ack ? report({ kind: 'progress', report_id: 'ack' }) : Promise.resolve();
  let bridge = createHookBridge({ templatesPath: path.join(root, 'absent-templates.json'), log });
  const recorded = async ({ runtime, native_event, payload }) => {
    await ready;
    let bridgeResult;
    const result = await runHookCli({ argv: ['--runtime', runtime, '--stdout-mode', 'silent', '--event', native_event],
      inputText: JSON.stringify(payload), env: { MH_FACE_AGENT_ID: 'helper' }, stdout: { write() {} }, stderr: { write() {} },
      send: async (_url, message) => { bridgeResult = await bridge.handleHook({ payload: message, server,
        ownerInboxStore: store, assignmentStore: assignments, reportPipeline: pipeline }); } });
    return { ...result, bridgeResult };
  };
  const native = async (family, event, id = '1', extra = {}) => {
    await ready;
    const agy = family.runtime === 'antigravity';
    const payload = { ...family.fields(id), ...(!agy ? { hook_event_name: event, tool_name: family.tool } :
      { toolCall: { name: family.tool, args: {} } }), ...extra };
    let bridgeResult;
    const result = await runHookCli({ argv: ['--runtime', family.runtime, '--stdout-mode', 'silent', '--event', event],
      inputText: JSON.stringify(payload), env: { MH_FACE_AGENT_ID: 'helper' }, stdout: { write() {} }, stderr: { write() {} },
      send: async (_url, message) => { bridgeResult = await bridge.handleHook({ payload: message, server,
        ownerInboxStore: store, assignmentStore: assignments, reportPipeline: pipeline }); } });
    return { ...result, bridgeResult };
  };
  const state = () => {
    const summary = store.getInboxView({}).summary;
    return deriveAgentOperationalState({ status: 'active' }, {
      ...transient.get('helper'), ...deriveOwnerInboxToneOptions(summary), ownerInboxSummary: summary,
      assignment: assignments.getAssignment({ stream_id: 'stream', mission_id: 'mission' }), nowMs: Date.now() + 60_000
    });
  };
  return { assignments, store, sent, server, pipeline, native, recorded, report, ready, transient, state,
    hook: async payload => { await ready; return bridge.handleHook({ payload: { type: 'hook', agent_id: 'helper', ...payload },
      server, ownerInboxStore: store, assignmentStore: assignments, reportPipeline: pipeline }); },
    restartBridge: () => { bridge = createHookBridge({ templatesPath: path.join(root, 'absent.json'), log }); } };
}

const inputNotices = h => h.sent.filter(p => p.type === 'event' && p.meta?.source === 'owner_inbox'
  && ['question', 'blocked'].includes(p.meta.report_kind));
const liveClaude = name => claudeReminders.cases[name].canonical;

for (const kind of ['question', 'approval']) {
  for (const order of ['before_primary', 'after_primary', 'after_resolution']) {
    test(`synthetic Claude ${kind}: ${order} permission reminder cannot create or reopen a wait`, async t => {
      const h = harness(t); await h.ready;
      const reminder = liveClaude(`${kind}_reminder`);
      const remind = async () => {
        const count = h.sent.length;
        assert.equal((await h.hook(reminder)).reason, 'uncorrelated_permission_reminder');
        assert.equal(h.sent.length, count, 'a reminder must not announce, speak or alter transient state');
      };
      if (order === 'before_primary') await remind();
      await h.hook(liveClaude(`${kind}_start`));
      const report = h.store.listReports({}).find(r => r.blocking);
      assert.equal(report.kind, kind === 'question' ? 'question' : 'blocked');
      if (order === 'after_primary') { await remind(); await remind(); }
      assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 1);
      await h.hook(liveClaude(kind === 'question' ? 'question_answer' : 'approval_result'));
      await h.hook(liveClaude(`${kind}_stop`));
      h.restartBridge();
      await remind(); // Late delivery must also be harmless after cache loss.
      assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 0);
      assert.equal(h.store.listReports({ include_resolved: true }).find(r => r.report_id === report.report_id).lifecycle_state, 'resolved');
      assert.equal(inputNotices(h).length, 1);
      assert.notEqual(h.state(), 'needs_attention');
      assert.equal(h.store.listReports({ include_resolved: true }).some(r => ['done', 'review_findings'].includes(r.kind)), false);
    });
  }
}

test('Claude reminder adapter is silent even without a primary hook or with an old explicit override', async t => {
  const h = harness(t); await h.ready;
  const { runtime, session_id, meta } = liveClaude('question_reminder');
  for (const native_event of ['Notification', 'permission_required']) {
    const result = await h.recorded({ runtime, native_event,
      payload: { hook_event_name: meta.native_event, notification_type: meta.notification_type, session_id } });
    assert.equal(result.delivered, false);
    assert.equal(result.reason, 'uncorrelated_permission_reminder');
  }
  assert.equal(h.sent.length, 0);
  assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 0);
});

for (const order of ['question_first', 'approval_first']) {
  test(`synthetic Claude ${order}: reminder never merges independent question and approval`, async t => {
    const h = harness(t); await h.ready;
    await h.report({ kind: 'question', report_id: 'helper-declared-unrelated', blocking: true });
    const starts = order === 'question_first' ? ['question_start', 'approval_start'] : ['approval_start', 'question_start'];
    for (const name of starts) {
      await h.hook(liveClaude(name));
      await h.hook(liveClaude('question_reminder'));
    }
    const reports = h.store.listReports({}).filter(r => r.source === 'mh_hook');
    assert.equal(reports.length, 2);
    assert.deepEqual(new Set(reports.map(r => r.kind)), new Set(['question', 'blocked']));
    await h.hook(liveClaude('question_answer'));
    h.restartBridge();
    await h.hook(liveClaude('question_reminder'));
    assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 2, 'the real approval and unrelated helper wait remain');
    assert.equal(h.store.listReports({}).find(r => r.kind === 'blocked').lifecycle_state, 'delivered_to_inbox');
    await h.hook(liveClaude('approval_result'));
    await h.hook(liveClaude('approval_stop'));
    await h.hook(liveClaude('approval_reminder'));
    assert.deepEqual(h.store.listReports({}).filter(r => r.blocking).map(r => r.report_id), ['helper-declared-unrelated']);
    assert.equal(inputNotices(h).length, 3);
    assert.equal(h.state(), 'needs_attention');
  });
}

test('Claude reminders do not erase identical simultaneous requests with distinct native IDs', async t => {
  const h = harness(t); await h.ready;
  const start = liveClaude('question_start'), result = liveClaude('question_answer');
  await h.hook(start);
  await h.hook({ ...start, meta: { ...start.meta, request_id: 'independent-question' } });
  await h.hook(liveClaude('question_reminder'));
  await h.hook(result);
  await h.hook(liveClaude('question_reminder'));
  assert.deepEqual(h.store.listReports({}).filter(r => r.blocking).map(r => r.request_id), ['independent-question']);
  assert.equal(h.state(), 'needs_attention');
  await h.hook({ ...result, meta: { ...result.meta, request_id: 'independent-question' } });
  assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 0);
  assert.equal(inputNotices(h).length, 2);
});

test('Claude reminder leaves ambiguous concurrent ID-less approvals separate and unresolved', async t => {
  const h = harness(t); await h.ready;
  const start = liveClaude('approval_start');
  await h.hook(start);
  await h.hook(start); // Distinct primary occurrences; identical input is insufficient identity.
  await h.hook(liveClaude('approval_reminder'));
  await h.hook(liveClaude('approval_result'));
  await h.hook(liveClaude('approval_stop'));
  await h.hook(liveClaude('approval_reminder'));
  assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 2);
  assert.equal(inputNotices(h).length, 2);
  assert.equal(h.state(), 'needs_attention');
});

for (const order of ['native_first', 'terminal_first']) {
  test(`Claude missing terminal identity, ${order}: do not guess away an independent approval`, async t => {
    const h = harness(t); await h.ready;
    const native = liveClaude('approval_start');
    const observed = claudeTerminalAmbiguity.reports.find(r => r.source === 'stuck_detector');
    assert.equal(observed.action_fingerprint, null, 'recorded terminal metadata has no action identity');
    assert.equal(native.meta.action_fingerprint, claudeTerminalAmbiguity.reports.find(r => r.source === 'mh_hook').action_fingerprint);
    // Only source/kind/null identity are replayed. Pane/occurrence and order
    // are synthetic, since the live collector did not preserve command rows.
    const terminal = () => h.report({ kind: observed.kind, source: observed.source, blocking: true,
      report_id: 'unknown-terminal-approval', action_fingerprint: observed.action_fingerprint,
      observation_key: 'synthetic-occurrence', pane_id: '%7', assignment_key: 'synthetic-assignment' });
    await h.native(familyCases[1], 'PermissionRequest', 'independent-approval',
      { tool_name: 'Bash', tool_input: { command: 'printf INDEPENDENT' } });
    if (order === 'terminal_first') await terminal();
    await h.hook(native);
    if (order === 'native_first') await terminal();
    assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 3,
      'same helper, mission, approval kind and close arrival do not prove identity');
    assert.equal(inputNotices(h).length, 3, 'this safety case retains the known duplicate; it is not an acceptance pass');
    h.restartBridge();
    await h.hook(liveClaude('approval_result'));
    const pending = () => h.store.listReports({}).filter(r => r.blocking);
    assert.equal(pending().length, 2);
    assert.equal(pending().find(r => r.report_id === 'unknown-terminal-approval').source, 'stuck_detector');
    assert.equal(pending().some(r => r.request_id === 'independent-approval'), true);
    await h.hook(liveClaude('approval_stop'));
    assert.equal(pending().length, 2, 'Stop cannot sweep ambiguous or independent waits');
    await h.pipeline.resolveObservedInput({ agentId: 'helper', streamId: 'stream', missionId: 'mission',
      reportId: 'unknown-terminal-approval' });
    assert.deepEqual(pending().map(r => r.request_id), ['independent-approval']);
    assert.equal(h.state(), 'needs_attention');
    assert.equal(h.store.listReports({ include_resolved: true }).some(r => ['done', 'review_findings'].includes(r.kind)), false);
  });
}

for (const order of ['native_first', 'terminal_first']) {
  test(`synthetic Claude Bash box ${order}: one wait and notice, selection stable, exact resolution`, async t => {
    const h = harness(t); await h.ready;
    await h.native(familyCases[1], 'PreToolUse', 'independent-question');
    let lines = claudeBox.lines;
    const detector = createHelperStuckDetector({ runtime: { listAgents: () => [{ id: 'helper', pane_id: '%7', status: 'active' }],
      paneSnapshot: async () => ({ lines }) }, inboxStore: h.store, assignmentStore: h.assignments,
      submitReport: h.pipeline.submitReport, resolveReport: h.pipeline.resolveObservedInput, log });
    const extra = { tool_name: 'Bash', tool_use_id: undefined, tool_input: { command: claudeBox.command } };
    if (order === 'terminal_first') await detector.tick();
    await h.native(familyCases[1], 'PermissionRequest', 'approval', extra);
    if (order === 'native_first') await detector.tick();
    assert.equal(h.store.listReports({}).filter(r => r.kind === 'blocked').length, 1);
    lines = lines.map(line => line.replace('❯ 1.', '  1.').replace('  2.', '❯ 2.'));
    await detector.tick();
    assert.equal(h.store.listReports({}).filter(r => r.kind === 'blocked').length, 1, 'selection movement is the same modal');
    assert.equal(inputNotices(h).length, 2, 'one question and one approval notice');
    await h.native(familyCases[1], 'PostToolUse', 'approval', { ...extra, tool_use_id: 'approval' });
    assert.equal(h.store.listReports({}).filter(r => r.kind === 'blocked').length, 0);
    assert.equal(h.store.listReports({}).filter(r => r.kind === 'question').length, 1);
    assert.equal(h.state(), 'needs_attention');
  });
}

for (const mode of ['multiline_native', 'different_command', 'ambiguous_native', 'missing_box_border', 'quoted_heading']) {
  test(`Claude Bash box: ${mode} cannot justify merging independent approvals`, async t => {
    const h = harness(t); await h.ready;
    const command = mode === 'multiline_native' ? claudeBox.command.replace(' > ', ' >\n') :
      mode === 'different_command' ? claudeBox.command + ' extra' : claudeBox.command;
    for (let n = 0; n < (mode === 'ambiguous_native' ? 2 : 1); n++) {
      await h.native(familyCases[1], 'PermissionRequest', String(n), { tool_name: 'Bash', tool_input: { command } });
    }
    const lines = mode === 'missing_box_border' ? claudeBox.lines.map(line => /^╌/.test(line) ? '' : line) :
      mode === 'quoted_heading' ? claudeBox.lines.map(line => line.trim() === 'Do you want to proceed?' ? 'Quoted: Do you want to proceed?' : line) : claudeBox.lines;
    const detector = createHelperStuckDetector({ runtime: { listAgents: () => [{ id: 'helper', pane_id: '%7', status: 'active' }],
      paneSnapshot: async () => ({ lines }) }, inboxStore: h.store, assignmentStore: h.assignments,
      submitReport: h.pipeline.submitReport, resolveReport: h.pipeline.resolveObservedInput, log });
    await detector.tick();
    assert.equal(h.store.listReports({}).filter(r => r.blocking).length, mode === 'ambiguous_native' ? 3 : 2);
  });
}

test('Claude Bash box occurrence includes its command and preserves distinct quoted whitespace', async t => {
  const h = harness(t); await h.ready;
  let command='printf "a  b"';
  const makeLines=()=>['Bash command','╌'.repeat(30),' │ '+command,'╌'.repeat(30),'Do you want to proceed?',' ❯ 1. Yes','   2. No'];
  const detector=createHelperStuckDetector({runtime:{listAgents:()=>[{id:'helper',pane_id:'%7',status:'active'}],paneSnapshot:async()=>({lines:makeLines()})},inboxStore:h.store,assignmentStore:h.assignments,submitReport:h.pipeline.submitReport,log});
  await detector.tick();command='printf "a b"';await detector.tick();
  assert.equal(h.store.listReports({}).filter(r=>r.blocking).length,2);
});

for (const family of familyCases) {
  test(`synthetic ${family.runtime}: unanswered choice survives speech, TTS and Stop; only matching tool resolves`, async t => {
    const h = harness(t);
    const questions = [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }];
    const extra = family.runtime === 'antigravity'
      ? { toolCall: { name: family.tool, args: { questions } } } : family.input(questions);
    await h.native(family, 'PreToolUse', '1', extra);
    const question = h.store.listReports({}).find(r => r.kind === 'question');
    assert.equal(question.blocking, true);
    assert.equal(question.input_kind, 'choice_single');
    assert.equal(question.source, 'mh_hook');
    assert.equal(h.state(), 'needs_attention');
    assert.equal(h.transient.get('helper').message, 'choice required');
    assert.equal(h.sent.filter(p => p.type === 'say').length, 1, 'only the owner announces a helper wait');
    h.server.broadcast({ type: 'tts_state', agent_id: 'helper', phase: 'play_start' });
    h.server.broadcast({ type: 'tts_state', agent_id: 'helper', phase: 'play_stop' });
    h.server.broadcast({ type: 'event', agent_id: 'helper', name: 'prompt_idle' });
    assert.equal(h.transient.get('helper').needsAttention, true);
    assert.equal(h.transient.get('helper').inputPending, true);
    h.server.broadcast({ type: 'event', agent_id: 'helper', name: 'cmd_succeeded' });
    assert.equal(h.state(), 'needs_attention', 'an unrelated checkpoint cannot answer a pending question');
    await h.native(family, 'Stop', '1', { fullyIdle: false, background_tasks: [{ id: 'background' }] });
    assert.equal(h.state(), 'needs_attention');
    assert.equal(h.store.listReports({}).some(r => r.kind === 'done'), false);
    assert.equal(h.sent.some(p => p.meta?.report_kind === 'done'), false);
    await h.native(family, 'PostToolUse', '2', extra);
    assert.equal(h.state(), 'needs_attention', 'unrelated tool ID cannot answer the question');
    const wrongTool = family.runtime === 'antigravity' ? { toolCall: { name: 'run_command' } } : { tool_name: 'other' };
    await h.native(family, 'PostToolUse', '1', wrongTool);
    assert.equal(h.state(), 'needs_attention', 'tool name must match too');
    h.restartBridge(); // Durable waits must still resolve after bridge recreation.
    await h.native(family, 'PostToolUse', '1');
    assert.notEqual(h.state(), 'needs_attention');
    assert.equal(h.assignments.getAssignment({ stream_id: 'stream', mission_id: 'mission' }).last_report_kind, 'progress');
    await h.report({ kind: 'done', report_id: 'final' });
    assert.equal(h.state(), 'awaiting_review');
  });

  test(`synthetic ${family.runtime}: native approval is distinct from a question and is not completion`, async t => {
    const h = harness(t);
    const approvalTool = family.runtime === 'antigravity' ? 'ask_permission' : 'shell';
    const extra = family.runtime === 'antigravity' ? { toolCall: { name: approvalTool } } : { tool_name: approvalTool };
    await h.native(family, family.runtime === 'antigravity' ? 'PreToolUse' : 'PermissionRequest', '1', extra);
    const report = h.store.listReports({}).find(r => r.kind === 'blocked');
    assert.equal(report.attention_kind, 'approval');
    assert.equal(h.state(), 'needs_attention');
    assert.ok(h.sent.some(p => p.name === 'permission_required' && p.meta?.report_kind === 'blocked'));
    assert.equal(h.sent.some(p => p.name === 'cmd_succeeded'), false);
    await h.native(family, 'Stop');
    assert.equal(h.state(), 'needs_attention');
  });

  test(`synthetic ${family.runtime}: detector reaches real store, assignment and owner notification once`, async t => {
    const h = harness(t, { ack: false });
    const detector = createHelperStuckDetector({
      runtime: { listAgents: () => [{ id: 'helper', pane_id: '%7', stream_id: 'stream', status: 'active' }],
        paneSnapshot: async () => ({ lines: [family.modal, '1. Yes', '2. No'] }) },
      inboxStore: h.store, assignmentStore: h.assignments, submitReport: h.pipeline.submitReport, log
    });
    await detector.tick(); await detector.tick();
    const assignment = h.assignments.getAssignment({ stream_id: 'stream', mission_id: 'mission' });
    assert.equal(assignment.last_report_kind, 'blocked');
    assert.equal(assignment.delivery_state, 'sent_to_tmux', 'a detector notice is not a helper acknowledgment');
    assert.equal(h.state(), 'needs_attention', 'must not stay thinking or awaiting_ack');
    const reports = h.store.listReports({});
    assert.equal(reports.length, 1); assert.equal(reports[0].blocking, true);
    assert.equal(reports[0].source, 'stuck_detector');
    assert.equal(h.sent.filter(p => p.type === 'say').length, 1);
  });
}

test('report pipeline does not announce rejected/idempotent reports or regress a newer assignment', async t => {
  const h = harness(t); await h.ready;
  await h.report({ kind: 'question', report_id: 'question' });
  await h.report({ kind: 'done', report_id: 'done' });
  const before = h.sent.length;
  await h.report({ kind: 'question', report_id: 'question' });
  assert.equal(h.sent.length, before);
  assert.equal(h.assignments.getAssignment({ stream_id: 'stream', mission_id: 'mission' }).last_report_kind, 'done');
  const rejected = await h.report({ mission_id: 'unregistered', kind: 'blocked' });
  assert.equal(rejected.transport_state, 'rejected'); assert.equal(h.sent.length, before);
});

test('report remains accepted when announcement fails', async t => {
  const h = harness(t); await h.ready;
  const pipeline = createOwnerReportPipeline({ store: h.store, assignmentStore: h.assignments,
    notify: async () => { throw new Error('speaker unavailable'); }, log });
  const result = await pipeline.submitReport({ stream_id: 'stream', mission_id: 'mission', from_agent_id: 'helper',
    owner_agent_id: '__operator__', kind: 'blocked', summary: 'Need input' });
  assert.equal(result.transport_state, 'accepted'); assert.equal(h.state(), 'needs_attention');
});

test('overlapping questions are resolved individually, not by another tool or invocation', async t => {
  const h = harness(t), family = familyCases[2];
  await h.native(family, 'PreToolUse', '1'); await h.native(family, 'PreToolUse', '2');
  await h.native(family, 'PreInvocation', '3');
  assert.equal(h.store.listReports({}).filter(r => r.kind === 'question').length, 2);
  await h.native(family, 'PostToolUse', '1'); assert.equal(h.state(), 'needs_attention');
  await h.native(family, 'PostToolUse', '2'); assert.notEqual(h.state(), 'needs_attention');
});

test('notification subtypes, missing identities, failures and incomplete Stop fields are conservative', () => {
  const classify = (runtime, payload, explicitEvent) => classifyAgentHook({ runtime, payload, explicitEvent });
  for (const notification_type of ['auth_success', 'elicitation_complete', 'elicitation_response', 'agent_completed', 'quota_auto_resume_complete', undefined]) {
    assert.equal(classify('claude', { hook_event_name: 'Notification', notification_type }, 'permission_required').event, null);
  }
  assert.equal(classify('claude', { hook_event_name: 'Notification', notification_type: 'idle_prompt' }, 'permission_required').event, 'idle_after_response');
  assert.equal(classify('claude', { hook_event_name: 'Notification', notification_type: 'elicitation_dialog' }).event, 'input_required');
  assert.equal(classify('codex', { hook_event_name: 'Notification', notification_type: 'permission_prompt' }).event, null);
  assert.equal(classify('antigravity', { hook_event_name: 'PermissionRequest' }).event, null);
  assert.equal(classify('codex', { hook_event_name: 'PostToolUse', tool_name: 'request_user_input' }).event, null);
  assert.equal(classify('codex', { hook_event_name: 'PostToolUse', tool_name: 'request_user_input', tool_input: 'null' }).event, null);
  const stop = classify('claude', { hook_event_name: 'Stop' });
  assert.equal(stop.event, 'idle_after_response'); assert.equal('background_tasks_count' in stop.meta, false);
  assert.equal(classify('antigravity', { fullyIdle: false, terminationReason: 'model_stop' }, 'Stop').meta.fully_idle, false);
  assert.equal(classify('antigravity', { terminationReason: 'error' }, 'Stop').event, 'turn_failed');
  assert.equal(classify('claude', { hook_event_name: 'StopFailure' }).event, 'turn_failed');
  assert.equal(classify('codex', { hook_event_name: 'StopFailure' }).event, null);
});

test('agy observation hooks emit no approval decisions or tool-input mutations', async () => {
  let stdout = '';
  for (const name of ['ask_question', 'ask_permission']) {
    const result = await runHookCli({ argv: ['--runtime', 'antigravity', '--stdout-mode', 'silent', '--event', 'PreToolUse'],
      inputText: JSON.stringify({ conversationId: 's', stepIdx: 1, toolCall: { name, args: {} } }),
      env: { MH_FACE_AGENT_ID: 'helper' }, stdout: { write: text => { stdout += text; } }, stderr: { write() {} }, send: async () => {} });
    assert.equal(result.delivered, true);
  }
  assert.equal(stdout, '');
});

test('hook report retries a temporary store failure without duplicating accepted input', async t => {
  const h = harness(t); await h.ready;
  const restore = failNextStateWrite(t, h.store);
  const family = familyCases[1];
  const first = await h.native(family, 'PreToolUse');
  restore();
  assert.equal(first.bridgeResult.inbox_posted, false);
  assert.equal(h.transient.get('helper').needsAttention, true);
  assert.equal(h.store.listReports({}).some(r => r.kind === 'question'), false);
  assert.equal(JSON.parse(fs.readFileSync(h.store.statePath)).reports.some(r => r.kind === 'question'), false);
  const second = await h.native(family, 'PreToolUse');
  assert.equal(second.bridgeResult.inbox_posted, true);
  const third = await h.native(family, 'PreToolUse');
  assert.equal(third.bridgeResult.reason, 'input_already_pending');
  assert.equal(h.store.listReports({}).filter(r => r.kind === 'question').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(h.store.statePath)).reports.filter(r => r.kind === 'question').length, 1);
});

test('HTTP report handling uses the same accepted-report state and notification pipeline without a listener', async t => {
  const h = harness(t); await h.ready;
  const api = createOwnerInboxApi({ store: h.store, submitReport: h.pipeline.submitReport });
  const request = Readable.from([Buffer.from(JSON.stringify({ stream_id: 'stream', mission_id: 'mission',
    owner_agent_id: '__operator__', from_agent_id: 'helper', kind: 'question', summary: 'Choose a route',
    attention_kind: 'choice', input_kind: 'choice_single' }))]);
  request.method = 'POST'; request.url = '/api/owner-inbox/report'; request.headers = {};
  let response;
  await api.handleHttpRequest(request, { writeHead(code) { assert.equal(code, 200); }, end(body) { response = JSON.parse(body); } });
  assert.equal(response.result.transport_state, 'accepted');
  assert.equal(h.state(), 'needs_attention');
  const event = h.sent.find(p => p.type === 'event' && p.meta?.report_kind === 'question');
  assert.equal(event.name, 'needs_attention'); assert.equal(event.meta.attention_kind, 'choice');
});

test('multi-choice and uncorrelated input remain pending across unrelated user submissions', async t => {
  const h = harness(t), family = familyCases[1];
  await h.native(family, 'PreToolUse', '1', { tool_use_id: undefined,
    tool_input: { questions: [{ multiSelect: true, options: [{ label: 'A' }] }] } });
  const question = h.store.listReports({}).find(r => r.kind === 'question');
  assert.equal(question.input_kind, 'choice_multi');
  await h.native(family, 'PostToolUse', '1', { tool_use_id: undefined });
  assert.equal(h.state(), 'needs_attention');
  await h.native(family, 'UserPromptSubmit', '1', { session_id: 'other' });
  assert.equal(h.state(), 'needs_attention');
  await h.native(family, 'UserPromptSubmit');
  assert.equal(h.state(), 'needs_attention');
});

test('retry finishes a partially persisted hook report and announces once without replaying old reports', async t => {
  const h = harness(t); await h.ready;
  const restore = failNextStateWrite(t, h.assignments);
  const family = familyCases[1];
  await h.native(family, 'PreToolUse');
  restore();
  assert.equal(h.sent.filter(p => p.meta?.report_kind === 'question').length, 0);
  assert.equal(h.assignments.getAssignment({ stream_id: 'stream', mission_id: 'mission' }).last_report_kind, 'progress');
  await h.native(family, 'PreToolUse');
  await h.native(family, 'PreToolUse');
  assert.equal(h.assignments.getAssignment({ stream_id: 'stream', mission_id: 'mission' }).last_report_kind, 'question');
  assert.equal(JSON.parse(fs.readFileSync(h.assignments.statePath)).assignments[0].last_report_kind, 'question');
  assert.equal(h.sent.filter(p => p.type === 'event' && p.meta?.report_kind === 'question').length, 1);
});

test('a slow announcement cannot block durable answer resolution', async t => {
  const h = harness(t); await h.ready;
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const speaking = new Promise(resolve => { release = resolve; });
  const pipeline = createOwnerReportPipeline({ store: h.store, assignmentStore: h.assignments,
    notify: async () => { started(); await speaking; }, log });
  const submission = pipeline.submitReport({ stream_id: 'stream', mission_id: 'mission',
    owner_agent_id: '__operator__', from_agent_id: 'helper', kind: 'question', summary: 'Question',
    source: 'mh_hook', session_id: 'session', request_id: 'q', tool_name: 'AskUserQuestion' });
  await ready;
  const resolved = await pipeline.resolveInputs({ agentId: 'helper', sessionId: 'session', requestId: 'q', toolName: 'AskUserQuestion' });
  assert.equal(resolved.resolved, 1);
  release(); await submission;
});

for (const family of familyCases.slice(0, 2)) {
  test(`synthetic ${family.runtime}: identical native waits without IDs remain ambiguous after successful posting`, async t => {
    const h = harness(t);
    const extra = { tool_use_id: undefined, tool_input: { questions: [{ question: 'Same question?' }] } };
    await h.native(family, 'PreToolUse', '1', extra);
    await h.native(family, 'PreToolUse', '2', extra);
    assert.equal(h.store.listReports({}).filter(r => r.kind === 'question').length, 2);
    await h.native(family, 'PostToolUse', '3', extra);
    assert.equal(h.store.listReports({}).filter(r => r.kind === 'question').length, 2);
    assert.equal(h.state(), 'needs_attention');
    await h.native(family, 'UserPromptSubmit');
    assert.equal(h.store.listReports({}).filter(r => r.kind === 'question').length, 2);
    assert.equal(h.state(), 'needs_attention');
  });

  test(`synthetic ${family.runtime}: approval without tool ID resolves only with a unique matching structured input`, async t => {
    const h = harness(t);
    const tool_input = { command: 'echo sensitive-placeholder', nested: { b: 2, a: 1 } };
    await h.native(family, 'PermissionRequest', '1', { tool_name: 'shell', tool_use_id: undefined, tool_input });
    assert.equal(h.state(), 'needs_attention');
    assert.equal(h.store.listReports({}).find(r => r.kind === 'blocked').tool_fingerprint.length, 64);
    await h.native(family, 'PostToolUse', '2', { tool_name: 'shell', tool_input: { command: 'other' } });
    assert.equal(h.state(), 'needs_attention');
    await h.native(family, 'PostToolUse', '3', { tool_name: 'shell',
      tool_input: { nested: { a: 1, b: 2 }, command: 'echo sensitive-placeholder' } });
    assert.notEqual(h.state(), 'needs_attention');
    assert.equal(JSON.stringify(h.sent).includes('sensitive-placeholder'), false, 'raw tool arguments are not forwarded');
  });
}

test('Claude AskUserQuestion permission transport is not a second approval', async t => {
  const h = harness(t), family = familyCases[1];
  await h.native(family, 'PreToolUse');
  await h.native(family, 'PermissionRequest');
  const assignment = h.assignments.getAssignment({ stream_id: 'stream', mission_id: 'mission' });
  assert.equal(assignment.last_report_kind, 'question');
  assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 1);
  await h.native(family, 'PostToolUse');
  assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 0);
  assert.notEqual(h.state(), 'needs_attention');
});

test('ambiguous requests without native IDs cannot be resolved by a shared input fingerprint', async t => {
  const h = harness(t); await h.ready;
  for (const summary of ['First question', 'Second question']) {
    await h.report({ kind: 'question', summary, source: 'mh_hook', session_id: 'session',
      tool_name: 'AskUserQuestion', tool_fingerprint: 'same-input' });
  }
  const result = await h.pipeline.resolveInputs({ agentId: 'helper', sessionId: 'session',
    requestId: 'native-result', toolName: 'AskUserQuestion', fingerprint: 'same-input' });
  assert.equal(result.resolved, 0); assert.equal(result.remaining, 2);
  assert.equal(h.state(), 'needs_attention');
});

test('identical no-ID input waits remain distinct while an earlier announcement is in flight', async t => {
  let release, started;
  const speaking = new Promise(resolve => { release = resolve; });
  const firstStarted = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  const h = harness(t, { afterNotify: async report => {
    if (report.kind === 'question') { started(); await speaking; }
  } });
  await h.ready;
  const family = familyCases[1];
  const extra = { tool_use_id: undefined, tool_input: { questions: [{ question: 'Same question?' }] } };
  const first = h.native(family, 'PreToolUse', '1', extra);
  await firstStarted;
  const original = h.store.submitReport;
  let persisted;
  const secondPersisted = new Promise(resolve => { persisted = resolve; });
  h.store.submitReport = input => { const result = original(input); persisted(); return result; };
  const second = h.native(family, 'PreToolUse', '2', extra);
  await secondPersisted;
  assert.equal(h.store.listReports({}).filter(r => r.kind === 'question').length, 2);
  await h.native(family, 'PostToolUse', '3', extra);
  assert.equal(h.store.listReports({}).filter(r => r.kind === 'question').length, 2);
  assert.equal(h.state(), 'needs_attention');
  release();
  await Promise.all([first, second]);
});

test('answer redelivery repairs a partial resolution instead of leaving assignment attention stuck', async t => {
  const h = harness(t), family = familyCases[1];
  await h.native(family, 'PreToolUse');
  const restore = failNextStateWrite(t, h.assignments);
  const failed = await h.native(family, 'PostToolUse');
  restore();
  assert.equal(failed.delivered, false);
  assert.equal(h.state(), 'needs_attention');
  await h.native(family, 'PostToolUse');
  assert.notEqual(h.state(), 'needs_attention');
  assert.equal(h.assignments.getAssignment({ stream_id: 'stream', mission_id: 'mission' }).last_report_kind, 'progress');
  assert.equal(JSON.parse(fs.readFileSync(h.assignments.statePath)).assignments[0].last_report_kind, 'progress');
});

test('failed answer persistence retains the durable wait and retries the actual inbox resolution', async t => {
  const h = harness(t), family = familyCases[1];
  await h.native(family, 'PreToolUse');
  const restore = failNextStateWrite(t, h.store);
  const failed = await h.native(family, 'PostToolUse');
  restore();
  assert.equal(failed.delivered, false);
  assert.equal(h.store.listReports({}).filter(r => r.kind === 'question').length, 1);
  assert.equal(h.state(), 'needs_attention');
  await h.native(family, 'PostToolUse');
  assert.equal(h.store.listReports({}).filter(r => r.kind === 'question').length, 0);
  const persisted = JSON.parse(fs.readFileSync(h.store.statePath)).reports.find(r => r.kind === 'question');
  assert.equal(persisted.lifecycle_state, 'resolved');
  assert.notEqual(h.state(), 'needs_attention');
});

const waits = h => h.store.listReports({}).filter(r => r.blocking);
const allWaits = h => h.store.listReports({ include_resolved: true }).filter(r => r.blocking);

test('synthetic Claude question has one owner entry and the answer resolves it despite changed input', async t => {
  const h = harness(t);
  for (const row of recordings.claude_question) {
    await h.recorded(row);
    if (['PreToolUse', 'PermissionRequest'].includes(row.native_event)) {
      assert.equal(waits(h).length, 1);
      assert.equal(waits(h)[0].kind, 'question');
    }
  }
  assert.equal(allWaits(h).length, 1);
  assert.equal(waits(h).length, 0);
  assert.equal(h.store.listReports({}).some(r => r.kind === 'done'), false);
});

test('synthetic Claude manual denial resolves its own batch only, including after bridge restart', async t => {
  const h = harness(t);
  await h.native(familyCases[1], 'PreToolUse', 'other-question');
  for (const row of recordings.claude_denied_batch) {
    await h.recorded(row);
    if (row.native_event === 'PermissionRequest') {
      assert.equal(waits(h).filter(r => r.kind === 'blocked').length, 1);
      h.restartBridge();
    }
    if (row.native_event === 'PostToolBatch') {
      assert.equal(waits(h).filter(r => r.kind === 'blocked').length, 0);
      assert.equal(waits(h).filter(r => r.kind === 'question').length, 1);
    }
  }
  assert.equal(waits(h).length, 1);
  assert.equal(h.state(), 'needs_attention');
  assert.equal(h.store.listReports({}).some(r => r.kind === 'done'), false);
});

test('synthetic agy command modal appears once and denial resolves only its observed occurrence', async t => {
  const h = harness(t); await h.ready;
  await h.native(familyCases[2], 'PreToolUse', '100');
  let lines = recordings.agy_approval_screen;
  const detector = createHelperStuckDetector({
    runtime: { listAgents: () => [{ id: 'helper', pane_id: '%7', stream_id: 'stream', status: 'active' }],
      paneSnapshot: async () => ({ lines }) },
    inboxStore: h.store, assignmentStore: h.assignments, submitReport: h.pipeline.submitReport,
    resolveReport: h.pipeline.resolveObservedInput, log
  });
  for (const row of recordings.agy_command.filter(r => r.native_event !== 'Stop')) await h.recorded(row);
  await detector.tick(); await detector.tick();
  assert.equal(waits(h).filter(r => r.source === 'stuck_detector').length, 1);
  assert.equal(h.state(), 'needs_attention');
  lines = []; await detector.tick(); // Capture loss is not a user decision.
  assert.equal(waits(h).filter(r => r.source === 'stuck_detector').length, 1);
  lines = recordings.agy_after_denial_screen; await detector.tick();
  assert.equal(waits(h).filter(r => r.source === 'stuck_detector').length, 0);
  assert.equal(waits(h).filter(r => r.kind === 'question').length, 1);
  assert.equal(h.state(), 'needs_attention');
  assert.equal(h.store.listReports({}).some(r => r.kind === 'done'), false);
});

for (const [name, records] of [['Codex', recordings.codex_question], ['agy', recordings.agy_question]]) {
  test(`synthetic ${name} question is one entry and matching answer clears it without completing mission`, async t => {
    const h = harness(t);
    for (const row of records) {
      await h.recorded(row);
      if (row.native_event === 'PreToolUse' && ['request_user_input', 'ask_question'].includes(row.payload.tool_name ?? row.payload.toolCall?.name)) {
        assert.equal(waits(h).length, 1);
        assert.equal(h.state(), 'needs_attention');
      }
    }
    assert.equal(allWaits(h).length, 1);
    assert.equal(waits(h).length, 0);
    assert.equal(h.store.listReports({}).some(r => r.kind === 'done'), false);
  });
}

test('synthetic Claude allowed command clears its one approval without marking the mission done', async t => {
  const h = harness(t);
  for (const row of recordings.claude_allowed) {
    await h.recorded(row);
    if (row.native_event === 'PermissionRequest') assert.equal(waits(h).length, 1);
  }
  assert.equal(allWaits(h).length, 1);
  assert.equal(waits(h).length, 0);
  assert.equal(h.store.listReports({}).some(r => r.kind === 'done'), false);
});

test('synthetic Codex refusal resolves its interrupted turn, leaves other turn/session waits, and never completes the mission', async t => {
  const h = harness(t);
  const rows = recordings.codex_denied;
  const permission = rows.find(row => row.native_event === 'PermissionRequest');
  const session_id = permission.payload.session_id;
  const turn_id = permission.payload.turn_id;
  await h.native(familyCases[0], 'PreToolUse', 'other-turn', { session_id, turn_id: 'other-turn' });
  await h.native(familyCases[0], 'PermissionRequest', 'other-session', { session_id: 'other-session', turn_id, tool_name: 'Bash' });
  for (const row of rows) {
    await h.recorded(row);
    if (row.native_event === 'PermissionRequest') {
      assert.equal(waits(h).filter(r => r.session_id === session_id && r.turn_id === turn_id).length, 1);
      h.restartBridge();
    }
    if (row.native_event === 'Interrupt') {
      assert.equal(waits(h).some(r => r.session_id === session_id && r.turn_id === turn_id), false);
      assert.equal(waits(h).length, 2);
    }
  }
  assert.equal(h.state(), 'needs_attention');
  assert.equal(h.store.listReports({}).some(r => r.kind === 'done'), false);
});

test('synthetic Codex refusal alone returns the dashboard to idle like the real CLI while its mission remains unfinished', async t => {
  const h = harness(t);
  for (const row of recordings.codex_denied) await h.recorded(row);
  assert.equal(allWaits(h).length, 1);
  assert.equal(waits(h).length, 0);
  assert.equal(h.transient.get('helper').inputPending, false);
  assert.equal(h.state(), 'idle');
  assert.equal(h.assignments.getAssignment({ stream_id: 'stream', mission_id: 'mission' }).last_report_kind, 'progress');
  assert.ok(recordings.codex_after_denial_screen.some(line => line.includes('Conversation interrupted')));
  assert.ok(recordings.codex_after_denial_screen.some(line => line.includes('Ask Codex to do anything')));
});

test('synthetic Codex allowed command clears its one approval and Stop does not complete the mission', async t => {
  const h = harness(t);
  for (const row of recordings.codex_allowed) {
    await h.recorded(row);
    if (row.native_event === 'PermissionRequest') assert.equal(waits(h).length, 1);
    if (row.native_event === 'PostToolUse') assert.equal(waits(h).length, 0);
  }
  assert.equal(allWaits(h).length, 1);
  assert.equal(h.store.listReports({}).some(r => r.kind === 'done'), false);
});

test('synthetic Codex native approval plus visible detector observation produces one owner entry', async t => {
  const h = harness(t);
  for (const row of recordings.codex_allowed) {
    if (row.native_event === 'PostToolUse') break;
    await h.recorded(row);
  }
  const detector = createHelperStuckDetector({
    runtime: { listAgents: () => [{ id: 'helper', pane_id: '%7', stream_id: 'stream', status: 'active' }],
      paneSnapshot: async () => ({ lines: recordings.codex_approval_screen }) },
    inboxStore: h.store, assignmentStore: h.assignments, submitReport: h.pipeline.submitReport,
    resolveReport: h.pipeline.resolveObservedInput, log
  });
  await detector.tick(); await detector.tick();
  assert.equal(waits(h).length, 1);
  assert.equal(allWaits(h).length, 1);
  assert.equal(h.sent.filter(p => p.type === 'event' && p.meta?.report_kind === 'blocked').length, 1);
});

test('synthetic agy allow closes the one observed modal, preserves another question and reports activity while CLI is running', async t => {
  const h = harness(t); await h.ready;
  await h.native(familyCases[2], 'PreToolUse', '100');
  let lines = recordings.agy_allow_approval_screen;
  const resolved = [];
  const detector = createHelperStuckDetector({
    runtime: { listAgents: () => [{ id: 'helper', pane_id: '%7', stream_id: 'stream', status: 'active' }],
      paneSnapshot: async () => ({ lines }) },
    inboxStore: h.store, assignmentStore: h.assignments, submitReport: h.pipeline.submitReport,
    resolveReport: h.pipeline.resolveObservedInput, onResolved: input => resolved.push(input), log
  });
  for (const row of recordings.agy_allowed) await h.recorded(row);
  await detector.tick(); await detector.tick();
  assert.equal(waits(h).filter(r => r.source === 'stuck_detector').length, 1);
  lines = recordings.agy_after_allow_screen; await detector.tick();
  assert.equal(waits(h).filter(r => r.source === 'stuck_detector').length, 0);
  assert.equal(waits(h).filter(r => r.kind === 'question').length, 1);
  assert.equal(h.state(), 'needs_attention');
  assert.equal(resolved[0].promptIdle, false, 'visible Running remains activity, even with an empty input row');
  assert.equal(h.store.listReports({}).some(r => r.kind === 'done'), false);
});

test('synthetic Codex detector-first/native-second observations share one durable entry even across bridge restart', async t => {
  const h = harness(t); await h.ready;
  const detector = createHelperStuckDetector({
    runtime: { listAgents: () => [{ id: 'helper', pane_id: '%7', stream_id: 'stream', status: 'active' }],
      paneSnapshot: async () => ({ lines: recordings.codex_approval_screen }) },
    inboxStore: h.store, assignmentStore: h.assignments, submitReport: h.pipeline.submitReport,
    resolveReport: h.pipeline.resolveObservedInput, log
  });
  await detector.tick();
  const id = waits(h)[0].report_id;
  const permission = recordings.codex_allowed.find(row => row.native_event === 'PermissionRequest');
  await h.recorded(permission);
  assert.equal(allWaits(h).length, 1);
  assert.equal(waits(h)[0].report_id, id);
  assert.equal(waits(h)[0].session_id, permission.payload.session_id);
  assert.equal(h.sent.filter(p => p.type === 'event' && p.meta?.report_kind === 'blocked').length, 1);
  h.restartBridge();
  await h.recorded(recordings.codex_allowed.find(row => row.native_event === 'PostToolUse'));
  assert.equal(waits(h).length, 0);
});

test('native question redelivery after bridge restart keeps one entry and one owner announcement', async t => {
  const h = harness(t), family = familyCases[1];
  await h.native(family, 'PreToolUse'); h.restartBridge(); await h.native(family, 'PreToolUse');
  assert.equal(allWaits(h).length, 1);
  assert.equal(h.sent.filter(p => p.type === 'event' && p.meta?.report_kind === 'question').length, 1);
});

test('synthetic agy detector restart recovers its exact occurrence and a failed resolution is retried', async t => {
  const h = harness(t); await h.ready;
  let lines = recordings.agy_approval_screen;
  const options = {
    runtime: { listAgents: () => [{ id: 'helper', pane_id: '%7', stream_id: 'stream', status: 'active' }],
      paneSnapshot: async () => ({ lines }) },
    inboxStore: h.store, assignmentStore: h.assignments, submitReport: h.pipeline.submitReport,
    resolveReport: h.pipeline.resolveObservedInput, log
  };
  await createHelperStuckDetector(options).tick();
  const detector = createHelperStuckDetector(options); await detector.tick();
  assert.equal(allWaits(h).length, 1);
  lines = recordings.agy_after_denial_screen;
  const restore = failNextStateWrite(t, h.store);
  await detector.tick(); restore();
  assert.equal(waits(h).length, 1);
  await detector.tick();
  assert.equal(waits(h).length, 0);
});

test('observed resolution cannot clear a report from another mission or a helper-declared wait', async t => {
  const h = harness(t); await h.ready;
  await h.report({ kind: 'question', report_id: 'human-question' });
  assert.equal((await h.pipeline.resolveObservedInput({ agentId: 'helper', streamId: 'stream', missionId: 'mission', reportId: 'human-question' })).resolved, 0);
  await h.report({ kind: 'blocked', report_id: 'observation', source: 'stuck_detector' });
  assert.equal((await h.pipeline.resolveObservedInput({ agentId: 'helper', streamId: 'stream', missionId: 'different', reportId: 'observation' })).resolved, 0);
  assert.equal(waits(h).length, 2);
});

test('Bash description is not execution identity, but changed execution parameters do not resolve a wait', async t => {
  const h = harness(t), family = familyCases[0];
  await h.native(family, 'PermissionRequest', '1', { tool_name: 'Bash', tool_use_id: undefined,
    tool_input: { command: 'printf example', timeout_ms: 1000, description: 'Human explanation' } });
  await h.native(family, 'PostToolUse', '2', { tool_name: 'Bash', tool_input: { command: 'printf example', timeout_ms: 2000 } });
  assert.equal(waits(h).length, 1);
  await h.native(family, 'PostToolUse', '2', { tool_name: 'Bash', tool_input: { command: 'printf example', timeout_ms: 1000 } });
  assert.equal(waits(h).length, 0);
});

test('native attachment rolls back on disk failure and retries without duplicating the observed inbox entry', async t => {
  const h = harness(t); await h.ready;
  const detector = createHelperStuckDetector({
    runtime: { listAgents: () => [{ id: 'helper', pane_id: '%7', stream_id: 'stream', status: 'active' }],
      paneSnapshot: async () => ({ lines: recordings.codex_approval_screen }) },
    inboxStore: h.store, assignmentStore: h.assignments, submitReport: h.pipeline.submitReport, log
  });
  await detector.tick();
  const permission = recordings.codex_allowed.find(row => row.native_event === 'PermissionRequest');
  const restore = failNextStateWrite(t, h.store);
  await h.recorded(permission); restore();
  assert.equal(waits(h)[0].source, 'stuck_detector');
  await h.recorded(permission);
  assert.equal(waits(h)[0].source, 'mh_hook');
  assert.equal(allWaits(h).length, 1);
  const saved = JSON.parse(fs.readFileSync(h.store.statePath)).reports.find(r => r.blocking);
  assert.equal(saved.session_id, permission.payload.session_id);
  assert.equal(h.sent.filter(p => p.type === 'event' && p.meta?.report_kind === 'blocked').length, 1);
});

test('an unavailable pane or a different pane cannot resolve an observed wait', async t => {
  const h = harness(t); await h.ready;
  let mode = 'pending', pane = '%7';
  const detector = createHelperStuckDetector({
    runtime: { listAgents: () => [{ id: 'helper', pane_id: pane, stream_id: 'stream', status: 'active' }],
      paneSnapshot: async () => {
        if (mode === 'error') throw new Error('pane unavailable');
        return { lines: mode === 'pending' ? recordings.agy_approval_screen : recordings.agy_after_denial_screen };
      } },
    inboxStore: h.store, assignmentStore: h.assignments, submitReport: h.pipeline.submitReport,
    resolveReport: h.pipeline.resolveObservedInput, log
  });
  await detector.tick(); mode = 'error'; await detector.tick();
  assert.equal(waits(h).length, 1);
  mode = 'clear'; pane = '%8'; await detector.tick();
  assert.equal(waits(h).length, 1);
  pane = '%7'; await detector.tick();
  assert.equal(waits(h).length, 0);
});

for (const family of familyCases) {
  test(`work-start payload cannot accidentally act as a matching answer for ${family.runtime}`, async t => {
    const h = harness(t);
    await h.native(family, 'PreToolUse', '1');
    await h.native(family, family.runtime === 'antigravity' ? 'PreInvocation' : 'UserPromptSubmit', '1');
    assert.equal(waits(h).length, 1);
    assert.equal(h.state(), 'needs_attention');
  });
}

test('redelivery of a known native wait cannot attach itself to a different observed wait for the same action', async t => {
  const h = harness(t); await h.ready;
  const common = { kind: 'blocked', action_fingerprint: 'same-action' };
  await h.report({ ...common, source: 'mh_hook', report_id: 'native', session_id: 's', request_id: 'native-call', tool_name: 'Bash' });
  await h.report({ ...common, source: 'stuck_detector', report_id: 'other-observation', pane_id: '%8' });
  await h.report({ ...common, source: 'mh_hook', report_id: 'native', session_id: 's', request_id: 'native-call', tool_name: 'Bash' });
  assert.equal(waits(h).length, 2);
  assert.equal(waits(h).find(r => r.report_id === 'other-observation').source, 'stuck_detector');
  assert.equal(h.sent.filter(p => p.type === 'event' && p.meta?.report_kind === 'blocked').length, 2);
});

for (const order of ['native-first', 'detector-first']) {
  test(`synthetic Codex wrapped refusal: one notice and exact cancellation, ${order}`, async t => {
    const h = harness(t); await h.ready;
    const permission = wrappedApproval.hooks.find(row => row.native_event === 'PermissionRequest');
    const interrupt = wrappedApproval.hooks.find(row => row.native_event === 'Interrupt');
    const unrelated = { ...permission, payload: { ...permission.payload, turn_id: 'other-turn',
      tool_input: { ...permission.payload.tool_input, command: permission.payload.tool_input.command + '.other' } } };
    await h.report({ kind: 'question', report_id: 'human-question' });
    await h.recorded(unrelated);
    let lines = wrappedApproval.screen;
    const detector = createHelperStuckDetector({
      runtime: { listAgents: () => [{ id: 'helper', pane_id: '%7', stream_id: 'stream', status: 'active' }],
        paneSnapshot: async () => ({ lines }) },
      inboxStore: h.store, assignmentStore: h.assignments, submitReport: h.pipeline.submitReport,
      resolveReport: h.pipeline.resolveObservedInput, log
    });
    if (order === 'native-first') await h.recorded(permission);
    await detector.tick();
    if (order === 'detector-first') await h.recorded(permission);
    await detector.tick();
    assert.equal(allWaits(h).length, 3, 'one matching approval plus two unrelated waits');
    assert.equal(h.sent.filter(p => p.type === 'event' && p.meta?.report_kind === 'blocked').length, 2);
    const matched = waits(h).find(report => report.turn_id === permission.payload.turn_id);
    assert.equal(matched.source, 'mh_hook');
    assert.equal(matched.action_format, 'single_line');
    await h.recorded(interrupt);
    lines = ['• Interrupted', '› '];
    await detector.tick();
    assert.deepEqual(waits(h).map(r => r.report_id).sort(), ['human-question', waits(h).find(r => r.turn_id === 'other-turn').report_id].sort());
    assert.equal(h.state(), 'needs_attention');
    assert.equal(h.store.listReports({ include_resolved: true }).some(r => r.kind === 'done'), false);
  });
}

function codexModal(rows) {
  return ['Would you like to run the following command?', '', '  $ ' + rows[0],
    ...rows.slice(1).map(row => '  ' + row), '', '› 1. Yes, proceed (y)', '  3. No (esc)', 'Press enter to confirm'];
}

for (const [name, command, rows, expected] of [
  ['inside-word wrap', 'printf token > /tmp/long-path', ['printf token > /tmp/long-', 'path'], 1],
  ['quoted whitespace preserved', "printf '%s' 'A  B' > /tmp/token", ["printf '%s' 'A  B' >", '/tmp/token'], 1],
  ['quoted whitespace differs', "printf '%s' 'A  B' > /tmp/token", ["printf '%s' 'A", "B' > /tmp/token"], 2],
  ['native newline never flattened', "printf 'A\nB'", ["printf 'A B'"], 2],
  ['native newline matches exactly', "printf 'A\nB'", ["printf 'A", "B'"], 1]
]) {
  test(`Codex display correlation: ${name}`, async t => {
    const h = harness(t); await h.ready;
    await h.native(familyCases[0], 'PermissionRequest', '1', { tool_name: 'Bash', tool_input: { command } });
    await createHelperStuckDetector({ runtime: {
      listAgents: () => [{ id: 'helper', pane_id: '%7', stream_id: 'stream', status: 'active' }],
      paneSnapshot: async () => ({ lines: codexModal(rows) }) },
      inboxStore: h.store, assignmentStore: h.assignments, submitReport: h.pipeline.submitReport, log }).tick();
    assert.equal(waits(h).length, expected);
    assert.equal(h.sent.filter(p => p.type === 'event' && p.meta?.report_kind === 'blocked').length, expected);
  });
}

test('ambiguous concurrent native commands cannot consume a wrapped terminal observation', async t => {
  const h = harness(t); await h.ready;
  for (const id of ['1', '2']) await h.native(familyCases[0], 'PermissionRequest', id,
    { tool_name: 'Bash', turn_id: 'turn-' + id, tool_input: { command: 'printf token > /tmp/long-path' } });
  await createHelperStuckDetector({ runtime: {
    listAgents: () => [{ id: 'helper', pane_id: '%7', stream_id: 'stream', status: 'active' }],
    paneSnapshot: async () => ({ lines: codexModal(['printf token >', '/tmp/long-path']) }) },
    inboxStore: h.store, assignmentStore: h.assignments, submitReport: h.pipeline.submitReport, log }).tick();
  assert.equal(waits(h).length, 3);
  await h.native(familyCases[0], 'Interrupt', '1', { turn_id: 'turn-1' });
  assert.equal(waits(h).length, 2);
  assert.ok(waits(h).some(r => r.source === 'stuck_detector'));
  assert.ok(waits(h).some(r => r.turn_id === 'turn-2'));
});

test('native hook arriving during the terminal snapshot submission cannot duplicate a wrapped approval', async t => {
  const h = harness(t); await h.ready;
  const permission = wrappedApproval.hooks.find(row => row.native_event === 'PermissionRequest');
  await createHelperStuckDetector({ runtime: {
    listAgents: () => [{ id: 'helper', pane_id: '%7', stream_id: 'stream', status: 'active' }],
    paneSnapshot: async () => ({ lines: wrappedApproval.screen }) },
    inboxStore: h.store, assignmentStore: h.assignments, log,
    submitReport: async input => {
      await h.recorded(permission); // The detector's earlier native lookup was empty.
      return h.pipeline.submitReport(input);
    } }).tick();
  assert.equal(waits(h).length, 1);
  assert.equal(h.sent.filter(p => p.type === 'event' && p.meta?.report_kind === 'blocked').length, 1);
  await h.recorded(wrappedApproval.hooks.find(row => row.native_event === 'Interrupt'));
  assert.equal(waits(h).length, 0);
});

const mcpReportFixture = JSON.parse(fs.readFileSync(new URL('../fixtures/claude-mcp-report.synthetic.json', import.meta.url)));
function mcpReportInput(extra = {}) { return { ...mcpReportFixture.permission.payload.tool_input, ...extra }; }
function mcpReportScreen(input = mcpReportInput()) {
  return mcpReportFixture.lines.map(line => {
    const field = /^\s*([A-Za-z_][A-Za-z0-9_]*): /.exec(line);
    return field && Object.hasOwn(input, field[1]) ? ` ${field[1]}: ${JSON.stringify(input[field[1]])}` : line;
  });
}
function mcpReportEvent(input = mcpReportInput(), event = 'PermissionRequest', id) {
  return { ...mcpReportFixture.permission, native_event: event, payload: {
    ...mcpReportFixture.permission.payload, hook_event_name: event, tool_input: input,
    ...(id ? { tool_use_id: id } : {})
  } };
}
function mcpDetector(h, lines) {
  return createHelperStuckDetector({ runtime: {
    listAgents: () => [{ id: 'helper', pane_id: '%1', status: 'active' }],
    paneSnapshot: async () => ({ lines: lines() }) }, inboxStore: h.store,
    assignmentStore: h.assignments, submitReport: h.pipeline.submitReport,
    resolveReport: h.pipeline.resolveObservedInput, log });
}
for (const order of ['native_first', 'terminal_first']) {
  test(`synthetic Claude MCP report ${order}: exact complete input owns one notice and resolves once`, async t => {
    const h = harness(t); await h.ready;
    let lines = mcpReportScreen(); const detector = mcpDetector(h, () => lines);
    if (order === 'terminal_first') await detector.tick();
    await h.recorded(mcpReportEvent());
    await detector.tick();
    assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 1);
    assert.equal(inputNotices(h).length, 1);
    const report = h.store.listReports({}).find(r => r.blocking);
    assert.equal(report.tool_fingerprint, mcpReportFixture.fingerprint);
    assert.equal(report.source, 'mh_hook');
    await h.recorded(mcpReportEvent(mcpReportInput(), 'PostToolUse', 'completed'));
    await detector.tick(); // old modal still on the pane cannot recreate it
    assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 0);
    assert.equal(inputNotices(h).length, 1);
    assert.equal(h.store.listReports({ include_resolved: true }).some(r => r.kind === 'done'), false);
  });
}
for (const bad of ['different_input', 'missing_field', 'wrapped_value', 'nested_value', 'different_tool']) {
  test(`Claude MCP table ${bad}: cannot consume an independent native approval`, async t => {
    const h = harness(t); await h.ready;
    const event = mcpReportEvent();
    if (bad === 'different_tool') event.payload.tool_name = 'mcp__other__agent_report';
    await h.recorded(event);
    let lines = mcpReportScreen(bad === 'different_input' ? mcpReportInput({ summary: 'Other report' }) : mcpReportInput());
    if (bad === 'missing_field') lines = lines.filter(line => !line.trim().startsWith('mission_id:'));
    if (bad === 'wrapped_value') lines = lines.map(line => line.trim().startsWith('summary:') ? ' summary: "Probe' : line);
    if (bad === 'nested_value') lines = lines.map(line => line.trim().startsWith('summary:') ? ' summary: {"value":"Probe accepted"}' : line);
    await mcpDetector(h, () => lines).tick();
    assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 2);
  });
}
test('Claude MCP distinct concurrent inputs survive reverse snapshots and stale resolved modal', async t => {
  const h = harness(t); await h.ready;
  const a = mcpReportInput(), b = mcpReportInput({ kind: 'question', summary: 'Different input' });
  await h.report({ kind: 'question', report_id: 'unrelated', blocking: true });
  await h.recorded(mcpReportEvent(a, 'PermissionRequest', 'a'));
  await h.recorded(mcpReportEvent(b, 'PermissionRequest', 'b'));
  let lines = mcpReportScreen(a); const detector = mcpDetector(h, () => lines);
  await detector.tick(); lines = mcpReportScreen(b); await detector.tick();
  assert.equal(inputNotices(h).length, 3);
  await h.recorded(mcpReportEvent(a, 'PostToolUse', 'a'));
  lines = mcpReportScreen(a); await detector.tick(); // delayed A after B was observed
  assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 2);
  assert.equal(inputNotices(h).length, 3);
  lines = mcpReportScreen(b); await detector.tick();
  await h.recorded(mcpReportEvent(b, 'PostToolUse', 'b'));
  lines = ['❯']; await detector.tick();
  assert.deepEqual(h.store.listReports({}).filter(r => r.blocking).map(r => r.report_id), ['unrelated']);
});
test('Claude MCP identical concurrent native IDs are never merged by one terminal table', async t => {
  const h = harness(t); await h.ready;
  await h.recorded(mcpReportEvent(mcpReportInput(), 'PermissionRequest', 'a'));
  await h.recorded(mcpReportEvent(mcpReportInput(), 'PermissionRequest', 'b'));
  await mcpDetector(h, () => mcpReportScreen()).tick();
  assert.equal(h.store.listReports({}).filter(r => r.source === 'mh_hook').length, 2);
  assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 3, 'ambiguous terminal occurrence stays separate');
  await h.recorded(mcpReportEvent(mcpReportInput(), 'PostToolUse', 'a'));
  assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 2);
});
test('Claude MCP new same-input native ID after resolution remains a real wait', async t => {
  const h = harness(t); await h.ready;
  let lines = mcpReportScreen(); const detector = mcpDetector(h, () => lines);
  await h.recorded(mcpReportEvent(mcpReportInput(), 'PermissionRequest', 'a')); await detector.tick();
  await h.recorded(mcpReportEvent(mcpReportInput(), 'PostToolUse', 'a'));
  await h.recorded(mcpReportEvent(mcpReportInput(), 'PermissionRequest', 'b')); await detector.tick();
  assert.equal(h.store.listReports({}).filter(r => r.blocking).length, 1);
  assert.equal(inputNotices(h).length, 2);
});

const codexInterruptedFrame = ['■ Conversation interrupted - use /feedback if something went wrong', '', '› Ask Codex to do anything'];
test('synthetic Codex interruption placeholder clears only its observed wait, not another question', async t => {
  const h = harness(t); await h.ready;
  await h.report({ kind:'question',report_id:'independent-question',blocking:true });
  let lines=recordings.codex_approval_screen;
  const detector=mcpDetector(h,()=>lines); await detector.tick();
  assert.equal(h.store.listReports({}).filter(r=>r.blocking).length,2);
  lines=codexInterruptedFrame; await detector.tick();
  assert.deepEqual(h.store.listReports({}).filter(r=>r.blocking).map(r=>r.report_id),['independent-question']);
  assert.equal(h.store.listReports({include_resolved:true}).some(r=>r.kind==='done'),false);
});
test('an old Codex interruption frame cannot hide a newer real approval', async t => {
  const h=harness(t);await h.ready;
  const lines=[codexInterruptedFrame[0],...recordings.codex_approval_screen,codexInterruptedFrame[2]];
  await mcpDetector(h,()=>lines).tick();
  assert.equal(h.store.listReports({}).filter(r=>r.blocking).length,1);
});
test('a Codex placeholder without its observed interruption banner cannot clear a wait', async t => {
  const h=harness(t);await h.ready;let lines=recordings.codex_approval_screen;
  const detector=mcpDetector(h,()=>lines);await detector.tick();
  lines=[codexInterruptedFrame[2]];await detector.tick();
  assert.equal(h.store.listReports({}).filter(r=>r.blocking).length,1);
});


for (const tool of ['ask_permission', 'ask_question']) test(`failed agy ${tool} completes only its exact wait and retains failure`, async t => {
  const h = harness(t), family = { ...familyCases[2], tool };
  await h.native(family, 'PreToolUse', '1');
  await h.native(family, 'PreToolUse', '2');
  const first = h.store.listReports({}).find(report => report.request_id === 'step:1');
  const result = await h.native(family, 'PostToolUse', '1', { error: 'synthetic tool result failure' });
  assert.equal(result.payload.event, 'turn_failed');
  assert.deepEqual(h.store.listReports({}).filter(report => report.blocking).map(report => report.request_id), ['step:2']);
  assert.equal(h.store.listReports({ include_resolved: true }).find(report => report.report_id === first.report_id).lifecycle_state, 'resolved');
  assert.equal(h.sent.at(-1).name, 'cmd_failed');
  assert.equal(h.sent.at(-1).meta.awaiting_input, undefined, 'another wait still requires input');
  await h.native(family, 'PostToolUse', '2', { error: 'synthetic second failure' });
  assert.equal(h.store.listReports({}).filter(report => report.blocking).length, 0);
  assert.equal(h.sent.at(-1).name, 'cmd_failed');
  assert.equal(h.sent.at(-1).meta.awaiting_input, false);
  assert.equal(h.transient.get('helper').inputPending, false);
  assert.equal(h.transient.get('helper').error, true);
  const reports = h.store.listReports({ include_resolved: true }).length;
  await h.native(family, 'PostToolUse', '2', { error: 'late duplicate failure' });
  assert.equal(h.store.listReports({ include_resolved: true }).length, reports);
  assert.equal(h.sent.some(message => message.meta?.report_kind === 'done'), false);
});

test('failed tool completion cannot resolve a different request, tool or session; unknown failure cannot sweep', async t => {
  const h = harness(t), family = familyCases[2];
  await h.native(family, 'PreToolUse', '1');
  await h.native(family, 'PostToolUse', '9', { error: 'synthetic wrong request' });
  await h.native(family, 'PostToolUse', '1', { error: 'synthetic wrong tool', toolCall: { name: 'ask_permission', args: {} } });
  await h.native(family, 'PostToolUse', '1', { error: 'synthetic wrong session', conversationId: 'other-session' });
  await h.recorded({ runtime: 'antigravity', native_event: 'Stop', payload: { conversationId: 'session', terminationReason: 'error' } });
  await h.recorded({ runtime: 'antigravity', native_event: 'PostToolUse', payload: {
    conversationId: 'session', error: 'synthetic missing identity', toolCall: { name: 'ask_question' } } });
  await h.hook({ runtime: 'claude', session_id: 'session', event: 'turn_failed',
    meta: { native_event: 'StopFailure', request_id: 'step:1', tool_name: 'ask_question' } });
  assert.deepEqual(h.store.listReports({}).filter(report => report.blocking).map(report => report.request_id), ['step:1']);
  assert.equal(h.sent.filter(message => message.name === 'cmd_failed').every(message => message.meta.awaiting_input !== false), true);
});
