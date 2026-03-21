import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectObservedDashboardAgentIdsToPrune,
  resolveObservedAgentUpdatedAt
} from '../../face-app/public/agent_dashboard_observed.js';

test('resolveObservedAgentUpdatedAt prefers payload timestamp over receipt time', () => {
  assert.equal(resolveObservedAgentUpdatedAt({ ts: 1234 }, 9999), 1234);
  assert.equal(resolveObservedAgentUpdatedAt({}, 9999), 9999);
});

test('collectObservedDashboardAgentIdsToPrune removes entries now covered by authoritative state', () => {
  const ids = collectObservedDashboardAgentIdsToPrune(
    [
      ['helper-1', { updated_at: 1500 }],
      ['helper-2', { updated_at: 1600 }]
    ],
    [{ id: 'helper-2' }],
    {
      authoritativeUpdatedAt: 1400,
      nowMs: 1700,
      retentionMs: 10_000
    }
  );
  assert.deepEqual(ids, ['helper-2']);
});

test('collectObservedDashboardAgentIdsToPrune removes stale replay entries older than authoritative state', () => {
  const ids = collectObservedDashboardAgentIdsToPrune(
    [['helper-1', { updated_at: 1500 }]],
    [],
    {
      authoritativeUpdatedAt: 2000,
      nowMs: 2100,
      retentionMs: 10_000
    }
  );
  assert.deepEqual(ids, ['helper-1']);
});

test('collectObservedDashboardAgentIdsToPrune keeps newer observed helpers absent from current state', () => {
  const ids = collectObservedDashboardAgentIdsToPrune(
    [['helper-1', { updated_at: 2500 }]],
    [],
    {
      authoritativeUpdatedAt: 2000,
      nowMs: 2600,
      retentionMs: 10_000
    }
  );
  assert.deepEqual(ids, []);
});

test('collectObservedDashboardAgentIdsToPrune falls back to retention for unregistered observed helpers', () => {
  const ids = collectObservedDashboardAgentIdsToPrune(
    [['helper-1', { updated_at: 1000 }]],
    [],
    {
      authoritativeUpdatedAt: 0,
      nowMs: 12_500,
      retentionMs: 10_000
    }
  );
  assert.deepEqual(ids, ['helper-1']);
});
