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

test('mcp owner inbox tools call the face-app HTTP API', async () => {
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

      if (request.url?.startsWith('/api/owner-inbox/report')) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          result: {
            transport_state: 'accepted',
            report: {
              stream_id: 'operator-default',
              report_id: 'rpt-1',
              lifecycle_state: 'delivered_to_inbox'
            }
          }
        }));
        return;
      }

      if (request.url?.startsWith('/api/owner-inbox/list')) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          state: {
            reports: [],
            summary: {
              unresolved_count: 1,
              by_agent_id: {}
            }
          }
        }));
        return;
      }

      if (request.url?.startsWith('/api/owner-inbox/resolve')) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          result: {
            report: {
              stream_id: 'operator-default',
              report_id: 'rpt-1',
              lifecycle_state: 'resolved'
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
    const reportResponse = await rpc.call('tools/call', {
      name: 'agent.report',
      arguments: {
        stream_id: 'operator-default',
        mission_id: 'helper-a',
        owner_agent_id: '__operator__',
        from_agent_id: 'helper-a',
        kind: 'blocked',
        summary: 'Need approval',
        report_id: 'rpt-1'
      }
    });
    assert.equal(reportResponse.result.isError, undefined);
    assert.match(reportResponse.result.content[0].text, /transport=accepted/);

    const listResponse = await rpc.call('tools/call', {
      name: 'owner.inbox.list',
      arguments: {
        owner_agent_id: '__operator__'
      }
    });
    assert.match(listResponse.result.content[0].text, /unresolved=1/);

    const resolveResponse = await rpc.call('tools/call', {
      name: 'owner.inbox.resolve',
      arguments: {
        stream_id: 'operator-default',
        report_id: 'rpt-1'
      }
    });
    assert.match(resolveResponse.result.content[0].text, /state=resolved/);

    assert.equal(requests.some((item) => item.url?.startsWith('/api/owner-inbox/report')), true);
    assert.equal(requests.some((item) => item.url?.startsWith('/api/owner-inbox/list')), true);
    assert.equal(requests.some((item) => item.url?.startsWith('/api/owner-inbox/resolve')), true);
  } finally {
    await stopChild(child);
    await new Promise((resolve) => server.close(resolve));
  }
});
