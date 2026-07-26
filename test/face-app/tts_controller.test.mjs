import assert from 'node:assert/strict';
import test from 'node:test';
import { createTtsController, segmentTtsText } from '../../face-app/dist/tts_controller.js';

class FakeWorker {
  constructor() {
    this.handlers = new Map();
    this.sent = [];
    this.stopped = false;
  }

  on(eventName, handler) {
    const list = this.handlers.get(eventName) ?? [];
    list.push(handler);
    this.handlers.set(eventName, list);
  }

  send(payload) {
    this.sent.push(payload);
    return true;
  }

  stop() {
    this.stopped = true;
  }

  emit(eventName, payload) {
    const list = this.handlers.get(eventName) ?? [];
    for (const handler of list) {
      handler(payload);
    }
  }
}

function speaks(worker) {
  return worker.sent.filter((payload) => payload.op === 'speak');
}

function interrupts(worker) {
  return worker.sent.filter((payload) => payload.op === 'interrupt');
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

function pcmWavBase64({ sampleRate = 44_100, sampleCount = 4_410 } = {}) {
  const wav = Buffer.alloc(44 + (sampleCount * 2));
  wav.write('RIFF', 0, 4, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 4, 'ascii');
  wav.write('fmt ', 12, 4, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 4, 'ascii');
  wav.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeInt16LE(
      Math.round(6_000 * Math.sin(2 * Math.PI * 220 * index / sampleRate)),
      44 + (index * 2)
    );
  }
  return wav.toString('base64');
}

async function speakOnce(payload) {
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => 42_000,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });
  const result = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    priority: 2,
    policy: 'replace',
    ttl_ms: 10_000,
    ts: 42_000,
    ...payload
  });

  return { worker, result };
}

test('tts controller forwards Japanese text without doing speech rewriting', async () => {
  const { worker, result } = await speakOnce({
    text: '外の温度計は一・八度です。'
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, '外の温度計は一・八度です。');
});

test('tts controller forwards an optional per-utterance language to the worker', async () => {
  const { worker, result } = await speakOnce({
    text: 'Bonjour',
    language: 'fr'
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].language, 'fr');
});

test('tts controller forwards an explicit per-utterance speaker to the worker', async () => {
  const { worker, result } = await speakOnce({
    text: 'こんにちは。',
    speaker: 'F3'
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].speaker, 'F3');
});

test('tts controller preserves an explicit speaker when long text is chunked', async () => {
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => 42_000,
    maxChunkChars: 8,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'M1', engine: 'supertonic-3-onnx' });
  const result = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'speaker-chunks',
    text: '一つ目の文です。二つ目の文です。',
    speaker: 'F4',
    priority: 2,
    policy: 'replace',
    ttl_ms: 10_000,
    ts: 42_000
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].speaker, 'F4');
  worker.emit('message', {
    type: 'event',
    phase: 'play_stop',
    generation: 1,
    session_id: 's1',
    utterance_id: speaks(worker)[0].utterance_id
  });
  assert.equal(speaks(worker).length, 2);
  assert.equal(speaks(worker)[1].speaker, 'F4');
});

test('tts controller keeps Japanese version sentence unchanged before worker prep', async () => {
  const { worker, result } = await speakOnce({
    text: '現在のバージョンは1.2.3です。'
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, '現在のバージョンは1.2.3です。');
});

test('tts controller keeps v-prefixed semver raw before worker prep', async () => {
  const { worker, result } = await speakOnce({
    text: 'v1.1 と v1.7.0 を公開しました。'
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, 'v1.1 と v1.7.0 を公開しました。');
});

test('tts controller keeps leading ascii token raw before worker prep', async () => {
  const { worker, result } = await speakOnce({
    text: 'execplanを作成しました。'
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, 'execplanを作成しました。');
});

test('tts controller keeps known leading ascii token without extra はい', async () => {
  const { worker, result } = await speakOnce({
    text: 'GitHub承認申請をお願いします。'
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, 'GitHub承認申請をお願いします。');
});

test('tts controller keeps leading numeric+japanese token raw before worker prep', async () => {
  const { worker, result } = await speakOnce({
    text: '23日までに完了します。'
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, '23日までに完了します。');
});

test('tts controller does not prefix semver-like dotted number at sentence start', async () => {
  const { worker, result } = await speakOnce({
    text: '1.2.3です。'
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, '1.2.3です。');
});

test('tts controller routes mixed-script boundary utterances to Ono_Anna for qwen workers', async () => {
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => 42_000,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'Serena', engine: 'qwen3-tts-0.6b-customvoice' });
  const result = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    text: 'GitHub承認申請をお願いします。',
    priority: 2,
    policy: 'replace',
    ttl_ms: 10_000,
    ts: 42_000
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].speaker, 'Ono_Anna');
});

test('tts controller keeps default qwen speaker for non-boundary utterances', async () => {
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => 42_000,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'Serena', engine: 'qwen3-tts-0.6b-customvoice' });
  const result = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    text: 'PRを出してCIが通ったらCDします。',
    priority: 2,
    policy: 'replace',
    ttl_ms: 10_000,
    ts: 42_000
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].speaker, null);
});

