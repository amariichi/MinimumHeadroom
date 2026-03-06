import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_AUDIO_MAX_CHANNELS_DEFAULT,
  clampBrowserAudioMaxChannels,
  selectBrowserAudioChannelIndex,
  shouldStopBrowserAudioChannel
} from '../../face-app/public/browser_audio_policy.js';

test('clampBrowserAudioMaxChannels applies default and boundaries', () => {
  assert.equal(clampBrowserAudioMaxChannels(Number.NaN), BROWSER_AUDIO_MAX_CHANNELS_DEFAULT);
  assert.equal(clampBrowserAudioMaxChannels(0), 1);
  assert.equal(clampBrowserAudioMaxChannels(2.7), 2);
  assert.equal(clampBrowserAudioMaxChannels(20), 8);
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

