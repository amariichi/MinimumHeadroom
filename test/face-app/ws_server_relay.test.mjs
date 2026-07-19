import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFaceWebSocketServer } from '../../face-app/dist/ws_server.js';

function waitForOpen(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('WebSocket open timeout'));
    }, timeoutMs);

    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );

    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('WebSocket open failed'));
      },
      { once: true }
    );
  });
}

function waitForMessage(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('WebSocket message timeout'));
    }, timeoutMs);

    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(event.data));
        } catch (error) {
          reject(error);
        }
      },
      { once: true }
    );
  });
}

async function waitForCondition(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition timeout');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('ws server serves static ui and relays payloads to display clients', async (t) => {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const staticDir = path.resolve(currentDir, '../../face-app/public');

  const received = [];
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    staticDir,
    relayPayloads: true,
    onPayload(payload) {
      received.push(payload);
    },
    log: { info: () => {}, error: () => {} }
  });

  t.after(async () => {
    await server.stop();
  });

  const pageResponse = await fetch(server.httpUrl);
  assert.equal(pageResponse.status, 200);
  const pageText = await pageResponse.text();
  assert.match(pageText, /minimum headroom/i);

  const viewer = new WebSocket(server.url);
  const sender = new WebSocket(server.url);

  t.after(() => {
    try {
      viewer.close();
    } catch {
      // no-op
    }

    try {
      sender.close();
    } catch {
      // no-op
    }
  });

  await waitForOpen(viewer);
  await waitForOpen(sender);

  const payload = {
    v: 1,
    type: 'event',
    session_id: 'relay#test',
    ts: Date.now(),
    name: 'cmd_failed',
    severity: 0.7
  };

  const messagePromise = waitForMessage(viewer);
  sender.send(JSON.stringify(payload));

  const relayed = await messagePromise;
  assert.equal(relayed.type, 'event');
  assert.equal(relayed.session_id, 'relay#test');
  assert.equal(relayed.name, 'cmd_failed');

  assert.equal(received.length, 1);
  assert.equal(received[0].session_id, 'relay#test');
});

test('ws server replays latest replayable payloads to newly connected clients', async (t) => {
  const received = [];
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    relayPayloads: true,
    onPayload(payload) {
      received.push(payload);
    },
    log: { info: () => {}, error: () => {} }
  });

  t.after(async () => {
    await server.stop();
  });

  const sender = new WebSocket(server.url);
  let lateViewer = null;

  t.after(() => {
    try {
      sender.close();
    } catch {
      // no-op
    }

    try {
      lateViewer?.close();
    } catch {
      // no-op
    }
  });

  await waitForOpen(sender);

  const payload = {
    v: 1,
    type: 'operator_terminal_snapshot',
    session_id: 'replay#test',
    ts: Date.now(),
    lines: ['hello']
  };

  sender.send(JSON.stringify(payload));
  await waitForCondition(() => received.length === 1);

  lateViewer = new WebSocket(server.url);
  await waitForOpen(lateViewer);
  const replayed = await waitForMessage(lateViewer);

  assert.equal(replayed.type, 'operator_terminal_snapshot');
  assert.equal(replayed.session_id, 'replay#test');
  assert.deepEqual(replayed.lines, ['hello']);
});

test('audio focus observers receive only replayable focus state and cannot inject payloads', async (t) => {
  const received = [];
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    relayPayloads: true,
    onPayload(payload) {
      received.push(payload);
    },
    log: { info: () => {}, error: () => {} }
  });
  t.after(async () => server.stop());

  server.broadcast({ v: 1, type: 'media_state', state: 'active', revision: 1, ts: Date.now() });
  server.broadcast({ v: 1, type: 'audio_focus', state: 'normal', revision: 1, ts: Date.now() });

  const focus = new WebSocket(server.url, ['mh-audio-focus-v1']);
  const viewer = new WebSocket(server.url);
  const replayPromise = waitForMessage(focus);
  t.after(() => {
    focus.close();
    viewer.close();
  });
  await waitForOpen(focus);
  await waitForOpen(viewer);
  assert.equal(focus.protocol, 'mh-audio-focus-v1');

  const replay = await replayPromise;
  assert.equal(replay.type, 'audio_focus');
  assert.equal(replay.state, 'normal');

  let focusMessages = 0;
  let viewerMessages = 0;
  focus.addEventListener('message', () => {
    focusMessages += 1;
  });
  viewer.addEventListener('message', () => {
    viewerMessages += 1;
  });
  await delay(30);
  const viewerReplayMessages = viewerMessages;
  server.broadcast({ v: 1, type: 'event', name: 'cmd_started', ts: Date.now() });
  await delay(30);
  assert.equal(focusMessages, 0);
  assert.equal(viewerMessages, viewerReplayMessages + 1);

  const viewerMessagesBeforeInjection = viewerMessages;
  focus.send(JSON.stringify({ v: 1, type: 'event', name: 'injected', ts: Date.now() }));
  await delay(60);
  assert.equal(received.length, 0);
  assert.equal(viewerMessages, viewerMessagesBeforeInjection);

  const nextFocus = waitForMessage(focus);
  server.broadcast({ v: 1, type: 'audio_focus', state: 'speech', revision: 2, ts: Date.now() });
  assert.equal((await nextFocus).state, 'speech');
});

