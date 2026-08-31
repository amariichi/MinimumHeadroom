import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { gunzipSync } from 'node:zlib';
import {
  armTerminalResetAfterDrain,
  encodeTerminalPayloadForSubscription,
  planTerminalDataDelivery,
  receivedPayloadLogMessage,
  startFaceWebSocketServer
} from '../../face-app/dist/ws_server.js';

const silentLog = {
  info() {},
  warn() {},
  error() {}
};

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

test('Atom frame logs omit audio and sample only stream checkpoints', () => {
  const first = receivedPayloadLogMessage({
    v: 1,
    type: 'atom_audio_frame',
    session_id: 'atom-log',
    device_id: 'atom-one',
    sample_rate: 16_000,
    sample_count: 1024,
    encoding: 'pcm16',
    generation: 2,
    seq: 1,
    audio_base64: 'secret-audio-content'
  });
  assert.match(first, /"seq":1/);
  assert.match(first, /"audio_base64_chars":20/);
  assert.doesNotMatch(first, /secret-audio-content/);

  assert.equal(receivedPayloadLogMessage({
    type: 'atom_audio_frame',
    seq: 2,
    audio_base64: 'secret-audio-content'
  }), null);
  assert.match(receivedPayloadLogMessage({
    type: 'atom_audio_frame',
    seq: 50,
    audio_base64: 'secret-audio-content'
  }), /"seq":50/);
});

test('terminal frame logs omit output bytes and high-frequency acknowledgements', () => {
  const reset = receivedPayloadLogMessage({
    v: 1,
    type: 'operator_terminal_reset',
    session_id: 'default',
    pane: '%7',
    generation: 3,
    seq: 10,
    cols: 80,
    rows: 24,
    data_base64: 'secret-terminal-content'
  });
  assert.match(reset, /"type":"operator_terminal_reset"/u);
  assert.match(reset, /"data_base64_chars":23/u);
  assert.doesNotMatch(reset, /secret-terminal-content/u);

  assert.equal(receivedPayloadLogMessage({
    type: 'operator_terminal_data',
    seq: 11,
    data_base64: 'secret-terminal-content'
  }), null);
  assert.equal(receivedPayloadLogMessage({
    type: 'operator_terminal_ack',
    seq: 11
  }), null);
});

test('terminal backpressure requests one reset after the socket drains', () => {
  const socket = new EventEmitter();
  socket.__mhTerminalNeedsReset = true;
  let resetRequests = 0;

  assert.equal(armTerminalResetAfterDrain(socket, () => {
    resetRequests += 1;
  }), true);
  assert.equal(armTerminalResetAfterDrain(socket, () => {
    resetRequests += 1;
  }), false);
  assert.equal(resetRequests, 0);

  socket.emit('drain');
  assert.equal(resetRequests, 1);
  assert.equal(socket.__mhTerminalResetOnDrain, false);

  socket.__mhTerminalNeedsReset = false;
  assert.equal(armTerminalResetAfterDrain(socket, () => {
    resetRequests += 1;
  }), true);
  socket.emit('drain');
  assert.equal(resetRequests, 1);
});

test('a latched terminal socket asks for a reset as soon as its buffer drains', () => {
  const highWater = 256 * 1024;
  const socket = new EventEmitter();
  socket.writableLength = 0;
  socket.__mhTerminalNeedsReset = false;

  assert.equal(planTerminalDataDelivery(socket, highWater), 'send');

  socket.writableLength = highWater + 1;
  assert.equal(planTerminalDataDelivery(socket, highWater), 'latch');

  socket.__mhTerminalNeedsReset = true;
  assert.equal(planTerminalDataDelivery(socket, highWater), 'suppress');

  // The socket caught up without ever emitting 'drain'. Before this fix the
  // mirror stayed dark until the user switched panes; now the next data frame
  // triggers a fresh reset request instead.
  socket.writableLength = 1024;
  assert.equal(planTerminalDataDelivery(socket, highWater), 'resync');

  socket.__mhTerminalNeedsReset = false;
  assert.equal(planTerminalDataDelivery(socket, highWater), 'send');
});