test('tts controller interrupt path supersedes current generation', async () => {
  let nowMs = 1_000;
  const worker = new FakeWorker();
  const broadcasts = [];

  const controller = createTtsController({
    worker,
    now: () => nowMs,
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  const first = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    text: 'one',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: nowMs
  });
  assert.equal(first.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].generation, 1);

  nowMs += 500;
  const second = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u2',
    text: 'urgent',
    priority: 3,
    policy: 'interrupt',
    ttl_ms: 4_000,
    ts: nowMs
  });

  assert.equal(second.accepted, true);
  assert.equal(interrupts(worker).length, 1);
  assert.equal(interrupts(worker)[0].generation, 1);
  assert.equal(speaks(worker).length, 2);
  assert.equal(speaks(worker)[1].generation, 2);

  worker.emit('message', { type: 'event', phase: 'play_stop', generation: 1, utterance_id: 'u1', session_id: 's1' });
  assert.equal(controller.snapshot().activeGeneration, 2);

  worker.emit('message', { type: 'event', phase: 'play_stop', generation: 2, utterance_id: 'u2', session_id: 's1' });
  assert.equal(controller.snapshot().activeGeneration, null);

  const stopPayload = broadcasts.find((payload) => payload.type === 'tts_state' && payload.phase === 'play_stop' && payload.generation === 2);
  assert.ok(stopPayload);
});

test('tts controller keeps only latest pending replace and starts it after stop', async () => {
  let nowMs = 10_000;
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => nowMs,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  await controller.handleSayPayload({ type: 'say', session_id: 's1', utterance_id: 'u1', text: 'first', priority: 2, policy: 'replace', ttl_ms: 5_000, ts: nowMs });
  await controller.handleSayPayload({ type: 'say', session_id: 's1', utterance_id: 'u2', text: 'second', priority: 2, policy: 'replace', ttl_ms: 5_000, ts: nowMs + 100 });
  await controller.handleSayPayload({ type: 'say', session_id: 's1', utterance_id: 'u3', text: 'third', priority: 2, policy: 'replace', ttl_ms: 5_000, ts: nowMs + 200 });

  assert.equal(speaks(worker).length, 1);
  assert.equal(controller.snapshot().pendingGeneration, 3);

  worker.emit('message', { type: 'event', phase: 'play_stop', generation: 1, utterance_id: 'u1', session_id: 's1' });

  assert.equal(speaks(worker).length, 2);
  assert.equal(speaks(worker)[1].generation, 3);
  assert.equal(controller.snapshot().pendingGeneration, null);
});

test('tts controller appends an interpreter-owned utterance sequence in FIFO order', async () => {
  let nowMs = 10_000;
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => nowMs,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'F2', engine: 'supertonic' });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 'pair',
    utterance_id: 'announcement-ja',
    text: '日本語とスペイン語に切り替えます。',
    language: 'ja',
    priority: 2,
    policy: 'replace',
    ttl_ms: 5_000,
    ts: nowMs
  });
  nowMs += 1;
  await controller.handleSayPayload({
    type: 'say',
    session_id: 'pair',
    utterance_id: 'announcement-es',
    text: 'Ahora, japonés y español.',
    language: 'es',
    priority: 2,
    policy: 'replace',
    append_to_queue: true,
    ttl_ms: 5_000,
    ts: nowMs
  });
  nowMs += 1;
  await controller.handleSayPayload({
    type: 'say',
    session_id: 'pair',
    utterance_id: 'translation',
    text: 'Hola.',
    language: 'es',
    priority: 2,
    policy: 'replace',
    append_to_queue: true,
    ttl_ms: 5_000,
    ts: nowMs
  });

  assert.deepEqual(
    speaks(worker).map((entry) => entry.utterance_id),
    ['announcement-ja']
  );
  assert.equal(controller.snapshot().pendingGeneration, 2);
  assert.equal(controller.snapshot().queuedChunks, 2);

  worker.emit('message', {
    type: 'event',
    phase: 'play_stop',
    generation: 1,
    utterance_id: 'announcement-ja',
    session_id: 'pair'
  });
  assert.deepEqual(
    speaks(worker).map((entry) => entry.utterance_id),
    ['announcement-ja', 'announcement-es']
  );

  worker.emit('message', {
    type: 'event',
    phase: 'play_stop',
    generation: 2,
    utterance_id: 'announcement-es',
    session_id: 'pair'
  });
  assert.deepEqual(
    speaks(worker).map((entry) => entry.utterance_id),
    ['announcement-ja', 'announcement-es', 'translation']
  );
});

