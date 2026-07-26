import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATOM_BRIDGE_SUBPROTOCOL,
  buildAtomAudioPostHeaders,
  buildAtomEndpointState,
  buildAtomVolumeResult,
  parseAtomVolumeSet,
  shouldForwardAudioToAtom,
  websocketServiceEndpointMatches
} from '../../scripts/atoms3r_bridge_protocol.mjs';

test('Atom bridge identifies itself with a stable websocket subprotocol', () => {
  assert.equal(ATOM_BRIDGE_SUBPROTOCOL, 'mh-atom-http-bridge-v1');
});

test('Atom bridge never forwards browser-targeted audio', () => {
  assert.equal(shouldForwardAudioToAtom({ type: 'tts_audio', audio_endpoint: 'browser' }), false);
  assert.equal(shouldForwardAudioToAtom({ type: 'tts_audio_ref', audio_endpoint: 'atom' }), true);
  assert.equal(shouldForwardAudioToAtom({ type: 'tts_audio' }), true);
});

test('Atom binary audio POST preserves codec and dedupe identity headers', () => {
  assert.deepEqual(
    buildAtomAudioPostHeaders(
      {
        mime_type: 'audio/wav',
        utterance_id: 'utterance-7',
        generation: 12,
        audio_id: ' audio-9 ',
        audio_codec: 'ima_adpcm_wav'
      },
      'secret'
    ),
    {
      'content-type': 'audio/wav',
      'x-headroom-auth': 'secret',
      'x-utterance-id': 'utterance-7',
      'x-generation': '12',
      'x-audio-id': 'audio-9',
      'x-audio-codec': 'ima_adpcm_wav'
    }
  );
  assert.deepEqual(buildAtomAudioPostHeaders(), { 'content-type': 'audio/wav' });
});

test('Atom endpoint heartbeat reports both input and output availability', () => {
  assert.deepEqual(
    buildAtomEndpointState({
      connected: true,
      audioInput: true,
      health: { device_id: 'atom-headroom-1' },
      reason: 'heartbeat',
      now: () => 123
    }),
    {
      v: 1,
      type: 'atom_endpoint_state',
      connected: true,
      device_id: 'atom-headroom-1',
      audio_input: true,
      audio_output: true,
      playback_codecs: ['pcm16_wav'],
      speaker_volume: null,
      volume_control: false,
      reason: 'heartbeat',
      ts: 123
    }
  );
  assert.equal(
    buildAtomEndpointState({ connected: true, audioInput: false }).audio_input,
    false
  );
  assert.equal(buildAtomEndpointState({ connected: false, now: () => 456 }).audio_output, false);
});

test('Atom endpoint heartbeat carries only known playback codecs from health', () => {
  const state = buildAtomEndpointState({
    connected: true,
    audioInput: true,
    health: {
      device_id: 'atom-headroom-1',
      playback_codecs: ['pcm16_wav', 'ima_adpcm_wav', 'opus']
    }
  });
  assert.deepEqual(state.playback_codecs, ['pcm16_wav', 'ima_adpcm_wav']);
});

test('Atom endpoint heartbeat advertises runtime volume only for updated firmware', () => {
  const state = buildAtomEndpointState({
    connected: true,
    audioInput: true,
    health: {
      device_id: 'atom-headroom-1',
      speaker_volume: 160
    }
  });
  assert.equal(state.speaker_volume, 160);
  assert.equal(state.volume_control, true);
  assert.equal(
    buildAtomEndpointState({
      connected: false,
      health: { speaker_volume: 112 }
    }).volume_control,
    false
  );
});

test('Atom bridge validates volume commands and builds correlated results', () => {
  assert.deepEqual(
    parseAtomVolumeSet({
      request_id: ' volume-one ',
      device_id: 'atom-headroom-1',
      volume: 160
    }, 'atom-headroom-1'),
    {
      ok: true,
      requestId: 'volume-one',
      volume: 160
    }
  );
  assert.equal(
    parseAtomVolumeSet({
      request_id: 'volume-two',
      device_id: 'other',
      volume: 112
    }, 'atom-headroom-1').error,
    'atom_device_mismatch'
  );
  assert.equal(
    parseAtomVolumeSet({ request_id: 'volume-three', volume: -1 }).error,
    'invalid_atom_volume'
  );
  assert.equal(
    parseAtomVolumeSet({ request_id: 'volume-four', volume: 201 }).error,
    'invalid_atom_volume'
  );
  assert.deepEqual(
    buildAtomVolumeResult({
      requestId: 'volume-one',
      deviceId: 'atom-headroom-1',
      ok: true,
      speakerVolume: 160,
      now: () => 789
    }),
    {
      v: 1,
      type: 'atom_volume_result',
      request_id: 'volume-one',
      device_id: 'atom-headroom-1',
      ok: true,
      speaker_volume: 160,
      error: null,
      persistent: false,
      ts: 789
    }
  );
});

test('Atom input is associated with the same websocket service across loopback and LAN hosts', () => {
  assert.equal(
    websocketServiceEndpointMatches(
      'ws://192.168.1.20:8766/ws',
      'ws://127.0.0.1:8766/ws?auth_token=redacted'
    ),
    true
  );
  assert.equal(
    websocketServiceEndpointMatches(
      'ws://192.168.1.20:8765/ws',
      'ws://127.0.0.1:8766/ws'
    ),
    false
  );
  assert.equal(websocketServiceEndpointMatches('not-a-url', 'ws://127.0.0.1:8766/ws'), false);
});