test('terminal payload compression is negotiated and lossless', () => {
  const raw = Buffer.from('spinner redraw '.repeat(200));
  const payload = {
    type: 'operator_terminal_data',
    data_base64: raw.toString('base64')
  };
  const encoded = encodeTerminalPayloadForSubscription(payload, { dataEncoding: 'gzip-base64' });
  assert.equal(encoded.data_encoding, 'gzip-base64');
  assert.equal(encoded.data_uncompressed_bytes, raw.length);
  assert.deepEqual(gunzipSync(Buffer.from(encoded.data_base64, 'base64')), raw);
  assert.equal(encodeTerminalPayloadForSubscription(payload, { dataEncoding: 'base64' }), payload);
});

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

  const xtermModuleResponse = await fetch(new URL('/vendor/xterm.mjs', server.httpUrl));
  assert.equal(xtermModuleResponse.status, 200);
  assert.match(xtermModuleResponse.headers.get('content-type'), /javascript/u);
  assert.match(xtermModuleResponse.headers.get('cache-control'), /max-age=86400/u);
  const xtermModuleText = await xtermModuleResponse.text();
  assert.equal(xtermModuleText.includes('export{'), true);

  const xtermCssResponse = await fetch(new URL('/vendor/xterm.css', server.httpUrl));
  assert.equal(xtermCssResponse.status, 200);
  assert.match(xtermCssResponse.headers.get('content-type'), /text\/css/u);

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

test('ws server routes terminal streams only between subscribed browsers and the marked operator bridge', async (t) => {
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    relayPayloads: true,
    log: silentLog
  });

  const bridge = new WebSocket(server.url, 'mh-operator-bridge-v1');
  const viewer = new WebSocket(server.url);
  const bystander = new WebSocket(server.url);
  t.after(async () => {
    try { bridge.close(); } catch {}
    try { viewer.close(); } catch {}
    try { bystander.close(); } catch {}
    await server.stop();
  });

  await Promise.all([waitForOpen(bridge), waitForOpen(viewer), waitForOpen(bystander)]);
  assert.equal(bridge.protocol, 'mh-operator-bridge-v1');

  let bystanderTerminalMessages = 0;
  bystander.addEventListener('message', (event) => {
    try {
      if (JSON.parse(event.data)?.type?.startsWith('operator_terminal_')) {
        bystanderTerminalMessages += 1;
      }
    } catch {}
  });

  const subscribePromise = waitForMessage(bridge);
  viewer.send(JSON.stringify({
    v: 1,
    type: 'operator_terminal_subscribe',
    session_id: 'default',
    data_encodings: ['gzip-base64', 'base64'],
    ts: Date.now()
  }));
  const subscribe = await subscribePromise;
  assert.equal(subscribe.type, 'operator_terminal_subscribe');
  assert.match(subscribe.subscriber_id, /^terminal-\d+$/u);

  const dataPromise = waitForMessage(viewer);
  const terminalDelta = 'delta'.repeat(200);
  bridge.send(JSON.stringify({
    v: 1,
    type: 'operator_terminal_data',
    session_id: 'default',
    pane: '%9',
    generation: 2,
    seq: 4,
    data_base64: Buffer.from(terminalDelta).toString('base64')
  }));
  const data = await dataPromise;
  assert.equal(data.type, 'operator_terminal_data');
  assert.equal(data.data_encoding, 'gzip-base64');
  assert.equal(
    gunzipSync(Buffer.from(data.data_base64, 'base64')).toString('utf8'),
    terminalDelta
  );
  await delay(40);
  assert.equal(bystanderTerminalMessages, 0);

  const ackPromise = waitForMessage(bridge);
  viewer.send(JSON.stringify({
    v: 1,
    type: 'operator_terminal_ack',
    session_id: 'default',
    pane: '%9',
    generation: 2,
    seq: 4
  }));
  const ack = await ackPromise;
  assert.equal(ack.type, 'operator_terminal_ack');
  assert.equal(ack.subscriber_id, subscribe.subscriber_id);

  const unsubscribePromise = waitForMessage(bridge);
  viewer.close();
  const unsubscribe = await unsubscribePromise;
  assert.equal(unsubscribe.type, 'operator_terminal_unsubscribe');
  assert.equal(unsubscribe.subscriber_id, subscribe.subscriber_id);
});

