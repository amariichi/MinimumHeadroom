import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';

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
        }, 3000);
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

test('mcp vision tools read situation and fresh look from vision-worker host side', async (t) => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });

    if (request.method === 'GET' && request.url === '/situation?format=text') {
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'x-situation-watermark': 'wm-1'
      });
      response.end('[カメラの状況 12:34] 観測中\n現在:\n机の上にマグカップがある。');
      return;
    }

    if (request.method === 'POST' && request.url === '/look?store=0') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({
        frame_id: 42,
        overview: '机の上のマグカップが近くに見える。',
        change_from_prev: 'ヘッドホンからマグカップに視点が移った。'
      }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1');
    server.on('listening', resolve);
    server.on('error', reject);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  const child = spawn('node', [path.resolve(process.cwd(), 'mcp-server/dist/index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FACE_WS_URL: 'ws://127.0.0.1:65535/ws',
      VISION_BASE_URL: `http://127.0.0.1:${port}`,
      MCP_TOOL_NAME_STYLE: 'underscore'
    }
  });
  t.after(async () => {
    await stopChild(child);
  });
  const rpc = createJsonLineRpc(child);

  const toolsResponse = await rpc.call('tools/list', {});
  const toolNames = toolsResponse.result.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes('vision_situation'));
  assert.ok(toolNames.includes('vision_look'));

  const situationResponse = await rpc.call('tools/call', {
    name: 'vision_situation',
    arguments: {}
  });
  assert.equal(situationResponse.result.isError, undefined);
  assert.match(situationResponse.result.content[0].text, /マグカップ/);
  assert.equal(situationResponse.result.structuredContent.ok, true);
  assert.equal(situationResponse.result.structuredContent.watermark, 'wm-1');

  const lookResponse = await rpc.call('tools/call', {
    name: 'vision_look',
    arguments: {
      store: false
    }
  });
  assert.equal(lookResponse.result.isError, undefined);
  assert.match(lookResponse.result.content[0].text, /現在.*マグカップ/);
  assert.match(lookResponse.result.content[0].text, /直前との差/);
  assert.equal(lookResponse.result.structuredContent.store, false);

  assert.deepEqual(requests.map((item) => `${item.method} ${item.url}`), [
    'GET /situation?format=text',
    'POST /look?store=0'
  ]);
});
