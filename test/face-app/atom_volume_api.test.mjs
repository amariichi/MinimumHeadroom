import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createAtomVolumeApi } from '../../face-app/dist/atom_volume_api.js';
import { InterpreterAtomVolumeError } from '../../face-app/dist/interpreter_atom_volume.js';

function request({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const bytes = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const stream = new Readable({
    read() {
      this.push(bytes);
      this.push(null);
    }
  });
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

function response() {
  let statusCode = null;
  let headers = null;
  let body = '';
  return {
    writeHead(code, nextHeaders) {
      statusCode = code;
      headers = nextHeaders;
    },
    end(chunk = '') {
      body += String(chunk);
    },
    result() {
      return {
        statusCode,
        headers,
        json: body ? JSON.parse(body) : null
      };
    }
  };
}

test('shared Atom volume API lists live devices and validates confirmed runtime changes', async () => {
  const calls = [];
  const devices = [
    {
      deviceId: 'face-one',
      source: 'direct',
      speakerVolume: 112,
      volumeControl: true
    },
    {
      deviceId: 'm12-one',
      source: 'direct',
      speakerVolume: 200,
      volumeControl: true
    }
  ];
  const api = createAtomVolumeApi({
    registry: {
      getPresence() {
        return { connected: true, endpoint: 'atom', devices };
      }
    },
    async setVolume(input) {
      calls.push(input);
      return {
        ok: true,
        deviceId: input.deviceId,
        speakerVolume: input.volume,
        persistent: false
      };
    },
    log: { warn() {} }
  });

  const unrelated = response();
  assert.equal(await api.handleHttpRequest(request({ url: '/api/other' }), unrelated), false);

  const listed = response();
  assert.equal(await api.handleHttpRequest(request({ url: '/api/atom/volume' }), listed), true);
  assert.equal(listed.result().statusCode, 200);
  assert.deepEqual(listed.result().json, {
    ok: true,
    connected: true,
    endpoint: 'atom',
    devices
  });

  const changed = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/atom/volume',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: { deviceId: 'm12-one', volume: 144 }
  }), changed);
  assert.equal(changed.result().statusCode, 200);
  assert.deepEqual(changed.result().json, {
    ok: true,
    deviceId: 'm12-one',
    speakerVolume: 144,
    persistent: false
  });
  assert.deepEqual(calls, [{ deviceId: 'm12-one', volume: 144 }]);

  const extraField = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/atom/volume',
    headers: { 'content-type': 'application/json' },
    body: { deviceId: 'face-one', volume: 120, persistent: true }
  }), extraField);
  assert.equal(extraField.result().statusCode, 400);
  assert.equal(extraField.result().json.error, 'invalid_atom_volume_request');
  assert.equal(calls.length, 1);
});

test('shared Atom volume API preserves controller error codes and status', async () => {
  const api = createAtomVolumeApi({
    registry: {
      getPresence() {
        return { connected: false, endpoint: 'browser', devices: [] };
      }
    },
    async setVolume() {
      throw new InterpreterAtomVolumeError('atom_not_connected', 409);
    },
    log: { warn() {} }
  });
  const failed = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/atom/volume',
    headers: { 'content-type': 'application/json' },
    body: { deviceId: 'face-one', volume: 120 }
  }), failed);
  assert.equal(failed.result().statusCode, 409);
  assert.deepEqual(failed.result().json, {
    ok: false,
    error: 'atom_not_connected'
  });
});