test('terminal subscriptions are replayed when an operator bridge reconnects, but terminal data is not replay-cached', async (t) => {
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    relayPayloads: true,
    log: silentLog
  });
  const viewer = new WebSocket(server.url);
  let bridge = null;
  t.after(async () => {
    try { viewer.close(); } catch {}
    try { bridge?.close(); } catch {}
    await server.stop();
  });
  await waitForOpen(viewer);
  viewer.send(JSON.stringify({ type: 'operator_terminal_subscribe', session_id: 'default' }));
  await delay(20);

  bridge = new WebSocket(server.url, 'mh-operator-bridge-v1');
  const replayedSubscribePromise = waitForMessage(bridge);
  await waitForOpen(bridge);
  const replayedSubscribe = await replayedSubscribePromise;
  assert.equal(replayedSubscribe.type, 'operator_terminal_subscribe');

  bridge.send(JSON.stringify({
    type: 'operator_terminal_data',
    session_id: 'default',
    pane: '%9',
    generation: 1,
    seq: 1,
    data_base64: Buffer.from('live-only').toString('base64')
  }));
  await waitForMessage(viewer);

  const lateViewer = new WebSocket(server.url);
  t.after(() => {
    try { lateViewer.close(); } catch {}
  });
  let lateMessages = 0;
  lateViewer.addEventListener('message', () => {
    lateMessages += 1;
  });
  await waitForOpen(lateViewer);
  await delay(60);
  assert.equal(lateMessages, 0);
});

test('one active operator bridge per session prevents duplicate terminal publishers and promotes a standby', async (t) => {
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    relayPayloads: true,
    log: silentLog
  });
  const bridgeUrl = new URL(server.url);
  bridgeUrl.searchParams.set('operator_session_id', 'default');
  const bridgeOne = new WebSocket(bridgeUrl, 'mh-operator-bridge-v1');
  const viewer = new WebSocket(server.url);
  let bridgeTwo = null;
  t.after(async () => {
    try { bridgeOne.close(); } catch {}
    try { bridgeTwo?.close(); } catch {}
    try { viewer.close(); } catch {}
    await server.stop();
  });
  await Promise.all([waitForOpen(bridgeOne), waitForOpen(viewer)]);

  const firstSubscribePromise = waitForMessage(bridgeOne);
  viewer.send(JSON.stringify({ type: 'operator_terminal_subscribe', session_id: 'default' }));
  const firstSubscribe = await firstSubscribePromise;
  assert.equal(firstSubscribe.type, 'operator_terminal_subscribe');

  const oldBridgeUnsubscribePromise = waitForMessage(bridgeOne);
  bridgeTwo = new WebSocket(bridgeUrl, 'mh-operator-bridge-v1');
  const promotedSubscribePromise = waitForMessage(bridgeTwo);
  await waitForOpen(bridgeTwo);
  const [oldBridgeUnsubscribe, promotedSubscribe] = await Promise.all([
    oldBridgeUnsubscribePromise,
    promotedSubscribePromise
  ]);
  assert.equal(oldBridgeUnsubscribe.type, 'operator_terminal_unsubscribe');
  assert.equal(oldBridgeUnsubscribe.subscriber_id, firstSubscribe.subscriber_id);
  assert.equal(promotedSubscribe.type, 'operator_terminal_subscribe');
  assert.equal(promotedSubscribe.subscriber_id, firstSubscribe.subscriber_id);

  let oldBridgeResponses = 0;
  let activeBridgeResponses = 0;
  bridgeOne.addEventListener('message', (event) => {
    try {
      if (JSON.parse(event.data)?.type === 'operator_response') oldBridgeResponses += 1;
    } catch {}
  });
  bridgeTwo.addEventListener('message', (event) => {
    try {
      if (JSON.parse(event.data)?.type === 'operator_response') activeBridgeResponses += 1;
    } catch {}
  });
  viewer.send(JSON.stringify({
    type: 'operator_response',
    session_id: 'default',
    response_kind: 'text',
    value: 'submit once'
  }));
  await waitForCondition(() => activeBridgeResponses === 1);
  await delay(40);
  assert.equal(oldBridgeResponses, 0, 'one mobile response must reach only the active bridge');

  const terminalMessages = [];
  viewer.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload?.type === 'operator_terminal_data') terminalMessages.push(payload);
    } catch {}
  });
  const terminalFrame = {
    type: 'operator_terminal_data',
    session_id: 'default',
    pane: '%9',
    generation: 1,
    seq: 1,
    data_base64: Buffer.from('one redraw only').toString('base64')
  };
  bridgeOne.send(JSON.stringify(terminalFrame));
  await delay(50);
  assert.equal(terminalMessages.length, 0, 'inactive bridge output must be ignored');

  bridgeTwo.send(JSON.stringify(terminalFrame));
  await waitForCondition(() => terminalMessages.length === 1);
  assert.equal(Buffer.from(terminalMessages[0].data_base64, 'base64').toString('utf8'), 'one redraw only');

  const standbySubscribePromise = waitForMessage(bridgeOne);
  bridgeTwo.close();
  const standbySubscribe = await standbySubscribePromise;
  assert.equal(standbySubscribe.type, 'operator_terminal_subscribe');
  assert.equal(standbySubscribe.subscriber_id, firstSubscribe.subscriber_id);

  bridgeOne.send(JSON.stringify({ ...terminalFrame, seq: 2 }));
  await waitForCondition(() => terminalMessages.length === 2);
  assert.equal(terminalMessages.length, 2);
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
  const authToken = 'focus/+token=';
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    relayPayloads: true,
    authToken,
    onPayload(payload) {
      received.push(payload);
    },
    log: { info: () => {}, error: () => {} }
  });
  t.after(async () => server.stop());

  server.broadcast({ v: 1, type: 'media_state', state: 'active', revision: 1, ts: Date.now() });
  server.broadcast({ v: 1, type: 'audio_focus', state: 'normal', revision: 1, ts: Date.now() });

  const encodedAuth = Buffer.from(authToken, 'utf8').toString('base64url');
  const focus = new WebSocket(server.url, ['mh-audio-focus-v1', 'mh-face-auth-b64.' + encodedAuth]);
  const viewerUrl = new URL(server.url);
  viewerUrl.searchParams.set('auth_token', authToken);
  const viewer = new WebSocket(viewerUrl);
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

