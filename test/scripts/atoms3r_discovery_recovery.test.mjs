import assert from 'node:assert/strict';
import test from 'node:test';
import { createAtomDiscoveryRecovery } from '../../scripts/atoms3r_discovery_recovery.mjs';

const HEALTH = { ok: true, service: 'atoms3r-headroom' };
function fixture(overrides = {}) {
  let at = 0, probes = 0, scans = 0, online = false, found = false;
  const scanTimes = [];
  const recovery = createAtomDiscoveryRecovery({
    now: () => at,
    probe: async () => { probes++; return online ? HEALTH : null; },
    discover: async () => { scans++; scanTimes.push(at); return found ? HEALTH : null; },
    ...overrides
  });
  return {
    ...recovery, scanTimes,
    advance(ms) { at += ms; },
    online(value = true) { online = value; },
    found(value = true) { found = value; },
    get probes() { return probes; }, get scans() { return scans; }
  };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('lip-sync failures share negative health caching and exponential sweep cooldown', async () => {
  const f = fixture();
  await f.ensureReachable('startup');
  for (let i = 0; i < 1000; i++) await f.ensureReachable('post_failure:tts_mouth');
  assert.equal(f.probes, 1);
  assert.equal(f.scans, 1);
  f.advance(5_000);
  await f.ensureReachable('heartbeat');
  assert.equal(f.probes, 2);
  assert.equal(f.scans, 1);
  f.advance(25_000);
  await f.ensureReachable('post_failure:tts_mouth');
  f.advance(59_999);
  await f.ensureReachable('post_failure:tts_mouth');
  assert.equal(f.scans, 2);
  f.advance(5_000); // next permitted health check after the cached failure
  await f.ensureReachable('heartbeat');
  assert.equal(f.scans, 3);
});

test('a day offline stays capped and has no timers or catch-up sweeps', async () => {
  const f = fixture();
  for (let i = 0; i <= 86_400; i += 5) {
    await f.ensureReachable('heartbeat');
    f.advance(5_000);
  }
  assert.deepEqual(f.scanTimes.slice(0, 6), [0, 30_000, 90_000, 210_000, 450_000, 750_000]);
  for (let i = 5; i < f.scanTimes.length; i++) {
    assert.equal(f.scanTimes[i] - f.scanTimes[i - 1], 300_000);
  }
  assert.ok(f.scans < 300);
  f.advance(86_400_000);
  const before = f.scans;
  await f.ensureReachable('websocket_open');
  assert.equal(f.scans, before + 1, 'one overdue scan, never a catch-up loop');
});

test('returning at the known address bypasses the sweep cooldown within one health interval', async () => {
  const f = fixture();
  await f.ensureReachable('startup');
  f.online();
  assert.equal(await f.ensureReachable('heartbeat'), null);
  f.advance(5_000);
  assert.equal(await f.ensureReachable('heartbeat'), HEALTH);
  assert.equal(f.scans, 1);
  f.online(false);
  await f.ensureReachable('post_failure:tts_mouth');
  assert.equal(f.scans, 2, 'verified recovery resets the sweep budget');
});

test('successful rediscovery resets backoff for the next outage', async () => {
  const f = fixture();
  await f.ensureReachable('startup');
  f.advance(30_000);
  await f.ensureReachable('heartbeat');
  f.advance(60_000);
  f.found();
  assert.equal(await f.ensureReachable('heartbeat'), HEALTH);
  f.found(false);
  await f.ensureReachable('post_failure:tts_audio');
  const scans = f.scans;
  f.advance(30_000);
  await f.ensureReachable('heartbeat');
  assert.equal(f.scans, scans + 1, 'new outage starts at 30 seconds, not the old delay');
});

test('heartbeat, audio, mouth and explicit requests join one in-flight probe and sweep', async () => {
  const probe = deferred(), scan = deferred();
  let probes = 0, scans = 0;
  const f = fixture({
    probe: () => { probes++; return probe.promise; },
    discover: () => { scans++; return scan.promise; }
  });
  const first = f.ensureReachable('heartbeat', { allowDiscovery: false });
  const others = ['tts_mouth', 'tts_audio', 'atom_volume_set'].map(reason =>
    f.ensureReachable(reason, { force: true }));
  for (const other of others) assert.equal(other, first);
  await Promise.resolve();
  assert.equal(probes, 1);
  probe.resolve(null);
  await Promise.resolve();
  assert.equal(scans, 1);
  scan.resolve(HEALTH);
  assert.deepEqual(await Promise.all([first, ...others]), [HEALTH, HEALTH, HEALTH, HEALTH]);
});

test('explicit request bypasses cooldown but concurrent requests still share one sweep', async () => {
  const f = fixture();
  await f.ensureReachable('startup');
  f.found();
  const one = f.ensureReachable('manual', { force: true });
  const two = f.ensureReachable('manual', { force: true });
  assert.equal(one, two);
  assert.equal(await one, HEALTH);
  assert.equal(f.probes, 2);
  assert.equal(f.scans, 2);
});

test('manual discovery cannot join an automatic cached result already decided as offline', async () => {
  const f = fixture();
  await f.ensureReachable('startup');
  f.found();
  const cached = f.ensureReachable('heartbeat');
  await Promise.resolve(); // cached operation returned, cleanup is still queued
  const manual = f.ensureReachable('manual', { force: true });
  assert.notEqual(manual, cached);
  const joined = f.ensureReachable('post_failure:tts_audio');
  assert.equal(joined, manual, 'old cleanup cannot clear the new in-flight request');
  assert.equal(await cached, null);
  assert.equal(await manual, HEALTH);
  assert.equal(f.scans, 2);
});

test('slow or throwing sweeps wait from completion and release the shared operation', async () => {
  let at = 0, scans = 0;
  const f = createAtomDiscoveryRecovery({
    now: () => at, probe: async () => null,
    discover: async () => { scans++; at += 120_000; throw Error('mock discovery failed'); }
  });
  await assert.rejects(f.ensureReachable('startup'), /mock discovery failed/);
  assert.equal(await f.ensureReachable('heartbeat'), null);
  assert.equal(scans, 1);
  at += 30_000;
  await assert.rejects(f.ensureReachable('heartbeat'), /mock discovery failed/);
  assert.equal(scans, 2);
});

test('disabled discovery still probes known endpoint and never sweeps', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    await f.ensureReachable('heartbeat', { allowDiscovery: false, force: true });
    f.advance(1_000_000);
  }
  assert.equal(f.scans, 0);
  f.online();
  assert.equal(await f.ensureReachable('heartbeat', { allowDiscovery: false }), HEALTH);
});

test('rejects invalid recovery intervals', () => {
  for (const options of [{ probeIntervalMs: 0 }, { initialCooldownMs: NaN }, { maxCooldownMs: 1 }]) {
    assert.throws(() => fixture(options), RangeError);
  }
});
