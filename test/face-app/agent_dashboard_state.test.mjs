import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveAgentTileTone,
  deriveDashboardMode,
  normalizeAgentStatus,
  normalizeDashboardAgent,
  sortDashboardAgents,
  summarizeAgentTileMessage
} from '../../face-app/public/agent_dashboard_state.js';

test('normalizeDashboardAgent keeps expected shape', () => {
  const agent = normalizeDashboardAgent(
    {
      id: 'agent-a',
      status: 'paused',
      slot: 2,
      pane_id: '%12',
      session_id: 'session-a',
      last_message: 'ready'
    },
    0
  );

  assert.equal(agent.id, 'agent-a');
  assert.equal(agent.status, 'paused');
  assert.equal(agent.slot, 2);
  assert.equal(agent.pane_id, '%12');
  assert.equal(agent.session_id, 'session-a');
  assert.equal(agent.last_message, 'ready');
});

test('normalizeAgentStatus falls back to active on unknown values', () => {
  assert.equal(normalizeAgentStatus('active'), 'active');
  assert.equal(normalizeAgentStatus('UNKNOWN'), 'active');
  assert.equal(normalizeAgentStatus(null), 'active');
});

test('sortDashboardAgents keeps removed agents at the end and respects slot', () => {
  const sorted = sortDashboardAgents([
    normalizeDashboardAgent({ id: 'c', status: 'removed', slot: 0 }),
    normalizeDashboardAgent({ id: 'b', status: 'active', slot: 3 }),
    normalizeDashboardAgent({ id: 'a', status: 'active', slot: 1 })
  ]);

  assert.deepEqual(
    sorted.map((item) => item.id),
    ['a', 'b', 'c']
  );
});

test('deriveDashboardMode returns multi only on desktop with multiple active agents', () => {
  const agents = [
    normalizeDashboardAgent({ id: 'a', status: 'active' }),
    normalizeDashboardAgent({ id: 'b', status: 'paused' })
  ];
  assert.equal(deriveDashboardMode(agents, { isMobileUi: false }), 'multi');
  assert.equal(deriveDashboardMode(agents, { isMobileUi: true }), 'single');
});

test('deriveAgentTileTone prioritizes speaking state', () => {
  const active = normalizeDashboardAgent({ status: 'active' });
  const paused = normalizeDashboardAgent({ status: 'paused' });
  assert.equal(deriveAgentTileTone(active, { speaking: false }), 'working');
  assert.equal(deriveAgentTileTone(paused, { speaking: false }), 'idle');
  assert.equal(deriveAgentTileTone(paused, { speaking: true }), 'speaking');
});

test('summarizeAgentTileMessage prefers transient then persisted text', () => {
  const agent = normalizeDashboardAgent({ status: 'active', last_message: 'persisted' });
  assert.equal(summarizeAgentTileMessage(agent, 'transient'), 'transient');
  assert.equal(summarizeAgentTileMessage(agent, null), 'persisted');
  assert.equal(summarizeAgentTileMessage(normalizeDashboardAgent({ status: 'removed' })), 'removed');
});