test("ws server routes endpoint-targeted TTS audio without browser/Atom duplication", async (t) => {
  const server = await startFaceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    relayPayloads: true,
    log: silentLog
  });
  t.after(async () => {
    await server.stop();
  });

  const browser = new WebSocket(server.url);
  const atomBridge = new WebSocket(server.url, "mh-atom-http-bridge-v1");
  t.after(() => {
    try { browser.close(); } catch {}
    try { atomBridge.close(); } catch {}
  });
  await Promise.all([waitForOpen(browser), waitForOpen(atomBridge)]);

  const browserMessages = [];
  const atomMessages = [];
  browser.addEventListener("message", (event) => browserMessages.push(JSON.parse(event.data)));
  atomBridge.addEventListener("message", (event) => atomMessages.push(JSON.parse(event.data)));

  server.broadcast({
    type: "tts_audio",
    audio_endpoint: "atom",
    audio_base64: "YQ=="
  });
  server.broadcast({
    type: "tts_audio",
    audio_endpoint: "browser",
    audio_base64: "Yg=="
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(browserMessages.some((payload) => payload.audio_base64 === "YQ=="), false);
  assert.equal(browserMessages.some((payload) => payload.audio_base64 === "Yg=="), true);
  assert.equal(atomMessages.some((payload) => payload.audio_base64 === "YQ=="), true);
  assert.equal(atomMessages.some((payload) => payload.audio_base64 === "Yg=="), false);
});

test("ws server prefers one direct Atom transport over the HTTP bridge", async (t) => {
  const server = await startFaceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    relayPayloads: true,
    log: silentLog
  });
  t.after(async () => {
    await server.stop();
  });

  const directAtom = new WebSocket(server.url, "arduino");
  const atomBridge = new WebSocket(server.url, "mh-atom-http-bridge-v1");
  t.after(() => {
    try { directAtom.close(); } catch {}
    try { atomBridge.close(); } catch {}
  });
  await Promise.all([waitForOpen(directAtom), waitForOpen(atomBridge)]);

  const directMessages = [];
  const bridgeMessages = [];
  directAtom.addEventListener("message", (event) => directMessages.push(JSON.parse(event.data)));
  atomBridge.addEventListener("message", (event) => bridgeMessages.push(JSON.parse(event.data)));

  server.broadcast({
    type: "tts_audio",
    audio_endpoint: "atom",
    audio_base64: "b25jZQ=="
  });
  await delay(25);

  assert.equal(directMessages.some((payload) => payload.audio_base64 === "b25jZQ=="), true);
  assert.equal(bridgeMessages.some((payload) => payload.audio_base64 === "b25jZQ=="), false);
});

