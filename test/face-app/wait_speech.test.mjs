import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createTtsController } from '../../face-app/dist/tts_controller.js';
import { createOwnerInboxStateStore } from '../../face-app/dist/owner_inbox_state.js';
import { createAgentAssignmentStateStore } from '../../face-app/dist/agent_assignment_state.js';
import { createOwnerInboxNotifier } from '../../face-app/dist/owner_inbox_notifier.js';
import { createOwnerReportPipeline } from '../../face-app/dist/owner_report_pipeline.js';
import { createHookBridge } from '../../face-app/dist/hook_bridge.js';
import { commandFingerprint, classifyAgentHook } from '../../scripts/agent-hook-events.mjs';
import { waitSpeechSubject, waitSpeechCategory, waitSpeechLine } from '../../face-app/dist/wait_speech.js';

const log = { info() {}, warn() {}, error() {} };
class FakeWorker extends EventEmitter {
  sent = [];
  send(message) { this.sent.push(message); return true; }
  stop() {}
}
const speaks = worker => worker.sent.filter(message => message.op === 'speak');
const interrupts = worker => worker.sent.filter(message => message.op === 'interrupt');
const flush = () => new Promise(resolve => setImmediate(resolve));
const say = (extra = {}) => ({ type: 'say', agent_id: '__operator__', session_id: 'test',
  text: 'Harmless test speech.', priority: 3, policy: 'interrupt', ts: Date.now(), ttl_ms: 30_000, ...extra });

function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-wait-speech-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const assignments = createAgentAssignmentStateStore({ statePath: path.join(root, 'assignments.json'), log });
  for (const n of [1, 2]) assignments.upsertAssignment({ stream_id: 'test-stream', mission_id: `mission-${n}`,
    agent_id: `helper-${n}`, owner_agent_id: '__operator__', goal: 'Harmless synthetic test' });
  const store = createOwnerInboxStateStore({ statePath: path.join(root, 'inbox.json'), assignmentStateStore: assignments, log });
  store.load();
  const worker = new FakeWorker(), sent = [];
  const server = { broadcast: message => sent.push(message) };
  const controller = createTtsController({ worker, log, broadcast: server.broadcast, audioTarget: 'browser',
    ...(options.realGate ? {} : { gate: { check: () => ({ allow: true }) } }), ...options.tts });
  worker.emit('message', { type: 'ready', voice: 'test', engine: 'kokoro' });
  const unsubscribe = store.subscribe(() => controller.revalidateNotifications());
  t.after(unsubscribe);
  t.after(() => controller.stop());
  const notifier = createOwnerInboxNotifier({ store, log });
  const notify = report => notifier.notify({ report, server, ttsController: controller });
  const pipeline = createOwnerReportPipeline({ store, assignmentStore: assignments,
    notify: options.notify ? report => options.notify(report, notify) : notify, log });
  let bridge = createHookBridge({ templatesPath: path.join(root, 'no-templates.json'), log });
  const hook = (event, meta = {}, agent = 'helper-1') => bridge.handleHook({
    payload: { type: 'hook', event, runtime: 'claude', agent_id: agent, session_id: `session-${agent}`, meta },
    server, ttsController: controller, ownerInboxStore: store, assignmentStore: assignments, reportPipeline: pipeline });
  const native = async (event, payload) => {
    const classified = classifyAgentHook({ runtime: 'antigravity', explicitEvent: event, payload });
    return bridge.handleHook({ payload: { type: 'hook', event: classified.event, runtime: 'antigravity',
      agent_id: 'helper-1', session_id: payload.conversationId, meta: classified.meta }, server,
      ttsController: controller, ownerInboxStore: store, assignmentStore: assignments, reportPipeline: pipeline });
  };
  const question = (id, agent = 'helper-1') => hook('input_required', {
    request_id: id, tool_name: 'AskUserQuestion', input_kind: 'choice_single' }, agent);
  const resolve = (id, agent = 'helper-1') => hook('input_resolved', { request_id: id, tool_name: 'AskUserQuestion' }, agent);
  const report = extra => pipeline.submitReport({ stream_id: 'test-stream', mission_id: 'mission-1',
    owner_agent_id: '__operator__', from_agent_id: 'helper-1', summary: 'Synthetic status', ...extra });
  const pending = () => store.listReports({}).filter(report => report.blocking);
  const manualResolve = report => store.updateReportLifecycle({ stream_id: report.stream_id, report_id: report.report_id, action: 'resolved' });
  const finish = generation => worker.emit('message', { type: 'event', phase: 'play_stop', generation });
  return { worker, sent, controller, store, notifier, pipeline, bridge, hook, question, resolve, report, pending,
    manualResolve, finish, native, restartBridge() { bridge = createHookBridge({ templatesPath: path.join(root, 'no-templates.json'), log }); } };
}

