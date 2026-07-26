import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { startFaceWebSocketServer } from '../../face-app/dist/ws_server.js';

function createJsonLineRpc(child) {
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const waiters = new Map();

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        break;
      }
      const line = buffer.subarray(0, newline).toString('utf8').trim();
      buffer = buffer.subarray(newline + 1);
      if (line === '') {
        continue;
      }
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    }
  });

  child.stderr.resume();

  return {
    call(method, params) {
      const id = nextId;
      nextId += 1;
      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`timed out waiting for ${method}`));
        }, 2000);
        waiters.set(id, {
          resolve(message) {
            clearTimeout(timeout);
            resolve(message);
          }
        });
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      });
    }
  };
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 1200);
  });
}

test('mcp face tools bind omitted agent_id from MH_FACE_AGENT_ID and reject mismatches', async (t) => {
  const received = [];
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    staticDir: path.resolve(process.cwd(), 'face-app/public'),
    relayPayloads: false,
    onPayload(payload) {
      received.push(payload);
    },
    log: { info: () => {}, error: () => {} }
  });

  t.after(async () => {
    await server.stop();
  });

  const child = spawn('node', [path.resolve(process.cwd(), 'mcp-server/dist/index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FACE_WS_URL: server.url,
      FACE_HTTP_BASE_URL: server.httpUrl,
      MH_FACE_AGENT_ID: 'helper-a',
      MH_FACE_AGENT_LABEL: 'Helper A'
    }
  });
  t.after(async () => {
    await stopChild(child);
  });
  const rpc = createJsonLineRpc(child);

  const boundResponse = await rpc.call('tools/call', {
    name: 'face.event',
    arguments: {
      session_id: 'identity-test',
      name: 'cmd_started'
    }
  });
  assert.equal(boundResponse.result.structuredContent.ok, true);
  assert.equal(boundResponse.result.structuredContent.effective_agent_id, 'helper-a');
  assert.equal(boundResponse.result.structuredContent.agent_id_source, 'env');
  assert.equal(boundResponse.result.structuredContent.payload.agent_id, 'helper-a');
  assert.equal(boundResponse.result.structuredContent.payload.agent_label, 'Helper A');
  assert.equal(received.at(-1)?.agent_id, 'helper-a');

  const mismatchResponse = await rpc.call('tools/call', {
    name: 'face.event',
    arguments: {
      session_id: 'identity-test',
      agent_id: '__operator__',
      name: 'cmd_started'
    }
  });
  assert.equal(mismatchResponse.result.isError, true);
  assert.equal(mismatchResponse.result.structuredContent.ok, false);
  assert.equal(mismatchResponse.result.structuredContent.effective_agent_id, 'helper-a');
  assert.equal(mismatchResponse.result.structuredContent.requested_agent_id, '__operator__');
  assert.equal(mismatchResponse.result.structuredContent.identity_warning, 'agent_id_mismatch');
  assert.match(mismatchResponse.result.structuredContent.identity_reason, /does not match/i);
  assert.match(mismatchResponse.result.structuredContent.identity_remediation, /agent_id to "helper-a"/);
  assert.match(mismatchResponse.result.content[0].text, /Remediation: Retry without agent_id/i);
  assert.equal(received.length, 1, 'mismatched payload should not be forwarded');
});

test('mcp face tools warn when no agent binding is available', async (t) => {
  const received = [];
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    staticDir: path.resolve(process.cwd(), 'face-app/public'),
    relayPayloads: false,
    onPayload(payload) {
      received.push(payload);
    },
    log: { info: () => {}, error: () => {} }
  });

  t.after(async () => {
    await server.stop();
  });

  const env = { ...process.env, FACE_WS_URL: server.url, FACE_HTTP_BASE_URL: server.httpUrl };
  delete env.MH_FACE_AGENT_ID;
  delete env.MH_FACE_AGENT_LABEL;
  delete env.MH_FACE_AGENT_ID_REQUIRED;
  delete env.MH_FACE_IDENTITY_STRICT;

  const child = spawn('node', [path.resolve(process.cwd(), 'mcp-server/dist/index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  });
  t.after(async () => {
    await stopChild(child);
  });
  const rpc = createJsonLineRpc(child);

  const response = await rpc.call('tools/call', {
    name: 'face.ping',
    arguments: {
      session_id: 'identity-test'
    }
  });

  assert.equal(response.result.structuredContent.ok, true);
  assert.equal(response.result.structuredContent.effective_agent_id, null);
  assert.equal(response.result.structuredContent.identity_warning, 'missing_agent_id');
  assert.match(response.result.structuredContent.identity_reason, /no agent_id/i);
  assert.match(response.result.structuredContent.identity_remediation, /Pass the correct agent_id/i);
  assert.equal(Object.hasOwn(response.result.structuredContent.payload, 'agent_id'), false);
  assert.equal(received.length, 1);
});

test('mcp face_say preserves optional synthesis and routing hints and rejects invalid types', async (t) => {
  const received = [];
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    staticDir: path.resolve(process.cwd(), 'face-app/public'),
    relayPayloads: false,
    onPayload(payload) {
      received.push(payload);
    },
    log: { info: () => {}, error: () => {} }
  });

  t.after(async () => {
    await server.stop();
  });

  const child = spawn('node', [path.resolve(process.cwd(), 'mcp-server/dist/index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FACE_WS_URL: server.url,
      FACE_HTTP_BASE_URL: server.httpUrl,
      MH_FACE_AGENT_ID: '__operator__'
    }
  });
  t.after(async () => {
    await stopChild(child);
  });
  const rpc = createJsonLineRpc(child);

  const response = await rpc.call('tools/call', {
    name: 'face.say',
    arguments: {
      text: 'Buenos días.',
      language: 'es-ES',
      speaker: 'F2',
      audio_endpoint: 'atom'
    }
  });
  assert.equal(response.result.structuredContent.ok, true);
  assert.equal(response.result.structuredContent.payload.language, 'es-ES');
  assert.equal(response.result.structuredContent.payload.speaker, 'F2');
  assert.equal(response.result.structuredContent.payload.audio_endpoint, 'atom');
  assert.equal(received.at(-1)?.language, 'es-ES');
  assert.equal(received.at(-1)?.speaker, 'F2');
  assert.equal(received.at(-1)?.audio_endpoint, 'atom');

  const invalid = await rpc.call('tools/call', {
    name: 'face.say',
    arguments: {
      text: 'Invalid language',
      language: 42
    }
  });
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /language must be a string/i);
  assert.equal(received.length, 1);

  const invalidEndpoint = await rpc.call('tools/call', {
    name: 'face.say',
    arguments: {
      text: 'Invalid endpoint',
      audio_endpoint: 'speaker'
    }
  });
  assert.equal(invalidEndpoint.result.isError, true);
  assert.match(invalidEndpoint.result.content[0].text, /audio_endpoint must be/i);
  assert.equal(received.length, 1);
});
