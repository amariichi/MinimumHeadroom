import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_AUDIO_MAX_CHANNELS_DEFAULT,
  clampBrowserAudioMaxChannels,
  selectBrowserAudioChannelIndex,
  shouldStopBrowserAudioChannel,
  matchesBrowserAudioSource,
  planBrowserAudioCancellation,
  createBrowserAudioCancellationLedger
} from '../../face-app/public/browser_audio_policy.js';

test('clampBrowserAudioMaxChannels applies default and boundaries', () => {
  assert.equal(clampBrowserAudioMaxChannels(Number.NaN), BROWSER_AUDIO_MAX_CHANNELS_DEFAULT);
  assert.equal(clampBrowserAudioMaxChannels(0), 1);
  assert.equal(clampBrowserAudioMaxChannels(2.7), 2);
  assert.equal(clampBrowserAudioMaxChannels(20), 8);
});

const audio = (messageId, generation = 1, sessionId = 'owner-inbox', revision = 100) =>
  ({ messageId, generation, sessionId, revision });

test('cancelling active A preserves queued B and another session with the same generation', () => {
  const a = audio('notice-a'), b = audio('notice-b', 2), other = audio('notice-a', 1, 'other-session');
  const plan = planBrowserAudioCancellation({ ...a, active: true, queue: [a, b, other] }, a);
  assert.equal(plan.stopActive, true);
  assert.deepEqual(plan.remove, [a]);
  assert.deepEqual(plan.keep, [b, other]);
});

test('cancelling queued A leaves active B and queued C untouched', () => {
  const a = audio('notice-a'), b = audio('notice-b', 2), c = audio('notice-c', 3);
  const plan = planBrowserAudioCancellation({ ...b, active: true, queue: [a, c] }, a);
  assert.equal(plan.stopActive, false);
  assert.deepEqual(plan.keep, [c]);
  assert.deepEqual(plan.remove, [a]);
});

test('source matching accepts wire fields and requires the exact message and revision when supplied', () => {
  const a = audio('notice-a');
  assert.equal(matchesBrowserAudioSource(a, { generation: 1, session_id: 'owner-inbox', message_id: 'notice-a', revision: 100 }), true);
  assert.equal(matchesBrowserAudioSource(audio('notice-a', 1, 'owner-inbox', 101), a), false);
  assert.equal(matchesBrowserAudioSource(audio('notice-b'), a), false);
});

test('replay and delayed unlock completion cannot revive a cancelled exact payload', async () => {
  const ledger = createBrowserAudioCancellationLedger();
  const a = audio('notice-a'), b = audio('notice-b', 2);
  let finishUnlock;
  const pending = new Promise(resolve => { finishUnlock = resolve; });
  const delayed = (async () => { await pending; return ledger.isCancelled(a) ? null : a; })();
  ledger.cancel(a);
  finishUnlock();
  assert.equal(await delayed, null);
  assert.equal(ledger.isCancelled(a), true, 'the autoplay replay path checks this same identity');
  assert.equal(ledger.isCancelled(b), false);
});

test('a restarted worker generation with a different message/revision is not tombstoned', () => {
  const ledger = createBrowserAudioCancellationLedger();
  ledger.cancel(audio('old-notice', 1, 'owner-inbox', 100));
  assert.equal(ledger.isCancelled(audio('new-notice', 1, 'owner-inbox', 200)), false);
  ledger.cancel({ generation: 1, sessionId: 'owner-inbox' });
  assert.equal(ledger.isCancelled(audio('new-notice', 1, 'owner-inbox', 200)), false);
});

test('cancellation ledger is bounded and chunk message identities remain independent', () => {
  const ledger = createBrowserAudioCancellationLedger(2);
  ledger.cancel(audio('notice#1/2'));
  assert.equal(ledger.isCancelled(audio('notice#2/2')), false);
  ledger.cancel(audio('notice#2/2'));
  ledger.cancel(audio('next', 2));
  assert.equal(ledger.size, 2);
  assert.equal(ledger.isCancelled(audio('next', 2)), true);
});

test('selectBrowserAudioChannelIndex reuses active session channel first', () => {
  const channels = [
    { active: true, sessionId: 'a', startedAt: 10 },
    { active: false, sessionId: null, startedAt: 0 }
  ];
  assert.equal(selectBrowserAudioChannelIndex(channels, 'a', 4), 0);
});

test('selectBrowserAudioChannelIndex uses free slot then appends under cap', () => {
  const withFree = [
    { active: true, sessionId: 'a', startedAt: 10 },
    { active: false, sessionId: null, startedAt: 0 }
  ];
  assert.equal(selectBrowserAudioChannelIndex(withFree, 'b', 4), 1);

  const noFree = [{ active: true, sessionId: 'a', startedAt: 10 }];
  assert.equal(selectBrowserAudioChannelIndex(noFree, 'b', 4), 1);
});

test('selectBrowserAudioChannelIndex evicts oldest channel when full', () => {
  const channels = [
    { active: true, sessionId: 'a', startedAt: 100 },
    { active: true, sessionId: 'b', startedAt: 70 },
    { active: true, sessionId: 'c', startedAt: 80 }
  ];
  assert.equal(selectBrowserAudioChannelIndex(channels, 'd', 3), 1);
});

test('shouldStopBrowserAudioChannel matches generation and session filters', () => {
  const channel = { active: true, generation: 5, sessionId: 'agent-a' };
  assert.equal(shouldStopBrowserAudioChannel(channel, {}), true);
  assert.equal(shouldStopBrowserAudioChannel(channel, { generation: 5 }), true);
  assert.equal(shouldStopBrowserAudioChannel(channel, { generation: 6 }), false);
  assert.equal(shouldStopBrowserAudioChannel(channel, { sessionId: 'agent-a' }), true);
  assert.equal(shouldStopBrowserAudioChannel(channel, { sessionId: 'agent-b' }), false);
  assert.equal(shouldStopBrowserAudioChannel(channel, { generation: 5, sessionId: 'agent-a' }), true);
  assert.equal(shouldStopBrowserAudioChannel(channel, { generation: 5, sessionId: 'agent-b' }), false);
  assert.equal(shouldStopBrowserAudioChannel({ active: false, generation: 5, sessionId: 'agent-a' }, {}), false);
});

