import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePcm16WavToImaAdpcmWav } from '../../face-app/dist/ima_adpcm_wav.js';
import { createTtsAudioStore } from '../../face-app/dist/tts_audio_store.js';
import { startFaceWebSocketServer } from '../../face-app/dist/ws_server.js';

function pcmWavBuffer({ sampleRate = 24_000, sampleCount = 2 } = {}) {
  const data = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    data.writeInt16LE(Math.round(4_000 * Math.sin(2 * Math.PI * 220 * index / sampleRate)), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function wavBase64() {
  return pcmWavBuffer().toString('base64');
}

test('tts audio store returns reference metadata and expires entries', () => {
  let nowMs = 10_000;
  const store = createTtsAudioStore({ now: () => nowMs, ttlMs: 1_000 });

  const entry = store.putAudio({
    audioBase64: wavBase64(),
    mimeType: 'audio/wav',
    sampleRate: 24_000,
    sessionId: 's1',
    utteranceId: 'u1',
    generation: 7,
    messageId: 'm1',
    revision: 123
  });
  assert.ok(entry);

  const ref = store.toReferencePayload(entry);
  assert.equal(ref.type, 'tts_audio_ref');
  assert.equal(ref.audio_id, entry.id);
  assert.equal(ref.audio_codec, 'pcm16_wav');
  assert.equal(ref.session_id, 's1');
  assert.equal(ref.utterance_id, 'u1');
  assert.equal(ref.generation, 7);
  assert.equal(ref.mime_type, 'audio/wav');
  assert.equal(ref.sample_rate, 24_000);
  assert.equal(ref.byte_length, 48);
  assert.equal(ref.duration_ms, 0);
  assert.match(ref.url, /^\/api\/tts\/audio\/[0-9a-f-]+\.wav$/);
  assert.equal(store.size(), 1);

  nowMs += 1_001;
  assert.equal(store.get(entry.id), null);
  assert.equal(store.size(), 0);
});

test('tts audio store reads ADPCM duration from the fact sample count', () => {
  const store = createTtsAudioStore({ now: () => 10_000 });
  const pcm = pcmWavBuffer({ sampleRate: 24_000, sampleCount: 4_800 });
  const encoded = encodePcm16WavToImaAdpcmWav(pcm);
  const entry = store.putAudio({
    audioBuffer: encoded.buffer,
    audioCodec: encoded.codec,
    sampleRate: encoded.sampleRate,
    sessionId: 'interpreter',
    audioEndpoint: 'atom'
  });

  assert.ok(entry);
  assert.equal(entry.audioCodec, 'ima_adpcm_wav');
  assert.equal(entry.durationMs, 200);
  assert.ok(entry.byteLength < pcm.length * 0.3);
  assert.equal(store.toReferencePayload(entry).audio_codec, 'ima_adpcm_wav');
});

test('tts audio store publishes MP3 metadata while retaining source WAV duration', () => {
  const store = createTtsAudioStore({ now: () => 10_000 });
  const pcm = pcmWavBuffer({ sampleRate: 24_000, sampleCount: 4_800 });
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x01]);
  const entry = store.putAudio({
    audioBase64: pcm.toString('base64'),
    audioBuffer: mp3,
    mimeType: 'audio/mpeg',
    audioCodec: 'mp3',
    bitrate: 128_000,
    sampleRate: 24_000,
    sessionId: 'interpreter',
    audioEndpoint: 'browser'
  });

  assert.ok(entry);
  assert.equal(entry.audioCodec, 'mp3');
  assert.equal(entry.mimeType, 'audio/mpeg');
  assert.equal(entry.bitrate, 128_000);
  assert.equal(entry.durationMs, 200);
  assert.deepEqual(entry.audio, mp3);
  const ref = store.toReferencePayload(entry);
  assert.equal(ref.audio_codec, 'mp3');
  assert.equal(ref.mime_type, 'audio/mpeg');
  assert.equal(ref.bitrate, 128_000);
  assert.equal(ref.audio_endpoint, 'browser');
  assert.match(ref.url, /^\/api\/tts\/audio\/[0-9a-f-]+\.mp3$/);
});

test('tts audio endpoint supports authenticated HEAD and GET', async (t) => {
  const store = createTtsAudioStore({ ttlMs: 60_000 });
  const entry = store.putAudio({
    audioBase64: wavBase64(),
    mimeType: 'audio/wav',
    sampleRate: 24_000,
    sessionId: 's1',
    utteranceId: 'u1',
    generation: 1
  });

  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    authToken: 'secret-token',
    requireOriginCheck: true,
    relayPayloads: false,
    onHttpRequest(request, response) {
      return store.handleHttpRequest(request, response);
    },
    log: { info: () => {}, error: () => {} }
  });

  t.after(async () => {
    await server.stop();
  });

  const url = `${server.httpUrl}api/tts/audio/${entry.id}.wav`;
  const denied = await fetch(url);
  assert.equal(denied.status, 401);

  const head = await fetch(url, {
    method: 'HEAD',
    headers: { authorization: 'Bearer secret-token' }
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'audio/wav');
  assert.equal(head.headers.get('content-length'), '48');
  assert.equal(head.headers.get('x-audio-id'), entry.id);
  assert.equal(head.headers.get('x-audio-codec'), 'pcm16_wav');

  const get = await fetch(url, {
    headers: { authorization: 'Bearer secret-token' }
  });
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.equal(Buffer.from(await get.arrayBuffer()).length, 48);

  const mp3Bytes = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x01]);
  const mp3Entry = store.putAudio({
    audioBase64: wavBase64(),
    audioBuffer: mp3Bytes,
    mimeType: 'audio/mpeg',
    audioCodec: 'mp3',
    bitrate: 128_000,
    sampleRate: 24_000,
    sessionId: 's1',
    audioEndpoint: 'browser'
  });
  const mp3Url = `${server.httpUrl}api/tts/audio/${mp3Entry.id}.mp3`;
  const mp3Response = await fetch(mp3Url, {
    headers: { authorization: 'Bearer secret-token' }
  });
  assert.equal(mp3Response.status, 200);
  assert.equal(mp3Response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(mp3Response.headers.get('content-length'), String(mp3Bytes.length));
  assert.equal(mp3Response.headers.get('x-audio-codec'), 'mp3');
  assert.equal(mp3Response.headers.get('x-audio-bitrate'), '128000');
  assert.deepEqual(Buffer.from(await mp3Response.arrayBuffer()), mp3Bytes);
});