test('category speech names only allowlisted providers/generated helper identities in both languages', () => {
  for (const [runtime, provider] of [['codex', 'Codex'], ['claude', 'Claude'], ['antigravity', 'agy']]) {
    const subject = waitSpeechSubject('helper-2', runtime);
    assert.equal(subject, `${provider} helper-2`);
    for (const lang of ['ja', 'en']) for (const category of ['approval', 'answer', 'choice', 'unknown']) {
      const line = waitSpeechLine(category, subject, lang);
      assert.ok(line.includes(provider) && line.includes('helper-2'));
    }
  }
  assert.equal(waitSpeechSubject('person@example.com', '/private/provider'), 'Agent');
  assert.equal(waitSpeechSubject('person@example.com', 'constructor'), 'Agent');
  assert.equal(waitSpeechCategory({ kind: 'question' }), 'answer');
  assert.equal(waitSpeechCategory({ kind: 'blocked' }), 'unknown');
});

test('owner notification speaks approval, answer, choice or uncertainty without report/tool bodies', t => {
  const h = harness(t);
  for (const [kind, attention_kind, word] of [
    ['blocked', 'approval', '承認'], ['question', 'question', '回答'], ['question', 'choice', '選択'], ['blocked', 'other', '確認']
  ]) {
    const payload = h.notifier.__test.buildPayloads({ kind, attention_kind, runtime: 'claude', from_agent_id: 'helper-1',
      owner_agent_id: '__operator__', summary: '非公開の質問 private-question-marker',
      detail: '/private/test-path private-command-marker person@example.com' });
    assert.match(payload.say.text, new RegExp(word));
    assert.match(payload.say.text, /Claude helper-1/);
    assert.doesNotMatch(payload.say.text, /private-|example\.com|非公開/);
  }
});

test('one helper native wait has one owner voice and remains silent on redelivery/bridge recreation', async t => {
  const h = harness(t);
  await h.question('q1');
  await h.question('q1');
  h.restartBridge();
  await h.question('q1');
  assert.equal(h.pending().length, 1);
  assert.equal(speaks(h.worker).length, 1);
  assert.equal(h.sent.filter(message => message.type === 'say').length, 1);
  assert.equal(h.sent.find(message => message.type === 'say').agent_id, '__operator__');
});

for (const order of ['native-first', 'terminal-first']) test(`same exact approval has one voice: ${order}`, async t => {
  const h = harness(t);
  const action_fingerprint = commandFingerprint('printf harmless-test');
  const native = () => h.hook('permission_required', { request_id: 'approval-1', tool_name: 'Bash', action_fingerprint });
  const terminal = () => h.report({ kind: 'blocked', report_id: 'terminal-1', attention_kind: 'approval',
    source: 'stuck_detector', pane_id: '%test', observation_key: 'modal-1', action_fingerprint });
  await (order === 'native-first' ? native() : terminal());
  await (order === 'native-first' ? terminal() : native());
  assert.equal(h.pending().length, 1);
  assert.equal(speaks(h.worker).length, 1);
});

test('distinct simultaneous request IDs keep their own notices, including another helper', async t => {
  const h = harness(t);
  await h.question('q1');
  await h.question('q2');
  await h.question('q3', 'helper-2');
  assert.equal(h.pending().length, 3);
  assert.equal(h.controller.snapshot().queuedChunks, 2);
  assert.equal(interrupts(h.worker).length, 0);
  h.finish(speaks(h.worker)[0].generation);
  h.finish(speaks(h.worker)[1].generation);
  assert.equal(speaks(h.worker).length, 3);
  assert.match(speaks(h.worker)[2].text, /helper-2/);
});

