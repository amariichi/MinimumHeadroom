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

test('mcp agent lifecycle tools call the face-app HTTP API', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let rawBody = '';
    request.on('data', (chunk) => {
      rawBody += chunk.toString('utf8');
    });
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url,
        body: rawBody === '' ? null : JSON.parse(rawBody)
      });

      if (request.url?.startsWith('/api/agents?')) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          active_stream_id: 'repo:/tmp/target',
          active_target_repo_root: '/tmp/target',
          agents: [{ id: 'helper-a', session_id: 'helper-a', slot: 0, status: 'active' }]
        }));
        return;
      }

      if (request.url === '/api/agents/add') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          result: {
            action: 'add',
            agent: {
              id: 'helper-a',
              session_id: 'helper-a',
              source_repo_path: '/tmp/target',
              target_repo_root: '/tmp/target',
              stream_id: 'repo:/tmp/target'
            }
          }
        }));
        return;
      }

      if (request.url === '/api/agents/helper-a/focus') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          result: {
            action: 'focus',
            focus: {
              pane_id: '%42',
              session_id: 'default'
            }
          }
        }));
        return;
      }

      if (request.url === '/api/agents/helper-a/delete') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          result: {
            action: 'delete',
            agent: {
              id: 'helper-a'
            }
          }
        }));
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1');
    server.on('listening', resolve);
    server.on('error', reject);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  const child = spawn('node', [path.resolve(process.cwd(), 'mcp-server/dist/index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FACE_HTTP_BASE_URL: `http://127.0.0.1:${port}`,
      FACE_WS_URL: 'ws://127.0.0.1:65535/ws'
    }
  });
  const rpc = createJsonLineRpc(child);

  try {
    const listResponse = await rpc.call('tools/call', {
      name: 'agent.list',
      arguments: {
        scope: 'all'
      }
    });
    assert.match(listResponse.result.content[0].text, /count=1/);

    const streamAliasResponse = await rpc.call('tools/call', {
      name: 'agent.list',
      arguments: {
        scope: 'stream'
      }
    });
    assert.match(streamAliasResponse.result.content[0].text, /count=1/);

    const spawnResponse = await rpc.call('tools/call', {
      name: 'agent.spawn',
      arguments: {
        id: 'helper-a',
        source_repo_path: '/tmp/target',
        target_repo_root: '/tmp/target',
        create_worktree: false,
        create_tmux: false
      }
    });
    assert.match(spawnResponse.result.content[0].text, /spawned agent id=helper-a/);
    const spawnRequest = requests.find((item) => item.url === '/api/agents/add' && item.body?.id === 'helper-a');
    assert.equal(spawnRequest?.body?.id, 'helper-a');

    const aliasSpawnResponse = await rpc.call('tools/call', {
      name: 'agent.spawn',
      arguments: {
        agent_id: 'helper-b',
        source_repo_path: '/tmp/target',
        target_repo_root: '/tmp/target',
        create_worktree: false,
        create_tmux: false
      }
    });
    assert.match(aliasSpawnResponse.result.content[0].text, /spawned agent id=helper-a/);
    const aliasSpawnRequest = requests.find((item) => item.url === '/api/agents/add' && item.body?.id === 'helper-b');
    assert.equal(aliasSpawnRequest?.body?.id, 'helper-b');

    const focusResponse = await rpc.call('tools/call', {
      name: 'agent.focus',
      arguments: {
        agent_id: 'helper-a',
        session_id: 'default'
      }
    });
    assert.match(focusResponse.result.content[0].text, /focused agent id=helper-a pane=%42/);

    const deleteResponse = await rpc.call('tools/call', {
      name: 'agent.delete',
      arguments: {
        agent_id: 'helper-a'
      }
    });
    assert.match(deleteResponse.result.content[0].text, /deleted agent id=helper-a/);

    assert.equal(requests.some((item) => item.url?.startsWith('/api/agents?')), true);
    assert.equal(requests.some((item) => item.url === '/api/agents?scope=active'), true);
    assert.equal(requests.some((item) => item.url === '/api/agents/add'), true);
    assert.equal(requests.some((item) => item.url === '/api/agents/helper-a/focus'), true);
    assert.equal(requests.some((item) => item.url === '/api/agents/helper-a/delete'), true);
  } finally {
    await stopChild(child);
    await new Promise((resolve) => server.close(resolve));
  }
});
