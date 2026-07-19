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
      if (newline === -1) break;
      const line = buffer.subarray(0, newline).toString('utf8').trim();
      buffer = buffer.subarray(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      }
    }
  });
  child.stderr.resume();
  return {
    call(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP response timeout')), 2000);
        waiters.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    }
  };
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolve();
    }, 1200);
  });
}

test('mcp generic media tools call the authenticated face-app API without reflecting upstream URLs', async () => {
  const requests = [];
  let active = false;
  const server = http.createServer((request, response) => {
    let rawBody = '';
    request.on('data', (chunk) => {
      rawBody += chunk.toString('utf8');
    });
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: rawBody ? JSON.parse(rawBody) : null
      });
      if (request.url === '/api/media/play') active = true;
      if (request.url === '/api/media/stop') active = false;
      if (request.url?.startsWith('/api/media/')) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          v: 1,
          type: 'media_state',
          state: active ? 'active' : 'idle',
          revision: requests.length,
          media_id: active ? 'private:track' : null,
          title: active ? 'Private Track' : null,
          subtitle: active ? 'Private Source' : null,
          stream_url: active ? '/api/media/stream/opaque' : null,
          mime_type: active ? 'audio/mpeg' : null,
          bitrate: 128000,
          error: null
        }));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1');
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const child = spawn('node', [path.resolve(process.cwd(), 'mcp-server/dist/index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FACE_HTTP_BASE_URL: 'http://127.0.0.1:' + port,
      FACE_WS_URL: 'ws://127.0.0.1:65535/ws',
      MH_FACE_AUTH_TOKEN: 'test-token',
      MCP_TOOL_NAME_STYLE: 'underscore'
    }
  });
  const rpc = createJsonLineRpc(child);
  const upstreamUrl = 'http://127.0.0.1:5173/api/player/audio.mp3?generation=7';

  try {
    const tools = await rpc.call('tools/list', {});
    const names = tools.result.tools.map((tool) => tool.name);
    assert.ok(names.includes('media_play'));
    assert.ok(names.includes('media_stop'));
    assert.ok(names.includes('media_status'));

    const play = await rpc.call('tools/call', {
      name: 'media.play',
      arguments: {
        upstream_url: upstreamUrl,
        media_id: 'private:track',
        title: 'Private Track',
        subtitle: 'Private Source'
      }
    });
    assert.equal(play.result.isError, undefined);
    assert.match(play.result.content[0].text, /playing media_id=private:track/);
    assert.equal(JSON.stringify(play.result).includes(upstreamUrl), false);

    const rejectedPolicyOverride = await rpc.call('tools/call', {
      name: 'media_status',
      arguments: { mode: 'pcm' }
    });
    assert.equal(rejectedPolicyOverride.result.isError, true);
    assert.match(rejectedPolicyOverride.result.content[0].text, /does not accept field: mode/);

    const status = await rpc.call('tools/call', {
      name: 'media_status',
      arguments: {}
    });
    assert.match(status.result.content[0].text, /state=active/);

    const stop = await rpc.call('tools/call', {
      name: 'media_stop',
      arguments: {}
    });
    assert.match(stop.result.content[0].text, /stopped shared media/);

    assert.deepEqual(requests.map((item) => item.url), [
      '/api/media/play',
      '/api/media/status',
      '/api/media/stop'
    ]);
    assert.equal(requests[0].authorization, 'Bearer test-token');
    assert.equal(requests[0].body.upstream_url, upstreamUrl);
  } finally {
    await stopChild(child);
    await new Promise((resolve) => server.close(resolve));
  }
});