test('tts controller drops ttl-expired utterance before dispatch', async () => {
  let nowMs = 8_000;
  const worker = new FakeWorker();
  const broadcasts = [];
  const controller = createTtsController({
    worker,
    now: () => nowMs,
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  const result = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'late',
    text: 'late',
    priority: 2,
    policy: 'replace',
    ttl_ms: 500,
    ts: 1_000
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'ttl_expired');
  assert.equal(speaks(worker).length, 0);

  const dropped = broadcasts.find((payload) => payload.type === 'tts_state' && payload.phase === 'dropped');
  assert.ok(dropped);
  assert.equal(dropped.reason, 'ttl_expired');
});

test('tts controller returns dropped result with message_id/revision when gate blocks speech', async () => {
  const worker = new FakeWorker();
  const broadcasts = [];
  const controller = createTtsController({
    worker,
    now: () => 20_000,
    gate: { check: () => ({ allow: false, reason: 'dedupe' }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  const result = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    message_id: 'm-1',
    revision: 777,
    text: 'same',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: 20_000,
    dedupe_key: 'same'
  });

  assert.equal(result.accepted, false);
  assert.equal(result.spoken, false);
  assert.equal(result.reason, 'dedupe');
  assert.equal(result.message_id, 'm-1');
  assert.equal(result.revision, 777);

  const dropped = broadcasts.find((payload) => payload.type === 'tts_state' && payload.phase === 'dropped');
  assert.ok(dropped);
  assert.equal(dropped.reason, 'dedupe');
  assert.equal(dropped.message_id, 'm-1');
  assert.equal(dropped.revision, 777);
});

test('tts controller uses long default ttl when ttl_ms is omitted', async () => {
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => 5_000,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  const result = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    text: 'ttl default check',
    priority: 2,
    policy: 'replace',
    ts: 0
  });

  assert.equal(result.accepted, true);
  assert.equal(result.reason, null);
});

test('tts controller auto-promotes replace to interrupt after threshold', async () => {
  let nowMs = 1_000;
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => nowMs,
    autoInterruptAfterMs: 2_000,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    text: 'first long',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: nowMs
  });

  nowMs += 3_000;

  const second = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u2',
    text: 'second after threshold',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: nowMs
  });

  assert.equal(second.accepted, true);
  assert.equal(interrupts(worker).length, 1);
  assert.equal(interrupts(worker)[0].reason, 'auto_interrupt');
  assert.equal(speaks(worker).length, 2);
  assert.equal(speaks(worker)[1].generation, 2);
});

test('tts controller keeps replace queued before auto-interrupt threshold', async () => {
  let nowMs = 10_000;
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => nowMs,
    autoInterruptAfterMs: 5_000,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    text: 'first',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: nowMs
  });

  nowMs += 2_000;
  const second = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u2',
    text: 'second queued',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: nowMs
  });

  assert.equal(second.accepted, true);
  assert.equal(interrupts(worker).length, 0);
  assert.equal(speaks(worker).length, 1);
  assert.equal(controller.snapshot().pendingGeneration, 2);

  worker.emit('message', { type: 'event', phase: 'play_stop', generation: 1, utterance_id: 'u1', session_id: 's1' });

  assert.equal(speaks(worker).length, 2);
  assert.equal(speaks(worker)[1].generation, 2);
});

test('tts controller relays worker audio payload when browser audio is enabled', async () => {
  const worker = new FakeWorker();
  const broadcasts = [];
  const controller = createTtsController({
    worker,
    now: () => 30_000,
    audioTarget: 'browser',
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro', playback_backend: 'silent' });
  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    message_id: 'm-1',
    revision: 123,
    text: 'browser audio',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: 30_000
  });

  worker.emit('message', {
    type: 'audio',
    generation: 1,
    session_id: 's1',
    utterance_id: 'u1',
    mime_type: 'audio/wav',
    sample_rate: 24_000,
    audio_base64: 'ZmFrZQ=='
  });

  const relayed = broadcasts.find((payload) => payload.type === 'tts_audio');
  assert.ok(relayed);
  assert.equal(relayed.generation, 1);
  assert.equal(relayed.message_id, 'm-1');
  assert.equal(relayed.revision, 123);
  assert.equal(relayed.mime_type, 'audio/wav');
  assert.equal(relayed.audio_base64, 'ZmFrZQ==');
});

