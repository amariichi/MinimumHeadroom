import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaPlayer } from '../../face-app/public/media_player.js';

class FakeAudio {
  constructor() {
    this.preload = '';
    this.playsInline = false;
    this.volume = 0;
    this.src = '';
    this.currentTime = 0;
    this.paused = true;
    this.attributes = new Map();
    this.listeners = new Map();
    this.playResults = [];
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
  }

  addEventListener(name, handler) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(handler);
    this.listeners.set(name, listeners);
  }

  emit(name) {
    for (const handler of this.listeners.get(name) ?? []) handler();
  }

  play() {
    this.playCalls += 1;
    const result = this.playResults.shift();
    if (result instanceof Error) {
      this.paused = true;
      return Promise.reject(result);
    }
    this.paused = false;
    return Promise.resolve(result);
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  load() {
    this.loadCalls += 1;
  }
}

function activeState(revision = 1, overrides = {}) {
  return {
    v: 1,
    type: 'media_state',
    state: 'active',
    revision,
    media_id: 'album:track',
    title: 'Track',
    subtitle: 'Album',
    stream_url: '/api/media/stream/opaque-token',
    mime_type: 'audio/mpeg',
    bitrate: 128000,
    ...overrides
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test('media player uses one unity-gain HTML audio element and ignores stale state', async () => {
  const audio = new FakeAudio();
  const states = [];
  const player = createMediaPlayer({
    audio,
    onStateChange(state) {
      states.push(state);
    }
  });

  assert.equal(player.audio, audio);
  assert.equal(audio.preload, 'auto');
  assert.equal(audio.playsInline, true);
  assert.equal(audio.volume, 1);
  assert.equal(audio.attributes.get('webkit-playsinline'), 'true');

  player.applyState(activeState(2));
  await settle();
  assert.equal(player.snapshot().playbackState, 'playing');
  assert.equal(audio.playCalls, 1);

  player.applyState({
    type: 'media_state',
    state: 'idle',
    revision: 1
  });
  assert.equal(player.snapshot().serverState, 'active');
  assert.equal(player.snapshot().title, 'Track');
  assert.equal(states.at(-1).playbackState, 'playing');
});

test('media player exposes tap-required and resumes on the same element', async () => {
  const audio = new FakeAudio();
  const blocked = new Error('play() failed because user gesture is required');
  blocked.name = 'NotAllowedError';
  audio.playResults.push(blocked);
  const player = createMediaPlayer({ audio });

  player.applyState(activeState());
  await settle();
  assert.equal(player.snapshot().playbackState, 'tap_required');

  audio.playResults.push(undefined);
  assert.equal(await player.resume(), true);
  assert.equal(player.snapshot().playbackState, 'playing');
  assert.equal(player.audio, audio);
  assert.equal(audio.volume, 1);
});

test('media player primes its persistent element in a gesture and later streams MP3', async () => {
  const audio = new FakeAudio();
  const player = createMediaPlayer({ audio });

  player.primeInGesture('data:audio/wav;base64,UklGRg==');
  await settle();
  assert.equal(player.snapshot().primed, true);
  assert.equal(audio.src, '');

  player.applyState(activeState());
  await settle();
  assert.equal(audio.src, '/api/media/stream/opaque-token');
  assert.equal(player.snapshot().playbackState, 'playing');
  assert.equal(audio.playCalls, 2);
});

test('media idle resets only the dedicated media element', async () => {
  const audio = new FakeAudio();
  const player = createMediaPlayer({ audio });
  player.applyState(activeState());
  await settle();

  player.applyState({
    v: 1,
    type: 'media_state',
    state: 'idle',
    revision: 2,
    media_id: null,
    title: null,
    subtitle: null
  });

  assert.equal(player.snapshot().playbackState, 'idle');
  assert.equal(audio.paused, true);
  assert.equal(audio.src, '');
  assert.ok(audio.pauseCalls >= 2);
});

test('media stop uses the same-origin generic API', async () => {
  const calls = [];
  const player = createMediaPlayer({
    audio: new FakeAudio(),
    async fetch(url, options) {
      calls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { state: 'idle' };
        }
      };
    }
  });

  assert.deepEqual(await player.requestStop(), { state: 'idle' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/media/stop');
  assert.equal(calls[0].options.method, 'POST');
});
