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
