import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import * as protocol from '../../scripts/atoms3r_bridge_protocol.mjs';
import { createAtomDiscoveryRecovery } from '../../scripts/atoms3r_discovery_recovery.mjs';

// Evaluate the real bridge with every I/O boundary replaced. In particular,
// importing the executable directly would read user credentials and start WS.
const source = (await readFile(new URL('../../scripts/atoms3r-http-bridge.mjs', import.meta.url), 'utf8'))
  .replace(/^#!.*\n/u, '')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '')
  .replaceAll('import.meta.url', 'bridgeModuleUrl');
const HEALTH = { ok: true, service: 'atoms3r-headroom', device_id: 'atom-headroom-1', speaker_volume: 112 };

async function fixture({ discovery = true } = {}) {
  let at = 0, online = false, moved = false;
  const calls = [], timers = [], sockets = [];
  class Clock extends Date { static now() { return at; } }
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.listeners = {}; sockets.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    send() {} close() { this.readyState = 3; }
  }
  const context = vm.createContext({
    ...protocol,
    createAtomDiscoveryRecovery: options => createAtomDiscoveryRecovery({ ...options, now: () => at }),
    bridgeModuleUrl: new URL('../../scripts/atoms3r-http-bridge.mjs', import.meta.url).href,
    readFileSync() { throw Error('No real filesystem access in bridge fixture'); }, join,
    networkInterfaces: () => ({ test: [{ family: 'IPv4', internal: false, address: '192.0.2.10' }] }),
    process: { env: { ATOM_HEADROOM_URL: 'http://atom.invalid', MH_FACE_AUTH_TOKEN: 'mock',
      ATOM_HEADROOM_AUTH_TOKEN: 'mock', ATOM_HEADROOM_DISCOVERY: discovery ? '1' : '0' },
      cwd: () => '/mock-bridge-root', on() {}, exit() { throw Error('unexpected exit'); } },
    console: { log() {}, error() {} }, WebSocket: Socket,
    Date: Clock, performance: { now: () => at },
    URL, Buffer, ArrayBuffer, AbortSignal: { timeout: ms => ({ timeoutMs: ms }) },
    setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearInterval() {}, setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    fetch: async (url, options = {}) => {
      const u = new URL(url); calls.push({ host: u.hostname, path: u.pathname, method: options.method || 'GET' });
      const available = online && u.hostname === (moved ? '192.0.2.42' : 'atom.invalid');
      if (!available) throw Error('mock offline');
      return { ok: true, status: 200, json: async () => HEALTH, text: async () => JSON.stringify({ ok: true, speaker_volume: 112 }) };
    }
  });
  await vm.runInContext(`(async () => {\n${source}\n globalThis.bridge = {
    handleWsMessage, publishAtomEndpointState, recoverAtomAfterPostFailure, ensureAtomReachable,
    postPayloadWithDiscovery, postAudioWithDiscovery, postVolumeWithDiscovery
  }; })()`, context);
  return {
    bridge: context.bridge, calls, timers, sockets,
    advance(ms) { at += ms; }, online(value = true) { online = value; }, moved() { moved = true; online = true; },
    get scans() { return calls.filter(c => c.host === '192.0.2.1').length; }
  };
}

test('real bridge shares startup/heartbeat/mouth/audio recovery without real network', async () => {
  const f = await fixture();
  assert.equal(f.scans, 1);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.timers.length, 1, 'only the existing heartbeat, no retry-loop timers');
  const calls = f.calls.length;
  for (let i = 0; i < 100; i++) {
    await f.bridge.recoverAtomAfterPostFailure(Error('mock offline'), 'tts_mouth');
  }
  await Promise.all([
    f.bridge.publishAtomEndpointState('websocket_open'),
    f.bridge.recoverAtomAfterPostFailure(Error('mock offline'), 'tts_audio')
  ]);
  assert.equal(f.calls.length, calls);
  f.advance(30_000);
  await Promise.all([
    f.bridge.publishAtomEndpointState('heartbeat'),
    f.bridge.recoverAtomAfterPostFailure(Error('mock offline'), 'tts_mouth'),
    f.bridge.recoverAtomAfterPostFailure(Error('mock offline'), 'tts_audio')
  ]);
  assert.equal(f.scans, 2);
});

test('real heartbeat recovers a returning endpoint and reconnect does not start another sweep', async () => {
  const f = await fixture();
  f.online(); f.advance(5_000);
  await f.bridge.publishAtomEndpointState('heartbeat');
  await f.bridge.postPayloadWithDiscovery('{}', 'tts_mouth', 2);
  await f.sockets[0].listeners.open();
  await Promise.resolve();
  assert.equal(f.scans, 1);
  assert.ok(f.calls.some(c => c.path === '/api/headroom/payload'));
});

test('real explicit volume recovery finds a changed IP during automatic cooldown', async () => {
  const f = await fixture();
  f.moved();
  await f.bridge.postVolumeWithDiscovery(112);
  assert.equal(f.scans, 2);
  assert.ok(f.calls.some(c => c.host === '192.0.2.42' && c.path === '/api/headroom/volume'));
});

test('automatic heartbeat discovers a changed IP at the next eligible sweep', async () => {
  const f = await fixture();
  f.moved(); f.advance(30_000);
  await f.bridge.publishAtomEndpointState('heartbeat');
  await f.bridge.postAudioWithDiscovery(Buffer.from('fake audio'), {});
  assert.equal(f.scans, 2);
  assert.ok(f.calls.some(c => c.host === '192.0.2.42' && c.path === '/api/headroom/audio'));
});

test('disabled discovery and authentication failures never request a subnet sweep', async () => {
  const off = await fixture({ discovery: false });
  off.advance(300_000);
  await off.bridge.publishAtomEndpointState('heartbeat');
  await off.bridge.recoverAtomAfterPostFailure(Error('mock offline'), 'tts_mouth');
  assert.equal(off.scans, 0);
  const f = await fixture();
  f.advance(300_000);
  for (const status of [400, 401, 403, 429]) {
    assert.equal(await f.bridge.recoverAtomAfterPostFailure(Object.assign(Error('mock'), { status }), 'tts_mouth'), false);
  }
  assert.equal(f.scans, 1);
});