test('tts controller sends one referenced payload for an Atom interpreter endpoint', async () => {
  const worker = new FakeWorker();
  const broadcasts = [];
  const stored = [];
  const controller = createTtsController({
    worker,
    now: () => 31_000,
    audioTarget: 'browser',
    audioStore: {
      putAudio(payload) {
        stored.push(payload);
        return {
          id: 'audio-route',
          ...payload,
          byteLength: 4,
          durationMs: null,
          expiresAt: 91_000
        };
      },
      toReferencePayload(entry) {
        return {
          type: 'tts_audio_ref',
          audio_endpoint: entry.audioEndpoint
        };
      }
    },
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  worker.emit('message', {
    type: 'ready',
    voice: 'af_heart',
    engine: 'kokoro',
    playback_backend: 'silent'
  });
  await controller.handleSayPayload({
    type: 'say',
    session_id: 'interpreter',
    utterance_id: 'turn-one',
    message_id: 'turn-one',
    revision: 1,
    text: 'Hello',
    language: 'en',
    audio_endpoint: 'atom',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: 31_000
  });
  worker.emit('message', {
    type: 'audio',
    generation: 1,
    mime_type: 'audio/wav',
    sample_rate: 24_000,
    audio_base64: 'ZmFrZQ=='
  });
  assert.equal(stored[0].audioEndpoint, 'atom');
  assert.equal(
    broadcasts.find((payload) => payload.type === 'tts_audio_ref').audio_endpoint,
    'atom'
  );
  assert.equal(broadcasts.find((payload) => payload.type === 'tts_audio'), undefined);
});

test('tts controller stores standard IMA ADPCM only for a capable Atom endpoint', async () => {
  const worker = new FakeWorker();
  const broadcasts = [];
  const stored = [];
  const sourceBase64 = pcmWavBase64();
  const sourceBytes = Buffer.from(sourceBase64, 'base64').length;
  const controller = createTtsController({
    worker,
    now: () => 31_500,
    audioTarget: 'browser',
    atomAudioCodecResolver: () => 'ima_adpcm_wav',
    audioStore: {
      putAudio(payload) {
        stored.push(payload);
        return {
          id: 'adpcm-one',
          ...payload,
          byteLength: payload.audioBuffer.length,
          durationMs: 100,
          expiresAt: 91_500
        };
      },
      toReferencePayload(entry) {
        return {
          type: 'tts_audio_ref',
          audio_endpoint: entry.audioEndpoint,
          audio_codec: entry.audioCodec,
          byte_length: entry.byteLength
        };
      }
    },
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  worker.emit('message', {
    type: 'ready',
    voice: 'af_heart',
    engine: 'kokoro',
    playback_backend: 'silent'
  });
  await controller.handleSayPayload({
    type: 'say',
    session_id: 'interpreter',
    utterance_id: 'turn-adpcm',
    text: 'Hello',
    audio_endpoint: 'atom',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: 31_500
  });
  worker.emit('message', {
    type: 'audio',
    generation: 1,
    mime_type: 'audio/wav',
    sample_rate: 44_100,
    audio_base64: sourceBase64
  });

  assert.equal(stored.length, 1);
  assert.equal(stored[0].audioCodec, 'ima_adpcm_wav');
  assert.equal(stored[0].audioBuffer.readUInt16LE(20), 0x0011);
  assert.ok(stored[0].audioBuffer.length < sourceBytes * 0.3);
  assert.equal(broadcasts.filter((payload) => payload.type === 'tts_audio_ref').length, 1);
  assert.equal(broadcasts.find((payload) => payload.type === 'tts_audio_ref').audio_codec, 'ima_adpcm_wav');
  assert.equal(broadcasts.find((payload) => payload.type === 'tts_audio'), undefined);
});

test('tts controller sends browser interpreter playback as one MP3 reference', async () => {
  const worker = new FakeWorker();
  const broadcasts = [];
  const stored = [];
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
  const controller = createTtsController({
    worker,
    now: () => 31_750,
    audioTarget: 'browser',
    atomAudioCodecResolver: () => 'ima_adpcm_wav',
    async browserAudioEncoder() {
      return {
        buffer: mp3,
        codec: 'mp3',
        mimeType: 'audio/mpeg',
        bitrate: 128_000
      };
    },
    audioStore: {
      putAudio(payload) {
        stored.push(payload);
        return {
          id: '12345678-1234-1234-1234-123456789abc',
          ...payload,
          extension: 'mp3',
          byteLength: payload.audioBuffer.length,
          durationMs: 100,
          expiresAt: 91_750
        };
      },
      toReferencePayload(entry) {
        return {
          type: 'tts_audio_ref',
          audio_endpoint: entry.audioEndpoint,
          audio_codec: entry.audioCodec,
          mime_type: entry.mimeType,
          bitrate: entry.bitrate,
          url: `/api/tts/audio/${entry.id}.mp3`
        };
      }
    },
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  worker.emit('message', {
    type: 'ready',
    voice: 'af_heart',
    engine: 'kokoro',
    playback_backend: 'silent'
  });
  await controller.handleSayPayload({
    type: 'say',
    session_id: 'interpreter',
    utterance_id: 'turn-browser',
    text: 'Hello',
    audio_endpoint: 'browser',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: 31_750
  });
  worker.emit('message', {
    type: 'audio',
    generation: 1,
    mime_type: 'audio/wav',
    sample_rate: 44_100,
    audio_base64: pcmWavBase64()
  });
  await flushAsyncWork();

  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].audioBuffer, mp3);
  assert.equal(stored[0].audioCodec, 'mp3');
  assert.equal(stored[0].mimeType, 'audio/mpeg');
  assert.equal(stored[0].bitrate, 128_000);
  assert.equal(stored[0].audioEndpoint, 'browser');
  assert.equal(broadcasts.filter((payload) => payload.type === 'tts_audio_ref').length, 1);
  assert.equal(broadcasts.find((payload) => payload.type === 'tts_audio_ref').audio_codec, 'mp3');
  assert.equal(broadcasts.find((payload) => payload.type === 'tts_audio'), undefined);
});

test('tts controller falls back once to direct PCM when browser MP3 encoding fails', async () => {
  const worker = new FakeWorker();
  const broadcasts = [];
  const warnings = [];
  const controller = createTtsController({
    worker,
    now: () => 31_800,
    audioTarget: 'browser',
    async browserAudioEncoder() {
      throw new Error('ffmpeg unavailable');
    },
    audioStore: {
      putAudio() {
        throw new Error('must not store failed MP3');
      },
      toReferencePayload() {
        return null;
      }
    },
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: (message) => warnings.push(message), error: () => {} }
  });
  worker.emit('message', {
    type: 'ready',
    voice: 'af_heart',
    engine: 'kokoro',
    playback_backend: 'silent'
  });
  await controller.handleSayPayload({
    type: 'say',
    session_id: 'interpreter',
    utterance_id: 'turn-browser-fallback',
    text: 'Hello',
    audio_endpoint: 'browser',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: 31_800
  });
  const source = pcmWavBase64();
  worker.emit('message', {
    type: 'audio',
    generation: 1,
    mime_type: 'audio/wav',
    sample_rate: 44_100,
    audio_base64: source
  });
  await flushAsyncWork();

  assert.equal(broadcasts.filter((payload) => payload.type === 'tts_audio').length, 1);
  assert.equal(broadcasts.find((payload) => payload.type === 'tts_audio').audio_base64, source);
  assert.equal(broadcasts.find((payload) => payload.type === 'tts_audio').audio_codec, 'pcm16_wav');
  assert.equal(broadcasts.find((payload) => payload.type === 'tts_audio_ref'), undefined);
  assert.match(warnings[0], /MP3 encode failed/);
});

test('tts controller suppresses a late browser MP3 after that generation is interrupted', async () => {
  const worker = new FakeWorker();
  const broadcasts = [];
  let finishEncoding;
  const controller = createTtsController({
    worker,
    now: () => 31_850,
    audioTarget: 'browser',
    browserAudioEncoder() {
      return new Promise((resolve) => {
        finishEncoding = () => resolve({
          buffer: Buffer.from([0xff, 0xfb, 0x90, 0x64]),
          codec: 'mp3',
          mimeType: 'audio/mpeg',
          bitrate: 128_000
        });
      });
    },
    audioStore: {
      putAudio(payload) {
        return {
          id: '12345678-1234-1234-1234-123456789abc',
          ...payload
        };
      },
      toReferencePayload(entry) {
        return {
          type: 'tts_audio_ref',
          generation: entry.generation,
          audio_endpoint: entry.audioEndpoint
        };
      }
    },
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });
  await controller.handleSayPayload({
    type: 'say',
    session_id: 'interpreter',
    utterance_id: 'turn-interrupted',
    text: 'Hello',
    audio_endpoint: 'browser',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: 31_850
  });
  worker.emit('message', {
    type: 'audio',
    generation: 1,
    mime_type: 'audio/wav',
    sample_rate: 24_000,
    audio_base64: pcmWavBase64({ sampleRate: 24_000 })
  });
  await flushAsyncWork();
  assert.equal(typeof finishEncoding, 'function');
  await controller.interruptCurrent('manual_interrupt');
  finishEncoding();
  await flushAsyncWork();

  assert.equal(broadcasts.find((payload) => payload.type === 'tts_audio_ref'), undefined);
  assert.equal(broadcasts.find((payload) => payload.type === 'tts_audio'), undefined);
});

test('tts controller preserves generation order across asynchronous browser MP3 encodes', async () => {
  const worker = new FakeWorker();
  const broadcasts = [];
  const encodes = [];
  const controller = createTtsController({
    worker,
    now: () => 31_900,
    audioTarget: 'browser',
    browserAudioEncoder() {
      return new Promise((resolve) => {
        encodes.push(resolve);
      });
    },
    audioStore: {
      putAudio(payload) {
        return {
          id: `12345678-1234-1234-1234-${String(payload.generation).padStart(12, '0')}`,
          ...payload
        };
      },
      toReferencePayload(entry) {
        return {
          type: 'tts_audio_ref',
          generation: entry.generation,
          audio_endpoint: entry.audioEndpoint
        };
      }
    },
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  const encoded = () => ({
    buffer: Buffer.from([0xff, 0xfb, 0x90, 0x64]),
    codec: 'mp3',
    mimeType: 'audio/mpeg',
    bitrate: 128_000
  });
  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });
  await controller.handleSayPayload({
    type: 'say',
    session_id: 'interpreter',
    utterance_id: 'turn-one',
    text: 'One',
    audio_endpoint: 'browser',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: 31_900
  });
  worker.emit('message', {
    type: 'audio',
    generation: 1,
    mime_type: 'audio/wav',
    sample_rate: 24_000,
    audio_base64: pcmWavBase64({ sampleRate: 24_000 })
  });
  await controller.handleSayPayload({
    type: 'say',
    session_id: 'interpreter',
    utterance_id: 'turn-two',
    text: 'Two',
    audio_endpoint: 'browser',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: 31_900
  });
  worker.emit('message', {
    type: 'event',
    phase: 'play_stop',
    reason: 'completed',
    generation: 1
  });
  worker.emit('message', {
    type: 'audio',
    generation: 2,
    mime_type: 'audio/wav',
    sample_rate: 24_000,
    audio_base64: pcmWavBase64({ sampleRate: 24_000 })
  });
  await flushAsyncWork();
  assert.equal(encodes.length, 1);
  encodes[0](encoded());
  await flushAsyncWork();
  assert.equal(encodes.length, 2);
  encodes[1](encoded());
  await flushAsyncWork();

  assert.deepEqual(
    broadcasts.filter((payload) => payload.type === 'tts_audio_ref').map((payload) => payload.generation),
    [1, 2]
  );
});

test('tts controller broadcasts audio reference when audio store is configured', async () => {
  const worker = new FakeWorker();
  const broadcasts = [];
  const stored = [];
  const controller = createTtsController({
    worker,
    now: () => 32_000,
    audioTarget: 'browser',
    audioStore: {
      putAudio(payload) {
        stored.push(payload);
        return {
          id: 'audio-1',
          sessionId: payload.sessionId,
          agentId: payload.agentId,
          agentLabel: payload.agentLabel,
          utteranceId: payload.utteranceId,
          generation: payload.generation,
          messageId: payload.messageId,
          revision: payload.revision,
          mimeType: payload.mimeType,
          sampleRate: payload.sampleRate,
          byteLength: 4,
          durationMs: null,
          expiresAt: 92_000
        };
      },
      toReferencePayload(entry) {
        return {
          v: 1,
          type: 'tts_audio_ref',
          session_id: entry.sessionId,
          utterance_id: entry.utteranceId,
          generation: entry.generation,
          message_id: entry.messageId,
          revision: entry.revision,
          mime_type: entry.mimeType,
          sample_rate: entry.sampleRate,
          byte_length: entry.byteLength,
          duration_ms: entry.durationMs,
          expires_at: entry.expiresAt,
          url: `/api/tts/audio/${entry.id}.wav`,
          ts: 32_000
        };
      }
    },
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro', playback_backend: 'silent' });
  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    message_id: 'm-1',
    revision: 123,
    agent_id: '__operator__',
    text: 'browser audio',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: 32_000
  });

  worker.emit('message', {
    type: 'audio',
    generation: 1,
    mime_type: 'audio/wav',
    sample_rate: 24_000,
    audio_base64: 'ZmFrZQ=='
  });

  assert.equal(stored.length, 1);
  assert.equal(stored[0].audioBase64, 'ZmFrZQ==');
  assert.equal(stored[0].agentId, '__operator__');

  const ref = broadcasts.find((payload) => payload.type === 'tts_audio_ref');
  assert.ok(ref);
  assert.equal(ref.url, '/api/tts/audio/audio-1.wav');
  assert.equal(ref.message_id, 'm-1');
  assert.equal(ref.sample_rate, 24_000);

  const base64 = broadcasts.find((payload) => payload.type === 'tts_audio');
  assert.ok(base64);
  assert.equal(base64.audio_base64, 'ZmFrZQ==');
});

test('tts controller does not relay worker audio payload in local-only mode', async () => {
  const worker = new FakeWorker();
  const broadcasts = [];
  const controller = createTtsController({
    worker,
    now: () => 31_000,
    audioTarget: 'local',
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro', playback_backend: 'sounddevice' });
  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    text: 'local only',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: 31_000
  });

  worker.emit('message', {
    type: 'audio',
    generation: 1,
    session_id: 's1',
    utterance_id: 'u1',
    mime_type: 'audio/wav',
    sample_rate: 24_000,
    audio_base64: 'ZmFrZQ=='
  });

  const relayed = broadcasts.find((payload) => payload.type === 'tts_audio');
  assert.equal(relayed, undefined);
});

test('tts controller leaves english punctuation normalization to worker', async () => {
  const { worker, result } = await speakOnce({
    text: 'That’s a 9-to-5 role.'
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, 'That’s a 9-to-5 role.');
});

test('tts controller leaves smart quotes and nbsp normalization to worker', async () => {
  const { worker } = await speakOnce({
    text: 'He said, “Hello”… A\u00A0B\u202FC'
  });

  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, 'He said, “Hello”… A\u00A0B\u202FC');
});

test('tts controller leaves latin diacritic normalization to worker', async () => {
  const { worker } = await speakOnce({
    text: 'café naïve rôle'
  });

  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, 'café naïve rôle');
});

test('tts controller leaves mixed japanese and latin cleanup to worker', async () => {
  const { worker } = await speakOnce({
    text: '日本語が café'
  });

  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, '日本語が café');
});

test('tts controller keeps full-width symbols untouched', async () => {
  const { worker } = await speakOnce({
    text: 'ＡＢＣ！'
  });

  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, 'ＡＢＣ！');
});