test('ws server allows custom HTTP API route handling', async (t) => {
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    relayPayloads: false,
    onHttpRequest(request, response) {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/api/health') {
        return false;
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true }));
      return true;
    },
    log: { info: () => {}, error: () => {} }
  });

  t.after(async () => {
    await server.stop();
  });

  const response = await fetch(`${server.httpUrl}api/health`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload, { ok: true });
});

test('ws server can suppress relay for server-only payloads', async (t) => {
  const received = [];
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    relayPayloads: true,
    onPayload(payload) {
      received.push(payload);
      if (payload.type === 'operator_realtime_asr_chunk') {
        return { relay: false };
      }
      return null;
    },
    log: { info: () => {}, error: () => {} }
  });

  t.after(async () => {
    await server.stop();
  });

  const viewer = new WebSocket(server.url);
  const sender = new WebSocket(server.url);

  t.after(() => {
    try {
      viewer.close();
    } catch {
      // no-op
    }

    try {
      sender.close();
    } catch {
      // no-op
    }
  });

  await waitForOpen(viewer);
  await waitForOpen(sender);

  let relayed = false;
  viewer.addEventListener('message', () => {
    relayed = true;
  });

  sender.send(
    JSON.stringify({
      v: 1,
      type: 'operator_realtime_asr_chunk',
      session_id: 'relay#suppressed',
      audio: 'ZmFrZQ==',
      sample_rate_hz: 16000,
      ts: Date.now()
    })
  );

  await delay(120);
  assert.equal(relayed, false);
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'operator_realtime_asr_chunk');
});


test("ws server suppresses audio payloads to arduino clients by default", async (t) => {
  const server = await startFaceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/ws",
    relayPayloads: true,
    log: { info: () => {}, error: () => {} }
  });

  t.after(async () => {
    await server.stop();
  });

  const arduino = new WebSocket(server.url, "arduino");
  const viewer = new WebSocket(server.url);

  t.after(() => {
    try { arduino.close(); } catch {}
    try { viewer.close(); } catch {}
  });

  await waitForOpen(arduino);
  await waitForOpen(viewer);

  const arduinoMessages = [];
  arduino.addEventListener("message", (event) => {
    arduinoMessages.push(JSON.parse(event.data));
  });

  const viewerAudioPromise = waitForMessage(viewer);
  server.broadcast({
    v: 1,
    type: "tts_audio",
    session_id: "audio#test",
    audio_base64: "ZmFrZQ==",
    mime_type: "audio/wav",
    ts: Date.now()
  });
  const viewerAudio = await viewerAudioPromise;
  assert.equal(viewerAudio.type, "tts_audio");

  const arduinoStatePromise = waitForMessage(arduino);
  server.broadcast({
    v: 1,
    type: "tts_state",
    session_id: "audio#test",
    phase: "play_start",
    ts: Date.now()
  });
  const arduinoState = await arduinoStatePromise;
  assert.equal(arduinoState.type, "tts_state");
  server.broadcast({
    v: 1,
    type: "media_state",
    state: "active",
    revision: 1,
    ts: Date.now()
  });
  server.broadcast({
    v: 1,
    type: "audio_focus",
    state: "speech",
    revision: 1,
    ts: Date.now()
  });
  await delay(20);
  assert.equal(arduinoMessages.some((payload) => payload.type === "tts_audio"), false);
  assert.equal(arduinoMessages.some((payload) => payload.type === "media_state"), false);
  assert.equal(arduinoMessages.some((payload) => payload.type === "audio_focus"), false);
});
