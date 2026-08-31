import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

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
        waiter.resolve(message);
      }
    }
  });
  child.stderr.resume();

  return {
    call(method, params) {
      const id = nextId++;
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
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
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
    child.once('exit', resolve);
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolve();
    }, 1200);
  });
}

test('mcp Atom volume tools target face and M12 safely through the authenticated Face App API', async (t) => {
  const requests = [];
  const volumes = {
    'face-test': 111,
    'm12-test': 200
  };
  let includeM12 = true;
  let m12VolumeControl = true;

  const server = http.createServer((request, response) => {
    let rawBody = '';
    request.on('data', (chunk) => {
      rawBody += chunk.toString('utf8');
    });
    request.on('end', () => {
      const body = rawBody ? JSON.parse(rawBody) : null;
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body
      });

      if (request.method === 'GET' && request.url === '/api/atom/volume') {
        const devices = [
          {
            deviceId: 'face-test',
            source: 'direct',
            speakerVolume: volumes['face-test'],
            volumeControl: true
          }
        ];
        if (includeM12) {
          devices.unshift({
            deviceId: 'm12-test',
            source: 'direct',
            speakerVolume: m12VolumeControl ? volumes['m12-test'] : null,
            volumeControl: m12VolumeControl
          });
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          connected: devices.length > 0,
          endpoint: devices.length > 0 ? 'atom' : 'browser',
          devices
        }));
        return;
      }

      if (request.method === 'POST' && request.url === '/api/atom/volume') {
        if (!Object.hasOwn(volumes, body?.deviceId)) {
          response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ ok: false, error: 'atom_not_connected' }));
          return;
        }
        volumes[body.deviceId] = body.volume;
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({
          ok: true,
          deviceId: body.deviceId,
          speakerVolume: body.volume,
          persistent: false
        }));
        return;
      }

      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, error: 'not_found' }));
    });
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1');
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const port = server.address().port;
  const child = spawn('node', [path.resolve(process.cwd(), 'mcp-server/dist/index.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FACE_HTTP_BASE_URL: `http://127.0.0.1:${port}`,
      FACE_WS_URL: 'ws://127.0.0.1:65535/ws',
      MH_FACE_AUTH_TOKEN: 'test-token',
      ATOM_HEADROOM_DEVICE_ID: 'face-test',
      MH_M12_DEVICE_ID: 'm12-test',
      MCP_TOOL_NAME_STYLE: 'underscore'
    }
  });
  t.after(async () => {
    await stopChild(child);
  });
  const rpc = createJsonLineRpc(child);

  const toolsResponse = await rpc.call('tools/list', {});
  const toolsByName = new Map(toolsResponse.result.tools.map((tool) => [tool.name, tool]));
  assert.ok(toolsByName.has('atom_volume_get'));
  assert.ok(toolsByName.has('atom_volume_set'));
  assert.ok(toolsByName.has('atom_volume_adjust'));
  assert.deepEqual(toolsByName.get('atom_volume_get').inputSchema.required, ['target']);
  assert.deepEqual(toolsByName.get('atom_volume_set').inputSchema.required, ['target', 'volume_percent']);
  assert.equal(toolsByName.get('atom_volume_set').inputSchema.additionalProperties, false);
  assert.equal(
    toolsByName.get('atom_volume_adjust').inputSchema.properties.percentage_points.default,
    5
  );

  const faceStatus = await rpc.call('tools/call', {
    name: 'atom_volume_get',
    arguments: { target: 'face' }
  });
  assert.equal(faceStatus.result.isError, undefined);
  assert.match(faceStatus.result.content[0].text, /face Atom speaker volume=56% \(raw 111/);
  assert.deepEqual(faceStatus.result.structuredContent, {
    ok: true,
    target: 'face',
    device_id: 'face-test',
    volume_percent: 56,
    raw_volume: 111,
    persistent: false,
    source: 'direct',
    http: `http://127.0.0.1:${port}/api/atom/volume`
  });

  const m12Status = await rpc.call('tools/call', {
    name: 'atom.volume.get',
    arguments: { target: 'm12' }
  });
  assert.equal(m12Status.result.structuredContent.device_id, 'm12-test');
  assert.equal(m12Status.result.structuredContent.volume_percent, 100);
  assert.equal(m12Status.result.structuredContent.raw_volume, 200);

  const raiseOddFace = await rpc.call('tools/call', {
    name: 'atom_volume_adjust',
    arguments: { target: 'face', direction: 'up' }
  });
  assert.equal(raiseOddFace.result.isError, undefined);
  assert.equal(raiseOddFace.result.structuredContent.percentage_points, 5);
  assert.equal(raiseOddFace.result.structuredContent.previous_volume_percent, 56);
  assert.equal(raiseOddFace.result.structuredContent.volume_percent, 61);
  assert.equal(raiseOddFace.result.structuredContent.previous_raw_volume, 111);
  assert.equal(raiseOddFace.result.structuredContent.raw_volume, 122);

  volumes['face-test'] = 111;

  const setFace = await rpc.call('tools/call', {
    name: 'atom_volume_set',
    arguments: { target: 'face', volume_percent: 60 }
  });
  assert.equal(setFace.result.isError, undefined);
  assert.match(setFace.result.content[0].text, /56% -> 60% \(raw 111 -> 120\)/);
  assert.equal(setFace.result.structuredContent.requested_volume_percent, 60);
  assert.equal(setFace.result.structuredContent.previous_volume_percent, 56);
  assert.equal(setFace.result.structuredContent.volume_percent, 60);
  assert.equal(setFace.result.structuredContent.previous_raw_volume, 111);
  assert.equal(setFace.result.structuredContent.raw_volume, 120);
  assert.equal(setFace.result.structuredContent.persistent, false);
  assert.equal(setFace.result.structuredContent.unchanged, false);

  const lowerM12 = await rpc.call('tools/call', {
    name: 'atom_volume_adjust',
    arguments: { target: 'm12', direction: 'down' }
  });
  assert.equal(lowerM12.result.isError, undefined);
  assert.equal(lowerM12.result.structuredContent.percentage_points, 5);
  assert.equal(lowerM12.result.structuredContent.previous_volume_percent, 100);
  assert.equal(lowerM12.result.structuredContent.volume_percent, 95);
  assert.equal(lowerM12.result.structuredContent.previous_raw_volume, 200);
  assert.equal(lowerM12.result.structuredContent.raw_volume, 190);
  assert.equal(lowerM12.result.structuredContent.clamped, false);

  volumes['m12-test'] = 200;
  const postsBeforeClamp = requests.filter((item) => item.method === 'POST').length;
  const upperBoundary = await rpc.call('tools/call', {
    name: 'atom_volume_adjust',
    arguments: { target: 'm12', direction: 'up' }
  });
  assert.equal(upperBoundary.result.isError, undefined);
  assert.equal(upperBoundary.result.structuredContent.volume_percent, 100);
  assert.equal(upperBoundary.result.structuredContent.raw_volume, 200);
  assert.equal(upperBoundary.result.structuredContent.clamped, true);
  assert.equal(upperBoundary.result.structuredContent.unchanged, true);
  assert.equal(upperBoundary.result.structuredContent.set_http, null);
  assert.equal(requests.filter((item) => item.method === 'POST').length, postsBeforeClamp);

  const requestsBeforeValidation = requests.length;
  const invalidTarget = await rpc.call('tools/call', {
    name: 'atom_volume_get',
    arguments: { target: 'speaker' }
  });
  assert.equal(invalidTarget.result.isError, true);
  assert.equal(invalidTarget.result.structuredContent.reason, 'invalid_arguments');
  assert.match(invalidTarget.result.content[0].text, /target must be one of/);

  const invalidAmount = await rpc.call('tools/call', {
    name: 'atom_volume_adjust',
    arguments: { target: 'face', direction: 'up', percentage_points: 0 }
  });
  assert.equal(invalidAmount.result.isError, true);
  assert.match(invalidAmount.result.content[0].text, /percentage_points must be an integer/);

  const unknownField = await rpc.call('tools/call', {
    name: 'atom_volume_set',
    arguments: { target: 'face', volume_percent: 60, volume: 120 }
  });
  assert.equal(unknownField.result.isError, true);
  assert.match(unknownField.result.content[0].text, /unsupported atom\.volume\.set field: volume/);

  const legacyAmount = await rpc.call('tools/call', {
    name: 'atom_volume_adjust',
    arguments: { target: 'face', direction: 'up', amount: 5 }
  });
  assert.equal(legacyAmount.result.isError, true);
  assert.match(legacyAmount.result.content[0].text, /unsupported atom\.volume\.adjust field: amount/);
  assert.equal(requests.length, requestsBeforeValidation);

  includeM12 = false;
  const missingM12 = await rpc.call('tools/call', {
    name: 'atom_volume_get',
    arguments: { target: 'm12' }
  });
  assert.equal(missingM12.result.isError, true);
  assert.equal(missingM12.result.structuredContent.reason, 'atom_target_not_connected');
  assert.equal(missingM12.result.structuredContent.device_id, 'm12-test');
  assert.deepEqual(missingM12.result.structuredContent.connected_device_ids, ['face-test']);

  includeM12 = true;
  m12VolumeControl = false;
  const oldM12Firmware = await rpc.call('tools/call', {
    name: 'atom_volume_get',
    arguments: { target: 'm12' }
  });
  assert.equal(oldM12Firmware.result.isError, true);
  assert.equal(oldM12Firmware.result.structuredContent.reason, 'atom_volume_unavailable');
  assert.match(oldM12Firmware.result.content[0].text, /update its firmware/);

  const mutationRequests = requests.filter((item) => item.method === 'POST');
  assert.deepEqual(mutationRequests.map((item) => item.body), [
    { deviceId: 'face-test', volume: 122 },
    { deviceId: 'face-test', volume: 120 },
    { deviceId: 'm12-test', volume: 190 }
  ]);
  assert.ok(requests.length > 0);
  assert.ok(requests.every((item) => item.authorization === 'Bearer test-token'));
});
