import assert from 'node:assert/strict';
import test from 'node:test';
import { createSayGate } from '../../face-app/dist/say_gate.js';

test('say gate skips dedupe for priority=3 even when dedupe_key matches', () => {
  const gate = createSayGate();

  const first = gate.check({ session_id: 's1', priority: 3, dedupe_key: 'permission_required', text: '許可をお願いします' }, 1_000);
  const second = gate.check({ session_id: 's2', priority: 3, dedupe_key: 'permission_required', text: '許可をお願いします' }, 2_000);
  const third = gate.check({ session_id: 's3', priority: 3, dedupe_key: 'permission_required', text: '許可をお願いします' }, 32_000);

  assert.equal(first.allow, true);
  assert.equal(second.allow, true);
  assert.equal(third.allow, true);
});

test('say gate does not dedupe when dedupe_key is null even if text repeats', () => {
  const gate = createSayGate();

  const first = gate.check({ session_id: 's1', priority: 2, text: 'same text', dedupe_key: null }, 1_000);
  const second = gate.check({ session_id: 's2', priority: 2, text: 'same text', dedupe_key: null }, 2_000);

  assert.equal(first.allow, true);
  assert.equal(second.allow, true);
});

test('say gate dedupes priority<=2 only when dedupe_key repeats inside short window', () => {
  const gate = createSayGate();

  const first = gate.check({ session_id: 's1', priority: 2, dedupe_key: 'retrying' }, 1_000);
  const second = gate.check({ session_id: 's2', priority: 2, dedupe_key: 'retrying' }, 2_000);
  const afterWindow = gate.check({ session_id: 's3', priority: 2, dedupe_key: 'retrying' }, 5_500);

  assert.equal(first.allow, true);
  assert.equal(second.allow, false);
  assert.equal(second.reason, 'dedupe');
  assert.equal(afterWindow.allow, true);
});

test('say gate enforces priority1 interval then session cap', () => {
  const gate = createSayGate();

  const first = gate.check({ session_id: 's1', priority: 1, text: 'one' }, 0);
  const tooSoon = gate.check({ session_id: 's1', priority: 1, text: 'two' }, 5_000);
  const sameSession = gate.check({ session_id: 's1', priority: 1, text: 'three' }, 9_000);
  const otherSession = gate.check({ session_id: 's2', priority: 1, text: 'four' }, 9_000);

  assert.equal(first.allow, true);
  assert.equal(tooSoon.allow, false);
  assert.equal(tooSoon.reason, 'min_interval');
  assert.equal(sameSession.allow, false);
  assert.equal(sameSession.reason, 'session_cap');
  assert.equal(otherSession.allow, true);
});

test('say gate enforces global and session caps for priority<=2', () => {
  const gate = createSayGate();

  assert.equal(gate.check({ session_id: 'a', priority: 2, text: 'a1' }, 0).allow, true);
  assert.equal(gate.check({ session_id: 'b', priority: 2, text: 'b1' }, 1_000).allow, true);
  assert.equal(gate.check({ session_id: 'c', priority: 2, text: 'c1' }, 2_000).allow, true);

  const globalBlocked = gate.check({ session_id: 'd', priority: 2, text: 'd1' }, 3_000);
  assert.equal(globalBlocked.allow, false);
  assert.equal(globalBlocked.reason, 'global_cap');

  const afterWindow = gate.check({ session_id: 'd', priority: 2, text: 'd2' }, 62_000);
  assert.equal(afterWindow.allow, true);

  const sessionBlocked = gate.check({ session_id: 'd', priority: 2, text: 'd3' }, 62_500);
  assert.equal(sessionBlocked.allow, false);
  assert.equal(sessionBlocked.reason, 'session_cap');
});
