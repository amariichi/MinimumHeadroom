import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startFaceWebSocketServer } from '../../face-app/dist/ws_server.js';
import { createRuntimeModeApi } from '../../face-app/dist/runtime_mode_api.js';

function waitForOpen(socket, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), timeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket open failed'));
    }, { once: true });
  });
}

function websocketUrlWithToken(url, token) {
  const parsed = new URL(url);
  parsed.searchParams.set('auth_token', token);
  return parsed.toString();
}

function rawHttpRequest({ port, request }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(request);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
    socket.setTimeout(1000, () => {
      socket.destroy(new Error('raw request timeout'));
    });
  });
}

test('ws server requires bearer token for HTTP routes when auth is configured', async (t) => {
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    authToken: 'secret-token',
    requireOriginCheck: true,
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

  const denied = await fetch(`${server.httpUrl}api/health`);
  assert.equal(denied.status, 401);

  const allowed = await fetch(`${server.httpUrl}api/health`, {
    headers: {
      authorization: 'Bearer secret-token'
    }
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { ok: true });
});

test('runtime mode controls inherit bearer and origin protection from the shared server', async (t) => {
  const runtimeApi = createRuntimeModeApi({
    mode: 'operator',
    selection: 'default',
    controller: {
      async snapshot() {
        return {
          available: true,
          transition: { state: 'ready' }
        };
      },
      async requestSwitch(input) {
        return {
          transitionId: 'secured-transition',
          targetMode: input.mode,
          targetSelection: input.selection
        };
      }
    }
  });
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    authToken: 'runtime-token',
    allowedOrigins: ['https://allowed.example.test'],
    requireOriginCheck: true,
    relayPayloads: false,
    onHttpRequest: runtimeApi.handleHttpRequest,
    log: { info: () => {}, error: () => {} }
  });
  t.after(async () => {
    await server.stop();
  });

  const deniedToken = await fetch(`${server.httpUrl}api/runtime/mode`, {
    headers: { origin: 'https://allowed.example.test' }
  });
  assert.equal(deniedToken.status, 401);

  const deniedOrigin = await fetch(`${server.httpUrl}api/runtime/mode`, {
    headers: {
      authorization: 'Bearer runtime-token',
      origin: 'https://other.example.test'
    }
  });
  assert.equal(deniedOrigin.status, 403);

  const allowed = await fetch(`${server.httpUrl}api/runtime/mode`, {
    headers: {
      authorization: 'Bearer runtime-token',
      origin: 'https://allowed.example.test'
    }
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).mode, 'operator');
});

test('ws server keeps static ui bootstrap public when auth is configured', async (t) => {
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    authToken: 'secret-token',
    requireOriginCheck: true,
    relayPayloads: false,
    staticDir: fileURLToPath(new URL('../../face-app/public', import.meta.url)),
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

  const root = await fetch(server.httpUrl);
  assert.equal(root.status, 200);

  const appJs = await fetch(`${server.httpUrl}app.js`);
  assert.equal(appJs.status, 200);
});

test('ws server can persist a valid query token as an auth cookie', async (t) => {
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    authToken: 'cookie/token=ok',
    requireOriginCheck: true,
    relayPayloads: false,
    staticDir: fileURLToPath(new URL('../../face-app/public', import.meta.url)),
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

  const bootstrapUrl = new URL(server.httpUrl);
  bootstrapUrl.searchParams.set('auth_token', 'cookie/token=ok');
  const bootstrap = await fetch(bootstrapUrl);
  assert.equal(bootstrap.status, 200);
  const setCookie = bootstrap.headers.get('set-cookie');
  assert.match(setCookie, /mh_face_auth=/);
  assert.match(setCookie, /HttpOnly/);

  const cookie = setCookie.split(';')[0];
  const api = await fetch(`${server.httpUrl}api/health`, {
    headers: { cookie }
  });
  assert.equal(api.status, 200);
});

test('ws server requires token for WebSocket upgrades when auth is configured', async (t) => {
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    authToken: 'socket-token',
    requireOriginCheck: true,
    relayPayloads: true,
    log: { info: () => {}, error: () => {} }
  });

  t.after(async () => {
    await server.stop();
  });

  const denied = new WebSocket(server.url);
  await assert.rejects(waitForOpen(denied), /WebSocket open failed/);
  try {
    denied.close();
  } catch {}

  const allowed = new WebSocket(websocketUrlWithToken(server.url, 'socket-token'));
  t.after(() => {
    try {
      allowed.close();
    } catch {}
  });
  await waitForOpen(allowed);
});

test('ws server rejects disallowed browser origins', async (t) => {
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    authToken: 'origin-token',
    allowedOrigins: ['https://allowed.example.test'],
    requireOriginCheck: true,
    relayPayloads: false,
    log: { info: () => {}, error: () => {} }
  });

  t.after(async () => {
    await server.stop();
  });

  const denied = await fetch(`${server.httpUrl}api/health`, {
    headers: {
      authorization: 'Bearer origin-token',
      origin: 'https://evil.example.test'
    }
  });
  assert.equal(denied.status, 403);

  const allowedOrigin = await fetch(`${server.httpUrl}api/health`, {
    headers: {
      authorization: 'Bearer origin-token',
      origin: 'https://allowed.example.test'
    }
  });
  assert.notEqual(allowedOrigin.status, 403);

  const rawDenied = await rawHttpRequest({
    port: server.port,
    request: [
      'GET /ws?auth_token=origin-token HTTP/1.1',
      `Host: 127.0.0.1:${server.port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      'Origin: https://evil.example.test',
      '',
      ''
    ].join('\r\n')
  });
  assert.match(rawDenied, /^HTTP\/1\.1 403 Forbidden/);
});

test('face app refuses non-loopback bind without auth token', async () => {
  const child = spawn(process.execPath, ['face-app/dist/index.js'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      FACE_WS_HOST: '0.0.0.0',
      FACE_WS_PORT: '0',
      FACE_TTS_ENABLED: '0',
      MH_FACE_AUTH_TOKEN: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('face app startup guard timeout'));
    }, 2000);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    child.on('error', reject);
  });

  assert.equal(code, 2);
  assert.match(stderr, /MH_FACE_AUTH_TOKEN is required/);
});
