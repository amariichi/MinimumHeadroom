import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBrowserAudioMaxChannels } from '../../face-app/dist/browser_audio_config.js';

test('resolveBrowserAudioMaxChannels defaults to eight on desktop', () => {
  assert.equal(resolveBrowserAudioMaxChannels({ env: {}, uiMode: 'pc' }), 8);
  assert.equal(resolveBrowserAudioMaxChannels({ env: {}, uiMode: 'mobile' }), 4);
});

test('resolveBrowserAudioMaxChannels preserves explicit overrides', () => {
  assert.equal(resolveBrowserAudioMaxChannels({ env: { FACE_BROWSER_AUDIO_MAX_CHANNELS: '3' }, uiMode: 'pc' }), 3);
  assert.equal(resolveBrowserAudioMaxChannels({ env: { FACE_BROWSER_AUDIO_MAX_CHANNELS: '99' }, uiMode: 'pc' }), 8);
  assert.equal(resolveBrowserAudioMaxChannels({ env: { FACE_BROWSER_AUDIO_MAX_CHANNELS: '0' }, uiMode: 'pc' }), 1);
});
