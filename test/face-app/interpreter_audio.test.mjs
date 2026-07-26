import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createInterpreterAudioPlayer,
  createInterpreterSilentWavDataUrl,
  isBrowserInterpreterAudio,
  shouldInterruptInterpreterAudio
} from '../../face-app/public/interpreter_audio.js';

const MP3_REFERENCE = {
  type: 'tts_audio_ref',
  audio_endpoint: 'browser',
  mime_type: 'audio/mpeg',
  audio_codec: 'mp3',
  bitrate: 128_000,
  url: '/api/tts/audio/12345678-1234-1234-1234-123456789abc.mp3'
};

test('interpreter browser player accepts fixed-policy MP3 references and PCM fallback', () => {
  assert.equal(isBrowserInterpreterAudio({
    type: 'tts_audio',
    audio_endpoint: 'browser',
    audio_base64: 'YQ=='
  }), true);
  assert.equal(isBrowserInterpreterAudio({
    type: 'tts_audio',
    audio_endpoint: 'atom',
    audio_base64: 'YQ=='
  }), false);
  assert.equal(isBrowserInterpreterAudio(MP3_REFERENCE), true);
  assert.equal(isBrowserInterpreterAudio({ ...MP3_REFERENCE, audio_endpoint: 'atom' }), false);
  assert.equal(isBrowserInterpreterAudio({ ...MP3_REFERENCE, bitrate: 96_000 }), false);
  assert.equal(isBrowserInterpreterAudio({ ...MP3_REFERENCE, url: 'https://example.test/audio.mp3' }), false);
});

test('interpreter browser player loads MP3 references directly into its persistent element', async () => {
  const listeners = new Map();
  const player = {
    src: '',
    currentTime: 0,
    preload: '',
    playsInline: false,
    volume: 0,
    paused: true,
    setAttribute() {},
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    loadCalls: 0,
    load() {
      this.loadCalls += 1;
    },
    async play() {
      this.paused = false;
    },
    pause() {
      this.paused = true;
    }
  };
  const audio = createInterpreterAudioPlayer({ player });
  assert.equal(audio.handlePayload({
    ...MP3_REFERENCE,
    generation: 7,
    utterance_id: 'u1'
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(player.src, MP3_REFERENCE.url);
  assert.equal(player.loadCalls, 1);
  assert.equal(player.volume, 1);
  listeners.get('ended')();
});

test('interpreter browser player stops only for explicit interruption states', () => {
  assert.equal(shouldInterruptInterpreterAudio({
    type: 'tts_state',
    phase: 'interrupt_requested'
  }), true);
  assert.equal(shouldInterruptInterpreterAudio({
    type: 'tts_state',
    phase: 'play_stop'
  }), false);
  assert.equal(shouldInterruptInterpreterAudio({
    type: 'tts_state',
    phase: 'completed'
  }), false);
});

function fakeAudioElement({ play = async () => {} } = {}) {
  const listeners = new Map();
  return {
    src: '',
    currentTime: 0,
    preload: '',
    playsInline: false,
    volume: 0,
    paused: true,
    setAttribute() {},
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    load() {},
    async play() {
      this.paused = false;
      return play();
    },
    pause() {
      this.paused = true;
    },
    emit(name) {
      listeners.get(name)?.();
    }
  };
}

test('interpreter unlock uses a valid non-empty WAV on a dedicated player', async () => {
  const dataUrl = createInterpreterSilentWavDataUrl();
  const wavBytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  assert.equal(wavBytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wavBytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wavBytes.readUInt32LE(40), 2_880);

  let blocked = 0;
  const playbackPlayer = fakeAudioElement();
  const unlockPlayer = fakeAudioElement({
    play: async () => {
      throw new Error('probe rejected');
    }
  });
  const targetListeners = new Map();
  const audio = createInterpreterAudioPlayer({
    player: playbackPlayer,
    unlockPlayer,
    onBlocked() {
      blocked += 1;
    }
  });
  audio.installGestureUnlock({
    visibilityState: 'visible',
    addEventListener(name, handler) {
      targetListeners.set(name, handler);
    }
  });
  targetListeners.get('pointerdown')();
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(unlockPlayer.src, /^(?:data:audio\/wav|)$/);
  assert.equal(playbackPlayer.src, '');
  assert.equal(blocked, 0);
  assert.equal(audio.hasReplay(), false);
});

test('interpreter replay is offered only for a real blocked browser payload and retries directly', async () => {
  let allowPlayback = false;
  let blocked = 0;
  let playing = 0;
  const playbackPlayer = fakeAudioElement({
    play: async () => {
      if (!allowPlayback) throw new Error('autoplay blocked');
    }
  });
  const audio = createInterpreterAudioPlayer({
    player: playbackPlayer,
    unlockPlayer: fakeAudioElement(),
    onBlocked(_error, payload) {
      assert.equal(payload.utterance_id, 'blocked-one');
      blocked += 1;
    },
    onPlaying(payload) {
      assert.equal(payload.utterance_id, 'blocked-one');
      playing += 1;
    }
  });

  assert.equal(audio.handlePayload({
    ...MP3_REFERENCE,
    generation: 9,
    utterance_id: 'blocked-one'
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(blocked, 1);
  assert.equal(audio.hasReplay(), true);

  allowPlayback = true;
  assert.equal(await audio.replayLast(), true);
  assert.equal(playing, 1);
  assert.equal(audio.hasReplay(), false);

  audio.interrupt();
  assert.equal(await audio.replayLast(), false);
});