test('manual answer before queued speech removes only that wait and retains another queued notice', async t => {
  const h = harness(t);
  await h.question('q1'); await h.question('q2'); await h.question('q3', 'helper-2');
  const second = h.pending().find(report => report.request_id === 'q2');
  h.manualResolve(second);
  assert.equal(h.controller.snapshot().queuedChunks, 1);
  assert.equal(interrupts(h.worker).length, 0, 'the unrelated active notice must continue');
  h.finish(speaks(h.worker)[0].generation);
  assert.equal(speaks(h.worker).length, 2);
  assert.match(speaks(h.worker)[1].text, /helper-2/);
  assert.equal(h.pending().length, 2);
});

test('manual resolution during synthesis cancels exact active voice, starts independent wait and rejects late audio', async t => {
  const h = harness(t);
  await h.question('q1'); await h.question('q2', 'helper-2');
  const stale = speaks(h.worker)[0];
  h.manualResolve(h.pending().find(report => report.request_id === 'q1'));
  assert.deepEqual(interrupts(h.worker).map(message => message.generation), [stale.generation]);
  assert.equal(speaks(h.worker).length, 2);
  h.worker.emit('message', { type: 'audio', generation: stale.generation, audio_base64: 'eA==', mime_type: 'audio/wav' });
  h.finish(stale.generation);
  assert.equal(h.sent.some(message => ['tts_audio', 'tts_audio_ref'].includes(message.type) && message.generation === stale.generation), false);
  assert.equal(h.controller.snapshot().activeGeneration, speaks(h.worker)[1].generation);
  assert.deepEqual(h.pending().map(report => report.request_id), ['q2']);
  assert.equal(h.sent.some(message => message.type === 'tts_state' && message.phase === 'interrupt_requested'
    && message.reason === 'notification_resolved'), false, 'wait cancellation cannot globally interrupt interpreter audio');
});

test('all delivered chunks of a resolved notice are cancelled by exact message identity', async t => {
  const h = harness(t, { tts: { maxChunkChars: 12 } });
  await h.question('q1');
  while (h.controller.snapshot().activeGeneration !== null) h.finish(speaks(h.worker).at(-1).generation);
  const chunks = speaks(h.worker);
  assert.ok(chunks.length > 1);
  h.manualResolve(h.pending()[0]);
  const cancelled = h.sent.filter(message => message.type === 'tts_state' && message.phase === 'dropped'
    && message.reason === 'notification_resolved');
  assert.deepEqual(new Set(cancelled.map(message => message.message_id)), new Set(chunks.map(chunk => chunk.message_id)));
  assert.equal(h.sent.some(message => message.type === 'tts_state' && message.phase === 'interrupt_requested'
    && message.reason === 'notification_resolved'), false);
});

test('native answer clears exactly its voice and wait without announcing mission completion', async t => {
  const h = harness(t);
  await h.question('q1'); await h.question('q2');
  const stale = speaks(h.worker)[0];
  await h.resolve('q1');
  assert.deepEqual(interrupts(h.worker).map(message => message.generation), [stale.generation]);
  assert.deepEqual(h.pending().map(report => report.request_id), ['q2']);
  assert.equal(h.sent.some(message => message.meta?.report_kind === 'done'), false);
});

