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
  const correctionTexts = [];
  let startCalls = 0;
  let narrateState = false;
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });

    if (request.method === 'POST' && request.url === '/perception/start') {
      startCalls += 1;
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      if (startCalls === 1) {
        response.end(JSON.stringify({ started: false, can_start: false, reason: 'needs_model_start', disclaimer: 'ambient only' }));
      } else {
        response.end(JSON.stringify({ started: true, reason: 'ok' }));
      }
      return;
    }

    if (request.method === 'POST' && request.url === '/perception/stop') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ running: false }));
      return;
    }

    if (request.method === 'GET' && request.url === '/perception/status') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ running: true, narrate: narrateState, capability: 'running', voice_wired: true }));
      return;
    }

    if (request.method === 'POST' && request.url === '/perception/narrate') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body);
        narrateState = parsed.on === true;
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ narrate: narrateState, voice_wired: true, disclaimer: 'ambient only' }));
      });
      return;
    }

    if (request.method === 'GET' && request.url === '/situation?format=text') {
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'x-situation-watermark': 'wm-1'
      });
      response.end('[カメラの状況 12:34] 観測中\n現在:\n机の上にマグカップがある。');
      return;
    }

    if (request.method === 'POST' && request.url === '/correction') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body);
        if (parsed.text === 'trigger-409') {
          response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ detail: 'no live scene to attach a correction to' }));
          return;
        }
        correctionTexts.push(parsed.text);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true, correction: { id: 1, text: parsed.text } }));
      });
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
  assert.ok(toolNames.includes('vision_correct'));
  assert.ok(toolNames.includes('vision_watch'));
  assert.ok(toolNames.includes('vision_narrate'));

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

  const correctResponse = await rpc.call('tools/call', {
    name: 'vision_correct',
    arguments: {
      text: 'ノートパソコンは存在しない'
    }
  });
  assert.equal(correctResponse.result.isError, undefined);
  assert.match(correctResponse.result.content[0].text, /訂正を記録/);
  assert.match(correctResponse.result.content[0].text, /ノートパソコンは存在しない/);
  assert.equal(correctResponse.result.structuredContent.ok, true);

  const rejected = await rpc.call('tools/call', {
    name: 'vision_correct',
    arguments: {
      text: 'trigger-409'
    }
  });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /まだ観測がない/);

  const refusedStart = await rpc.call('tools/call', {
    name: 'vision_watch',
    arguments: { action: 'start' }
  });
  assert.equal(refusedStart.result.isError, undefined);
  assert.match(refusedStart.result.content[0].text, /開始できません/);
  assert.match(refusedStart.result.content[0].text, /needs_model_start/);
  assert.equal(refusedStart.result.structuredContent.payload.started, false);

  const startedWatch = await rpc.call('tools/call', {
    name: 'vision_watch',
    arguments: { action: 'start' }
  });
  assert.equal(startedWatch.result.isError, undefined);
  assert.match(startedWatch.result.content[0].text, /開始しました/);
  assert.equal(startedWatch.result.structuredContent.payload.started, true);

  const watchStatus = await rpc.call('tools/call', {
    name: 'vision_watch',
    arguments: { action: 'status' }
  });
  assert.equal(watchStatus.result.isError, undefined);
  assert.match(watchStatus.result.content[0].text, /動作中/);
  assert.match(watchStatus.result.content[0].text, /実況OFF/);

  const narrateOn = await rpc.call('tools/call', {
    name: 'vision_narrate',
    arguments: { on: true }
  });
  assert.equal(narrateOn.result.isError, undefined);
  assert.match(narrateOn.result.content[0].text, /ONにしました/);
  assert.equal(narrateOn.result.structuredContent.on, true);
  assert.equal(narrateOn.result.structuredContent.running, true);
  assert.ok(!/注意/.test(narrateOn.result.content[0].text));

  const narrateOff = await rpc.call('tools/call', {
    name: 'vision_narrate',
    arguments: { on: false }
  });
  assert.equal(narrateOff.result.isError, undefined);
  assert.match(narrateOff.result.content[0].text, /OFFにしました/);
  assert.match(narrateOff.result.content[0].text, /vision\.watch/);

  const stoppedWatch = await rpc.call('tools/call', {
    name: 'vision_watch',
    arguments: { action: 'stop' }
  });
  assert.equal(stoppedWatch.result.isError, undefined);
  assert.match(stoppedWatch.result.content[0].text, /停止しました/);

  assert.deepEqual(requests.map((item) => `${item.method} ${item.url}`), [
    'GET /situation?format=text',
    'POST /look?store=0',
    'POST /correction',
    'POST /correction',
    'POST /perception/start',
    'POST /perception/start',
    'GET /perception/status',
    'POST /perception/narrate',
    'GET /perception/status',
    'POST /perception/narrate',
    'GET /perception/status',
    'POST /perception/stop'
  ]);
  assert.deepEqual(correctionTexts, ['ノートパソコンは存在しない']);
});