test('tts controller leaves punctuation cleanup without language hint to worker', async () => {
  const { worker } = await speakOnce({
    text: 'That’s fine… café'
  });

  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, 'That’s fine… café');
});

test('tts controller keeps japanese punctuation inside regular text', async () => {
  const { worker } = await speakOnce({
    text: 'こんにちは。ありがとう、助かる・本当に'
  });

  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, 'こんにちは。ありがとう、助かる・本当に');
});

test('tts controller drops punctuation-only utterance after normalization', async () => {
  const { worker, result } = await speakOnce({
    text: '。、、・・。。。'
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'invalid_payload');
  assert.equal(speaks(worker).length, 0);

  const middleDotQuestion = await speakOnce({
    text: '・？'
  });
  assert.equal(middleDotQuestion.result.accepted, false);
  assert.equal(middleDotQuestion.result.reason, 'invalid_payload');
  assert.equal(speaks(middleDotQuestion.worker).length, 0);
});

// --- Step 1: long-utterance sentence chunking + sequential FIFO ---

test('segmentTtsText returns short text verbatim as a single chunk', () => {
  assert.deepEqual(segmentTtsText('こんにちは。ありがとう。', 120), ['こんにちは。ありがとう。']);
  assert.deepEqual(segmentTtsText('', 120), []);
});

test('segmentTtsText splits long text on sentence boundaries within the limit', () => {
  const text = '一つ目の文です。二つ目の文です。三つ目の文です。';
  const chunks = segmentTtsText(text, 8);
  assert.deepEqual(chunks, ['一つ目の文です。', '二つ目の文です。', '三つ目の文です。']);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 8, `chunk too long: ${chunk}`);
  }
  assert.equal(chunks.join(''), text);
});

