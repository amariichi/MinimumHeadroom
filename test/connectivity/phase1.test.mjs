import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startFaceWebSocketServer } from '../../face-app/dist/ws_server.js';
import { createFramedMessageParser, writeFramedMessage } from '../../mcp-server/dist/mcp_stdio.js';

class McpStdioClient {
  constructor(childProcess) {
    this.childProcess = childProcess;
    this.nextId = 1;
    this.pending = new Map();

    const parse = createFramedMessageParser((message) => {
      if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
        return;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'Unknown JSON-RPC error'));
        return;
      }

      pending.resolve(message.result);
    });

    this.childProcess.stdout.on('data', (chunk) => {
      parse(chunk);
    });
  }

  request(method, params = {}, timeoutMs = 3000) {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for JSON-RPC response: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      writeFramedMessage(this.childProcess.stdin, {
        jsonrpc: '2.0',
        id,
        method,
        params
      });
    });
  }

  notify(method, params = {}) {
    writeFramedMessage(this.childProcess.stdin, {
      jsonrpc: '2.0',
      method,
      params
    });
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('MCP client closed before response'));
    }
    this.pending.clear();
    this.childProcess.stdin.end();
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for condition: ${label}`);
}

async function stopChildProcess(childProcess) {
  if (childProcess.exitCode !== null) {
    return;
  }

  childProcess.kill('SIGTERM');
  const exitPromise = once(childProcess, 'exit');
  const timeoutPromise = delay(1000).then(() => {
    if (childProcess.exitCode === null) {
      childProcess.kill('SIGKILL');
    }
  });
  await Promise.race([exitPromise, timeoutPromise]);
}

test('phase1 connectivity forwards face.event and face.say to face-app', async (t) => {
  const receivedPayloads = [];
  const silentLog = { info: () => {}, error: () => {} };
  const faceServer = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    onPayload(payload) {
      receivedPayloads.push(payload);
    },
    log: silentLog
  });
  t.after(async () => {
    await faceServer.stop();
  });

  const childProcess = spawn(process.execPath, ['mcp-server/dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FACE_WS_URL: faceServer.url
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stderrLog = '';
  childProcess.stderr.on('data', (chunk) => {
    stderrLog += chunk.toString('utf8');
  });

  t.after(async () => {
    await stopChildProcess(childProcess);
  });

  const client = new McpStdioClient(childProcess);
  t.after(() => {
    client.close();
  });

  const initializeResult = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'phase1-test', version: '0.0.0' }
  });
  assert.equal(initializeResult.protocolVersion, '2024-11-05');
  assert.equal(initializeResult.serverInfo.name, 'minimum-headroom');

  client.notify('notifications/initialized', {});

  const toolListResult = await client.request('tools/list', {});
  const toolNames = toolListResult.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes('face.event'));
  assert.ok(toolNames.includes('face.say'));
  assert.ok(toolNames.includes('face.ping'));

  const eventCallResult = await client.request('tools/call', {
    name: 'face.event',
    arguments: {
      session_id: 'phase1#test',
      name: 'cmd_started',
      severity: 0.3
    }
  });
  assert.equal(eventCallResult.isError, undefined);

  await waitFor(() => receivedPayloads.some((payload) => payload.type === 'event'), 3000, 'event payload');
  const eventPayload = receivedPayloads.find((payload) => payload.type === 'event');
  assert.equal(eventPayload.v, 1);
  assert.equal(eventPayload.session_id, 'phase1#test');
  assert.equal(eventPayload.name, 'cmd_started');
  assert.equal(typeof eventPayload.ts, 'number');

  const sayCallResult = await client.request('tools/call', {
    name: 'face.say',
    arguments: {
      session_id: 'phase1#test',
      text: 'できた！',
      language: 'en',
      priority: 2,
      policy: 'replace'
    }
  });
  assert.equal(sayCallResult.isError, undefined);

  await waitFor(() => receivedPayloads.some((payload) => payload.type === 'say'), 3000, 'say payload');
  const sayPayload = receivedPayloads.find((payload) => payload.type === 'say');
  assert.equal(sayPayload.v, 1);
  assert.equal(sayPayload.session_id, 'phase1#test');
  assert.equal(sayPayload.text, 'できた！');
  assert.equal(sayPayload.language, 'en');
  assert.equal(typeof sayPayload.utterance_id, 'string');

  const invalidCallResult = await client.request('tools/call', {
    name: 'face.event',
    arguments: {
      name: 'cmd_started'
    }
  });
  assert.equal(invalidCallResult.isError, true);
  assert.match(invalidCallResult.content[0].text, /session_id/);

  assert.match(stderrLog, /ready; forwarding to/);
});
