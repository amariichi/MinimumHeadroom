import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerInboxNotifier } from '../../face-app/dist/owner_inbox_notifier.js';

const quietLog = { info() {}, warn() {}, error() {} };

function createServerSpy() {
  const sent = [];
  return { sent, broadcast(payload) { sent.push(payload); } };
}

const baseReport = {
  stream_id: 'repo:/tmp/x',
  mission_id: 'mission-1',
  report_id: 'rpt-1',
  owner_agent_id: '__operator__',
  from_agent_id: 'helper-5',
  kind: 'done',
  summary: 'Finished the sweep',
  detail: null
};

test('owner inbox notifier announces a done report to the owner face', async () => {
  const notifier = createOwnerInboxNotifier({ log: quietLog });
  const server = createServerSpy();
  const result = await notifier.notify({ report: baseReport, server });

  assert.equal(result.ok, true);
  assert.equal(server.sent.length, 2);
  const [event, say] = server.sent;
  assert.equal(event.type, 'event');
  assert.equal(say.type, 'say');
  // The owner is the one being told, so the owner's face speaks and the helper
  // is named in the words.
  assert.equal(event.agent_id, '__operator__');
  assert.equal(say.agent_id, '__operator__');
  assert.match(say.text, /helper-5/);
  assert.equal(event.meta.from_agent_id, 'helper-5');
});

test('owner inbox notifier stays quiet for progress reports', async () => {
  const notifier = createOwnerInboxNotifier({ log: quietLog });
  const server = createServerSpy();
  const result = await notifier.notify({
    report: { ...baseReport, kind: 'progress', summary: 'Mission accepted' },
    server
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_announced');
  assert.equal(server.sent.length, 0, 'progress is the common case and would be noise');
});

test('owner inbox notifier interrupts for blocked and waits its turn for done', async () => {
  const notifier = createOwnerInboxNotifier({ log: quietLog });

  const blockedServer = createServerSpy();
  await notifier.notify({ report: { ...baseReport, kind: 'blocked' }, server: blockedServer });
  const blockedSay = blockedServer.sent[1];
  assert.equal(blockedSay.policy, 'interrupt');
  assert.equal(blockedSay.priority, 3);
  assert.equal(blockedServer.sent[0].name, 'permission_required');

  const doneServer = createServerSpy();
  await notifier.notify({ report: baseReport, server: doneServer });
  const doneSay = doneServer.sent[1];
  assert.equal(doneSay.policy, 'replace');
  assert.equal(doneSay.priority, 2);
});

test('owner inbox notifier speaks the language the report is written in', async () => {
  const notifier = createOwnerInboxNotifier({ log: quietLog });
  const server = createServerSpy();
  await notifier.notify({
    report: { ...baseReport, summary: '掃引が完了しました' },
    server
  });
  assert.match(server.sent[1].text, /完了/);
});

test('owner inbox notifier can be turned off', async () => {
  const notifier = createOwnerInboxNotifier({ log: quietLog, enabled: false });
  const server = createServerSpy();
  const result = await notifier.notify({ report: baseReport, server });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'disabled');
  assert.equal(server.sent.length, 0);
});

test('owner inbox notifier survives a broken transport', async () => {
  const notifier = createOwnerInboxNotifier({ log: quietLog });
  const broken = { broadcast() { throw new Error('socket gone'); } };
  // The report is already stored; losing the announcement must not fail it.
  const result = await notifier.notify({ report: baseReport, server: broken });
  assert.equal(result.ok, true);
});