test('segmentTtsText soft-splits an oversized single sentence on commas', () => {
  const text = 'あ、'.repeat(40); // 80 chars, no hard boundary
  const chunks = segmentTtsText(text, 20);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 20, `chunk too long: ${chunk}`);
  }
});

function makeController(options = {}) {
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => 42_000,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...options
  });
  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });
  return { worker, controller };
}

function finishActive(worker, generation) {
  worker.emit('message', { type: 'event', phase: 'play_stop', generation });
}

test('tts controller reports accepted active and queued work until the queue drains', async () => {
  const activity = [];
  const { worker, controller } = makeController({
    onActivityChange(next) {
      activity.push({ ...next });
    }
  });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: 42_000,
    text: 'first'
  });
  assert.deepEqual(activity.at(-1), { active: true, queued: 0 });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u2',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: 42_000,
    text: 'second'
  });
  assert.deepEqual(activity.at(-1), { active: true, queued: 1 });

  finishActive(worker, 1);
  assert.deepEqual(activity.at(-1), { active: true, queued: 0 });
  assert.equal(activity.some((next) => next.active === false), false);

  finishActive(worker, 2);
  assert.deepEqual(activity.at(-1), { active: false, queued: 0 });
});

test('tts controller does not report activity for speech rejected by the gate', async () => {
  const activity = [];
  const { controller } = makeController({
    gate: { check: () => ({ allow: false, reason: 'dedupe' }) },
    onActivityChange(next) {
      activity.push({ ...next });
    }
  });

  const result = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'rejected',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: 42_000,
    text: 'same'
  });

  assert.equal(result.accepted, false);
  assert.deepEqual(activity, []);
});

