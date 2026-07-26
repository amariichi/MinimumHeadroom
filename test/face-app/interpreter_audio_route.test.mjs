import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAtomEndpointRegistry,
  resolveInterpreterAudioEndpoint
} from '../../face-app/dist/interpreter_audio_route.js';

test('audio endpoint is Atom for Atom input or live presence and browser otherwise', () => {
  assert.equal(resolveInterpreterAudioEndpoint({
    inputSource: 'atom',
    atomPresence: { connected: false }
  }), 'atom');
  assert.equal(resolveInterpreterAudioEndpoint({
    inputSource: 'browser',
    atomPresence: { connected: true }
  }), 'atom');
  assert.equal(resolveInterpreterAudioEndpoint({
    inputSource: 'browser',
    atomPresence: { connected: false }
  }), 'browser');
});

test('direct Atom frames mark only their socket and socket close removes presence', () => {
  let nowMs = 1_000;
  const changes = [];
  const registry = createAtomEndpointRegistry({
    now: () => nowMs,
    onChange: (presence) => changes.push(presence.connected)
  });
  const socket = {};
  registry.observeDirectFrame({ socket, deviceId: 'atom-one' });
  assert.equal(socket.__mhAtomClient, true);
  assert.equal(registry.getPresence().connected, true);
  assert.equal(registry.getPreferredPlaybackCodec(), 'pcm16_wav');
  registry.forgetSocket(socket);
  assert.equal(registry.getPresence().connected, false);
  assert.deepEqual(changes, [true, false]);
});

test('bridge heartbeat requires explicit audio capabilities and expires', () => {
  let nowMs = 1_000;
  const registry = createAtomEndpointRegistry({ now: () => nowMs, ttlMs: 15_000 });
  const socket = {};
  assert.equal(registry.observeBridgeState({
    type: 'atom_endpoint_state',
    connected: true,
    device_id: 'atom-one'
  }, { socket }), false);
  assert.equal(registry.getPresence().connected, false);

  assert.equal(registry.observeBridgeState({
    type: 'atom_endpoint_state',
    connected: true,
    device_id: 'atom-one',
    audio_input: true,
    audio_output: true
  }, { socket }), true);
  assert.equal(socket.__mhAtomBridgeClient, true);
  assert.equal(registry.getPresence().connected, true);
  assert.equal(registry.getPreferredPlaybackCodec(), 'pcm16_wav');

  nowMs = 16_001;
  registry.prune();
  assert.equal(registry.getPresence().connected, false);
});

test('new direct capability selects IMA ADPCM and takes priority over a bridge fallback', () => {
  const registry = createAtomEndpointRegistry();
  const bridgeSocket = {};
  const directSocket = {};

  registry.observeBridgeState({
    type: 'atom_endpoint_state',
    connected: true,
    device_id: 'atom-one',
    audio_input: true,
    audio_output: true
  }, { socket: bridgeSocket });
  assert.equal(registry.getPreferredPlaybackCodec(), 'pcm16_wav');

  assert.equal(registry.observeDirectState({
    type: 'atom_endpoint_state',
    connected: true,
    device_id: 'atom-one',
    audio_input: true,
    audio_output: true,
    playback_codecs: ['pcm16_wav', 'ima_adpcm_wav']
  }, { socket: directSocket }), true);
  assert.equal(directSocket.__mhAtomClient, true);
  assert.equal(directSocket.__mhAtomBridgeClient, undefined);
  assert.equal(registry.getPreferredPlaybackCodec(), 'ima_adpcm_wav');
  assert.deepEqual(
    registry.getPresence().devices.map((device) => device.source),
    ['direct']
  );

  registry.observeDirectFrame({ socket: directSocket, deviceId: 'atom-one' });
  assert.equal(registry.getPreferredPlaybackCodec(), 'ima_adpcm_wav');
  registry.forgetSocket(directSocket);
  assert.equal(registry.getPresence().connected, true);
  assert.equal(registry.getPresence().devices[0].source, 'bridge');
  assert.equal(registry.getPreferredPlaybackCodec(), 'pcm16_wav');
});

test('auto codec stays PCM when any preferred direct Atom lacks ADPCM capability', () => {
  const registry = createAtomEndpointRegistry();
  registry.observeDirectState({
    type: 'atom_endpoint_state',
    connected: true,
    device_id: 'atom-one',
    audio_input: true,
    audio_output: true,
    playback_codecs: ['pcm16_wav', 'ima_adpcm_wav']
  }, { socket: {} });
  registry.observeDirectState({
    type: 'atom_endpoint_state',
    connected: true,
    device_id: 'atom-two',
    audio_input: true,
    audio_output: true
  }, { socket: {} });
  assert.equal(registry.getPreferredPlaybackCodec(), 'pcm16_wav');
});

test('bridge disconnected state removes the matching device', () => {
  const registry = createAtomEndpointRegistry();
  const socket = {};
  registry.observeBridgeState({
    type: 'atom_endpoint_state',
    connected: true,
    device_id: 'atom-one',
    audio_input: true,
    audio_output: true
  }, { socket });
  registry.observeBridgeState({
    type: 'atom_endpoint_state',
    connected: false,
    device_id: 'atom-one'
  }, { socket });
  assert.equal(registry.getPresence().connected, false);
});

test('Atom registry exposes volume capability and prefers a live direct control socket', () => {
  const changes = [];
  const registry = createAtomEndpointRegistry({
    onChange(presence) {
      changes.push(presence.devices[0]?.speakerVolume ?? null);
    }
  });
  const bridgeSocket = {};
  const directSocket = {};
  registry.observeBridgeState({
    type: 'atom_endpoint_state',
    connected: true,
    device_id: 'atom-one',
    audio_input: true,
    audio_output: true,
    speaker_volume: 112,
    volume_control: true
  }, { socket: bridgeSocket });
  registry.observeDirectState({
    type: 'atom_endpoint_state',
    connected: true,
    device_id: 'atom-one',
    audio_input: true,
    audio_output: true,
    speaker_volume: 112,
    volume_control: true
  }, { socket: directSocket });

  assert.deepEqual(registry.getVolumeControlTarget('atom-one'), {
    deviceId: 'atom-one',
    source: 'direct',
    socket: directSocket,
    speakerVolume: 112
  });
  assert.equal(registry.getPresence().devices[0].volumeControl, true);
  assert.equal(registry.updateSpeakerVolume({
    socket: directSocket,
    deviceId: 'atom-one',
    speakerVolume: 160
  }), true);
  assert.equal(registry.getPresence().devices[0].speakerVolume, 160);
  assert.equal(changes.at(-1), 160);

  registry.forgetSocket(directSocket);
  assert.equal(registry.getVolumeControlTarget('atom-one').source, 'bridge');
});
