import assert from 'node:assert/strict';
import test from 'node:test';
import { createAudioFocusController } from '../../face-app/dist/audio_focus_controller.js';

function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    setTimeout(callback, delay) {
      const key = ++id;
      pending.set(key, { callback, delay });
      return key;
    },
    clearTimeout(key) {
      pending.delete(key);
    },
    fireAll() {
      const callbacks = [...pending.values()].map((entry) => entry.callback);
      pending.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

test('audio focus emits speech immediately and guarded normal once idle', () => {
  const timers = fakeTimers();
  const events = [];
  let clock = 100;
  const focus = createAudioFocusController({
    broadcast: (payload) => events.push(payload),
    now: () => ++clock,
    releaseDelayMs: 1500,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  focus.replay();
  focus.update({ active: true, queued: 0 });
  focus.update({ active: true, queued: 2 });
  focus.update({ active: false, queued: 0 });
  assert.equal(timers.pending.size, 1);
  assert.equal([...timers.pending.values()][0].delay, 1500);
  timers.fireAll();

  assert.deepEqual(events.map((event) => event.state), ['normal', 'speech', 'normal']);
  assert.deepEqual(events.map((event) => event.revision), [1, 2, 3]);
});

test('new speech cancels a pending focus release', () => {
  const timers = fakeTimers();
  const events = [];
  const focus = createAudioFocusController({
    broadcast: (payload) => events.push(payload),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  focus.update({ active: true });
  focus.update({ active: false });
  assert.equal(timers.pending.size, 1);
  focus.update({ queued: 1 });
  assert.equal(timers.pending.size, 0);
  timers.fireAll();
  assert.deepEqual(events.map((event) => event.state), ['speech']);
});
