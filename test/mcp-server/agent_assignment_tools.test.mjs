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

test('mcp agent assignment tools call the face-app HTTP API', async () => {
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

      if (request.url === '/api/agent-assignments/assign') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          result: {
            action: 'created',
            assignment: {
              stream_id: 'repo:/tmp/target',
              mission_id: 'mission-a',
              delivery_state: 'pending'
            }
          }
        }));
        return;
      }

      if (request.url?.startsWith('/api/agent-assignments/list')) {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          state: {
            assignments: [{ mission_id: 'mission-a', agent_id: 'helper-a', delivery_state: 'sent_to_tmux' }],
            summary: { count: 1 }
          }
        }));
        return;
      }

      if (request.url === '/api/agent-assignments/inject') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          result: {
            assignment: {
              stream_id: 'repo:/tmp/target',
              mission_id: 'mission-a',
              delivery_state: 'sent_to_tmux'
            },
            injection: {
              pane_id: '%42'
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
    const assignResponse = await rpc.call('tools/call', {
      name: 'agent.assign',
      arguments: {
        stream_id: 'repo:/tmp/target',
        mission_id: 'mission-a',
        owner_agent_id: '__operator__',
        agent_id: 'helper-a',
        goal: 'Implement the patch',
        target_paths: ['README.md'],
        completion_criteria: 'Return one finding or done.',
        timebox_minutes: 4,
        max_findings: 1
      }
    });
    assert.match(assignResponse.result.content[0].text, /stored assignment mission_id=mission-a/);

    const listResponse = await rpc.call('tools/call', {
      name: 'agent.assignment.list',
      arguments: {
        stream_id: 'repo:/tmp/target'
      }
    });
    assert.match(listResponse.result.content[0].text, /listed assignments count=1/);

    const injectResponse = await rpc.call('tools/call', {
      name: 'agent.inject',
      arguments: {
        agent_id: 'helper-a',
        mission_id: 'mission-a',
        stream_id: 'repo:/tmp/target',
        followup_mode: 'completion_rescue',
        probe_before_send: true,
        rescue_submit_if_buffered: true,
        rescue_submit_delay_ms: 180,
        probe_timeout_ms: 1200,
        probe_poll_ms: 50
      }
    });
    assert.match(injectResponse.result.content[0].text, /injected mission_id=mission-a delivery=sent_to_tmux/);

    assert.equal(requests.some((item) => item.url === '/api/agent-assignments/assign'), true);
    assert.equal(
      requests.some(
        (item) =>
          item.url === '/api/agent-assignments/assign' &&
          Array.isArray(item.body?.target_paths) &&
          item.body?.target_paths[0] === 'README.md' &&
          item.body?.timebox_minutes === 4 &&
          item.body?.max_findings === 1
      ),
      true
    );
    assert.equal(requests.some((item) => item.url?.startsWith('/api/agent-assignments/list')), true);
    assert.equal(requests.some((item) => item.url === '/api/agent-assignments/inject'), true);
    assert.equal(
      requests.some(
        (item) =>
          item.url === '/api/agent-assignments/inject' &&
          item.body?.followup_mode === 'completion_rescue' &&
          item.body?.probe_before_send === true &&
          item.body?.rescue_submit_if_buffered === true &&
          item.body?.rescue_submit_delay_ms === 180 &&
          item.body?.probe_timeout_ms === 1200 &&
          item.body?.probe_poll_ms === 50
      ),
      true
    );
  } finally {
    await stopChild(child);
    await new Promise((resolve) => server.close(resolve));
  }
});
