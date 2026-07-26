import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InterpreterAtomVolumeError,
  createInterpreterAtomVolumeController
} from '../../face-app/dist/interpreter_atom_volume.js';

function fixture({ connected = true } = {}) {
  const socket = {};
  const sent = [];
  const updates = [];
  let timerCallback = null;
  const registry = {
    getPresence() {
      return { connected };
    },
    getVolumeControlTarget(deviceId) {
      if (!connected || (deviceId && deviceId !== 'atom-one')) return null;
      return {
        deviceId: 'atom-one',
        source: 'direct',
        socket,
        speakerVolume: 112
      };
    },
    updateSpeakerVolume(input) {
      updates.push(input);
      return true;
    }
  };
  const controller = createInterpreterAtomVolumeController({
    registry,
    requestId: () => 'request-one',
    sendPayload(target, payload) {
      sent.push({ target, payload });
      return true;
    },
    setTimer(callback) {
      timerCallback = callback;
      return 7;
    },
    clearTimer() {}
  });
  return {
    controller,
    sent,
    socket,
    timeout() {
      timerCallback();
    },
    updates
  };
}

test('Atom volume controller correlates an authenticated socket result', async () => {
  const state = fixture();
  const resultPromise = state.controller.setVolume({
    deviceId: 'atom-one',
    volume: 160
  });
  assert.deepEqual(state.sent[0], {
    target: state.socket,
    payload: {
      v: 1,
      type: 'atom_volume_set',
      request_id: 'request-one',
      device_id: 'atom-one',
      volume: 160,
      ts: state.sent[0].payload.ts
    }
  });
  assert.equal(state.controller.pendingCount(), 1);

  assert.equal(state.controller.handlePayload({
    type: 'atom_volume_result',
    request_id: 'request-one',
    device_id: 'atom-one',
    ok: true,
    speaker_volume: 160
  }, {
    isAtom: true,
    isAtomBridge: false,
    socket: {}
  }), true);
  assert.equal(state.controller.pendingCount(), 1);

  state.controller.handlePayload({
    type: 'atom_volume_result',
    request_id: 'request-one',
    device_id: 'atom-one',
    ok: true,
    speaker_volume: 160
  }, {
    isAtom: true,
    isAtomBridge: false,
    socket: state.socket
  });
  assert.deepEqual(await resultPromise, {
    ok: true,
    deviceId: 'atom-one',
    speakerVolume: 160,
    persistent: false
  });
  assert.equal(state.controller.pendingCount(), 0);
  assert.equal(state.updates[0].speakerVolume, 160);
});

test('Atom volume controller accepts a result from the selected HTTP bridge socket', async () => {
  const state = fixture();
  const resultPromise = state.controller.setVolume({ volume: 0 });
  state.controller.handlePayload({
    type: 'atom_volume_result',
    request_id: 'request-one',
    device_id: 'atom-one',
    ok: true,
    speaker_volume: 0
  }, {
    isAtom: true,
    isAtomBridge: true,
    socket: state.socket
  });
  assert.equal((await resultPromise).speakerVolume, 0);
});

test('Atom volume controller validates range, connection, timeout, and socket close', async () => {
  const invalid = fixture();
  await assert.rejects(
    invalid.controller.setVolume({ volume: 201 }),
    (error) => (
      error instanceof InterpreterAtomVolumeError
      && error.code === 'invalid_atom_volume'
      && error.statusCode === 400
    )
  );

  const disconnected = fixture({ connected: false });
  await assert.rejects(
    disconnected.controller.setVolume({ volume: 112 }),
    (error) => error.code === 'atom_not_connected'
  );

  const timedOut = fixture();
  const timedOutPromise = timedOut.controller.setVolume({ volume: 112 });
  timedOut.timeout();
  await assert.rejects(
    timedOutPromise,
    (error) => error.code === 'atom_volume_timeout'
  );

  const closed = fixture();
  const closedPromise = closed.controller.setVolume({ volume: 112 });
  closed.controller.failSocket(closed.socket);
  await assert.rejects(
    closedPromise,
    (error) => error.code === 'atom_disconnected'
  );
});