test('tts controller dispatches long-utterance chunks sequentially in order', async () => {
  const { worker, controller } = makeController({ maxChunkChars: 8 });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: 42_000,
    text: '一つ目の文です。二つ目の文です。三つ目の文です。'
  });

  // Only the first chunk is sent to the worker until it finishes.
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, '一つ目の文です。');

  finishActive(worker, 1);
  assert.equal(speaks(worker).length, 2);
  assert.equal(speaks(worker)[1].text, '二つ目の文です。');

  finishActive(worker, 1);
  assert.equal(speaks(worker).length, 3);
  assert.equal(speaks(worker)[2].text, '三つ目の文です。');

  // Draining the queue does not resend anything.
  finishActive(worker, 1);
  assert.equal(speaks(worker).length, 3);
});

test('tts controller flushes queued chunks when an interrupt utterance arrives', async () => {
  const { worker, controller } = makeController({ maxChunkChars: 8 });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: 42_000,
    text: '一つ目の文です。二つ目の文です。三つ目の文です。'
  });
  assert.equal(speaks(worker).length, 1);

  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u2',
    priority: 3,
    policy: 'interrupt',
    ttl_ms: 60_000,
    ts: 42_000,
    text: '緊急。'
  });

  assert.equal(interrupts(worker).length, 1);
  assert.equal(speaks(worker).length, 2);
  assert.equal(speaks(worker)[1].text, '緊急。');

  // The superseded utterance's queued chunks must not replay.
  finishActive(worker, 2);
  finishActive(worker, 2);
  assert.equal(speaks(worker).length, 2);
});