test("ws server prefers the HTTP bridge for Atom audio references", async (t) => {
  const server = await startFaceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    relayPayloads: true,
    log: silentLog
  });
  t.after(async () => {
    await server.stop();
  });

  const directAtom = new WebSocket(server.url, "arduino");
  const atomBridge = new WebSocket(server.url, "mh-atom-http-bridge-v1");
  t.after(() => {
    try { directAtom.close(); } catch {}
    try { atomBridge.close(); } catch {}
  });
  await Promise.all([waitForOpen(directAtom), waitForOpen(atomBridge)]);

  const directMessages = [];
  const bridgeMessages = [];
  directAtom.addEventListener("message", (event) => directMessages.push(JSON.parse(event.data)));
  atomBridge.addEventListener("message", (event) => bridgeMessages.push(JSON.parse(event.data)));

  server.broadcast({
    type: "tts_audio_ref",
    audio_endpoint: "atom",
    audio_id: "reference-one",
    url: "/api/tts/audio/reference-one.wav"
  });
  await delay(25);

  assert.equal(directMessages.some((payload) => payload.audio_id === "reference-one"), false);
  assert.equal(bridgeMessages.some((payload) => payload.audio_id === "reference-one"), true);
});

test("ws server can send a correlated control payload to one selected Atom socket", async (t) => {
  let selectedSocket = null;
  const server = await startFaceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    relayPayloads: true,
    onPayload(payload, context) {
      if (payload.type === "atom_endpoint_state") {
        selectedSocket = context.socket;
        return { relay: false };
      }
      return null;
    },
    log: silentLog
  });
  t.after(async () => {
    await server.stop();
  });

  const atomBridge = new WebSocket(server.url, "mh-atom-http-bridge-v1");
  t.after(() => {
    try { atomBridge.close(); } catch {}
  });
  await waitForOpen(atomBridge);
  atomBridge.send(JSON.stringify({
    type: "atom_endpoint_state",
    connected: true
  }));
  await waitForCondition(() => selectedSocket !== null);

  const received = waitForMessage(atomBridge);
  assert.equal(server.sendToSocket(selectedSocket, {
    type: "atom_volume_set",
    request_id: "volume-one",
    volume: 160
  }), true);
  assert.deepEqual(await received, {
    type: "atom_volume_set",
    request_id: "volume-one",
    volume: 160
  });
  assert.equal(server.sendToSocket({}, { type: "ignored" }), false);
});

test("ws server serves a configured default document without changing the operator default", async (t) => {
  const staticDir = await mkdtemp(path.join(tmpdir(), "mh-default-document-"));
  await writeFile(path.join(staticDir, "index.html"), "operator");
  await writeFile(path.join(staticDir, "interpreter.html"), "interpreter");
  const server = await startFaceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    staticDir,
    defaultDocument: "interpreter.html",
    log: silentLog
  });
  t.after(async () => {
    await server.stop();
  });
  const response = await fetch(server.httpUrl);
  assert.equal(await response.text(), "interpreter");
});

test("ws server can expose a separate clean document route", async (t) => {
  const staticDir = await mkdtemp(path.join(tmpdir(), "mh-document-route-"));
  await writeFile(path.join(staticDir, "index.html"), "operator");
  await writeFile(path.join(staticDir, "interpreter.html"), "interpreter");
  const server = await startFaceWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    staticDir,
    documentRoutes: {
      "/interpreter": "interpreter.html",
      "/interpreter/": "interpreter.html"
    },
    log: silentLog
  });
  t.after(async () => {
    await server.stop();
  });

  const response = await fetch(`${server.httpUrl}interpreter`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "interpreter");
});
