import assert from 'node:assert/strict';
import test from 'node:test';
import { createTtsAudioStore } from '../../face-app/dist/tts_audio_store.js';
import { startFaceWebSocketServer } from '../../face-app/dist/ws_server.js';

function wavBase64() {
  const data = Buffer.from([0, 0, 1, 0]);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]).toString('base64');
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

  const get = await fetch(url, {
    headers: { authorization: 'Bearer secret-token' }
  });
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.equal(Buffer.from(await get.arrayBuffer()).length, 48);
});