test('answer while report notification is pending prevents stale speech when notifier resumes', async t => {
  let resume, entered;
  const paused = new Promise(resolve => { resume = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const h = harness(t, { notify: async (report, notify) => { entered(); await paused; return notify(report); } });
  const pending = h.question('q1');
  await started;
  await h.resolve('q1');
  resume();
  await pending;
  assert.equal(h.pending().length, 0);
  assert.equal(speaks(h.worker).length, 0);
  assert.equal(h.sent.filter(message => message.type === 'say').length, 0);
});

test('late asynchronous MP3 is suppressed even after worker finished and active speech is already empty', async t => {
  let finishEncoding;
  const h = harness(t, { tts: {
    browserAudioEncoder: () => new Promise(resolve => { finishEncoding = () => resolve({
      buffer: Buffer.from([0xff, 0xfb, 0x90, 0x64]), codec: 'mp3', mimeType: 'audio/mpeg', bitrate: 128_000 }); }),
    audioStore: { putAudio: payload => payload, toReferencePayload: entry => ({ type: 'tts_audio_ref', generation: entry.generation }) }
  } });
  const result = h.store.submitReport({ stream_id: 'test-stream', mission_id: 'mission-1', owner_agent_id: '__operator__',
    from_agent_id: 'helper-1', kind: 'question', summary: 'Synthetic question', report_id: 'encode-report' });
  await h.controller.handleSayPayload(say({ audio_endpoint: 'browser' }), { notificationKey: 'encode-wait',
    isCurrent: () => h.store.listReports({}).some(report => report.report_id === result.report.report_id) });
  const generation = speaks(h.worker)[0].generation;
  h.worker.emit('message', { type: 'audio', generation, audio_base64: 'eA==', mime_type: 'audio/wav' });
  await flush();
  assert.equal(typeof finishEncoding, 'function');
  h.finish(generation);
  h.manualResolve(result.report);
  finishEncoding(); await flush();
  assert.equal(h.sent.some(message => ['tts_audio', 'tts_audio_ref'].includes(message.type)), false);
});

test('resolution cancels delivered browser audio after worker completion without stopping another generation', async t => {
  const h = harness(t);
  await h.question('q1');
  const first = speaks(h.worker)[0];
  h.worker.emit('message', { type: 'audio', generation: first.generation, audio_base64: 'eA==', mime_type: 'audio/wav' });
  assert.ok(h.sent.some(message => message.type === 'tts_audio' && message.generation === first.generation));
  h.finish(first.generation);
  await h.question('q2', 'helper-2');
  const second = speaks(h.worker)[1];
  h.manualResolve(h.pending().find(report => report.request_id === 'q1'));
  const cancelled = h.sent.filter(message => message.type === 'tts_state'
    && message.phase === 'dropped' && message.reason === 'notification_resolved');
  assert.deepEqual(cancelled.map(message => message.generation), [first.generation]);
  assert.equal(interrupts(h.worker).length, 0, 'another active worker generation is untouched');
  assert.equal(h.controller.snapshot().activeGeneration, second.generation);
  assert.deepEqual(h.pending().map(report => report.request_id), ['q2']);
});

test('failed durable answer write cannot cancel valid voice; successful retry does', async t => {
  const h = harness(t);
  await h.question('q1');
  const report = h.pending()[0], original = fs.writeFileSync;
  const mock = t.mock.method(fs, 'writeFileSync', (filename, ...args) => {
    if (String(filename).startsWith(`${h.store.statePath}.tmp-`)) throw new Error('synthetic write failure');
    return original(filename, ...args);
  });
  assert.throws(() => h.manualResolve(report), /synthetic write failure/);
  assert.equal(interrupts(h.worker).length, 0);
  assert.equal(h.pending().length, 1);
  mock.mock.restore();
  h.manualResolve(report);
  assert.equal(interrupts(h.worker).length, 1);
});

test('native pending input suppresses same-agent idle but not another agent response boundary', async t => {
  const h = harness(t);
  await h.question('q1');
  const result = await h.hook('idle_after_response', { native_event: 'Stop' });
  assert.equal(result.reason, 'input_still_pending');
  assert.equal(h.sent.filter(message => message.type === 'say').length, 1);
  await h.hook('idle_after_response', { native_event: 'Stop' }, 'helper-2');
  assert.equal(h.controller.snapshot().queuedChunks, 1);
  await h.resolve('q1');
  assert.equal(speaks(h.worker).length, 2);
  assert.equal(h.sent.filter(message => message.type === 'say')[1].agent_id, 'helper-2');
});

test('temporary report persistence failure followed by retry cannot speak the same native wait twice', async t => {
  const h = harness(t), original = fs.writeFileSync;
  let failed = false;
  const mock = t.mock.method(fs, 'writeFileSync', (filename, ...args) => {
    if (!failed && String(filename).startsWith(`${h.store.statePath}.tmp-`)) {
      failed = true;
      throw new Error('synthetic transient report failure');
    }
    return original(filename, ...args);
  });
  await h.question('q1');
  mock.mock.restore();
  assert.equal(h.pending().length, 0);
  assert.equal(speaks(h.worker).length, 1, 'direct fallback announces the known native occurrence');
  await h.question('q1');
  assert.equal(h.pending().length, 1);
  assert.equal(speaks(h.worker).length, 1, 'the persisted owner notice shares the exact native key');
  h.manualResolve(h.pending()[0]);
  assert.equal(interrupts(h.worker).length, 1, 'manual resolution also cancels an earlier fallback voice');
});

test('an ordinary replacement cannot erase a queued independent automatic wait', async t => {
  const h = harness(t);
  await h.question('q1'); await h.question('q2', 'helper-2');
  await h.controller.handleSayPayload(say({ priority: 2, policy: 'replace' }));
  assert.equal(h.controller.snapshot().queuedChunks, 2);
  h.finish(speaks(h.worker)[0].generation);
  assert.match(speaks(h.worker)[1].text, /helper-2/);
});

test('a newly pending native wait cancels same-agent queued idle speech', async t => {
  const h = harness(t);
  await h.controller.handleSayPayload(say({ priority: 2, policy: 'replace' }));
  await h.hook('idle_after_response', { native_event: 'Stop' });
  assert.equal(h.controller.snapshot().queuedChunks, 1);
  await h.question('q1');
  assert.equal(h.sent.some(message => message.type === 'tts_state' && message.reason === 'notification_resolved'), true);
  assert.equal(speaks(h.worker).some(message => /Response ended|応答が終わり/.test(message.text)), false);
  assert.equal(h.pending().length, 1);
});

test('unknown reminder is conservative and uses the existing low-priority speech cap', async t => {
  const h = harness(t, { realGate: true });
  const meta = { native_event: 'Notification', notification_type: 'idle_prompt', detail: '/private/path test-body-marker' };
  await h.hook('idle_after_response', meta);
  await h.hook('idle_after_response', meta);
  assert.equal(speaks(h.worker).length, 1);
  assert.match(speaks(h.worker)[0].text, /status|確認/);
  assert.doesNotMatch(speaks(h.worker)[0].text, /stuck|failed|done|completed|ended|private|test-body|止ま|完了|終わ/);
});

test('ordinary priority-three emergency speech keeps its no-dedupe interrupt behavior', async t => {
  const h = harness(t, { realGate: true });
  await h.controller.handleSayPayload(say({ dedupe_key: 'ordinary-emergency' }));
  await h.controller.handleSayPayload(say({ dedupe_key: 'ordinary-emergency' }));
  assert.equal(speaks(h.worker).length, 2);
  assert.equal(interrupts(h.worker).length, 1);
});


for (const tool of ['ask_permission', 'ask_question']) test(`failed native agy ${tool} cancels only its exact voice and leaves no false done`, async t => {
  const h = harness(t);
  const payload = stepIdx => ({ conversationId: 'agy-session', stepIdx, toolCall: { name: tool, args: {} } });
  await h.native('PreToolUse', payload(1));
  await h.native('PreToolUse', payload(2));
  const first = speaks(h.worker)[0];
  await h.native('PostToolUse', { ...payload(1), error: 'synthetic tool completion failure' });
  assert.deepEqual(interrupts(h.worker).map(message => message.generation), [first.generation]);
  assert.deepEqual(h.pending().map(report => report.request_id), ['step:2']);
  assert.equal(h.controller.snapshot().activeGeneration, speaks(h.worker)[1].generation);
  h.worker.emit('message', { type: 'audio', generation: first.generation, audio_base64: 'eA==', mime_type: 'audio/wav' });
  assert.equal(h.sent.some(message => message.type === 'tts_audio' && message.generation === first.generation), false);
  await h.native('PostToolUse', { ...payload(2), error: 'synthetic second failure' });
  assert.equal(h.pending().length, 0);
  assert.equal(h.controller.snapshot().activeGeneration, null);
  const speechCount = speaks(h.worker).length;
  await h.native('PostToolUse', { ...payload(2), error: 'late duplicate failure' });
  assert.equal(speaks(h.worker).length, speechCount);
  assert.equal(h.sent.some(message => message.meta?.report_kind === 'done'), false);
  assert.equal(h.sent.filter(message => message.type === 'event').at(-1).name, 'cmd_failed');
});

test('unknown failure leaves valid native question and its voice intact', async t => {
  const h = harness(t);
  await h.native('PreToolUse', { conversationId: 'agy-session', stepIdx: 1, toolCall: { name: 'ask_question', args: {} } });
  const active = h.controller.snapshot().activeGeneration;
  await h.native('Stop', { conversationId: 'agy-session', terminationReason: 'error' });
  assert.equal(h.pending().length, 1);
  assert.equal(h.controller.snapshot().activeGeneration, active);
  assert.equal(interrupts(h.worker).length, 0);
});