// --- Step 2: operator PTT barge-in flushes the queue ---

test('tts controller flushForBargeIn drops active and queued chunks', async () => {
  const { worker, controller } = makeController({ maxChunkChars: 8 });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: 42_000,
    text: '一つ目の文です。二つ目の文です。三つ目の文です。'
  });
  assert.equal(speaks(worker).length, 1);
  assert.equal(controller.snapshot().queuedChunks, 2);

  await controller.flushForBargeIn('operator_ptt');

  assert.equal(interrupts(worker).length, 1);
  assert.equal(controller.snapshot().activeGeneration, null);
  assert.equal(controller.snapshot().queuedChunks, 0);

  // Stale worker completion must not resurrect queued chunks.
  finishActive(worker, 1);
  assert.equal(speaks(worker).length, 1);

  // A new utterance after barge-in uses a fresh, higher generation.
  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u2',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: 42_000,
    text: '再開します。'
  });
  assert.equal(speaks(worker).length, 2);
  assert.ok(speaks(worker)[1].generation > speaks(worker)[0].generation);
});

test('tts controller flushForBargeIn clears the audio store', async () => {
  const worker = new FakeWorker();
  let cleared = 0;
  const controller = createTtsController({
    worker,
    now: () => 42_000,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    audioStore: { clear: () => { cleared += 1; } }
  });
  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  await controller.flushForBargeIn('operator_ptt');
  assert.equal(cleared, 1);
});

test('tts controller defers idle notification behind all queued answer chunks', async () => {
  const { worker, controller } = makeController({ maxChunkChars: 8 });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: 42_000,
    text: '一つ目の文です。二つ目の文です。三つ目の文です。'
  });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 'hook',
    utterance_id: 'idle',
    priority: 1,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: 42_000,
    text: '待機中です。',
    defer_until_idle: true
  });

  assert.equal(interrupts(worker).length, 0);
  assert.equal(speaks(worker).length, 1);
  assert.equal(controller.snapshot().queuedChunks, 3);

  finishActive(worker, 1);
  assert.equal(speaks(worker).length, 2);
  assert.equal(speaks(worker)[1].text, '二つ目の文です。');

  finishActive(worker, 1);
  assert.equal(speaks(worker).length, 3);
  assert.equal(speaks(worker)[2].text, '三つ目の文です。');

  finishActive(worker, 1);
  assert.equal(speaks(worker).length, 4);
  assert.equal(speaks(worker)[3].text, '待機中です。');
  assert.equal(speaks(worker)[3].generation, 2);
});

test('tts controller drops expired deferred idle notification at queue drain', async () => {
  let nowMs = 42_000;
  const worker = new FakeWorker();
  const broadcasts = [];
  const controller = createTtsController({
    worker,
    now: () => nowMs,
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) { broadcasts.push(payload); return true; },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    maxChunkChars: 8
  });
  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: nowMs,
    text: '一つ目の文です。二つ目の文です。'
  });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 'hook',
    utterance_id: 'idle',
    priority: 1,
    policy: 'replace',
    ttl_ms: 1_000,
    ts: nowMs,
    text: '待機中です。',
    defer_until_idle: true
  });

  finishActive(worker, 1);
  assert.equal(speaks(worker).length, 2);
  nowMs += 2_000;
  finishActive(worker, 1);

  assert.equal(speaks(worker).length, 2);
  const dropped = broadcasts.find((payload) => payload.type === 'tts_state' && payload.phase === 'dropped' && payload.generation === 2);
  assert.ok(dropped);
  assert.equal(dropped.reason, 'ttl_expired');
});
