import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAgentResultToAgents } from '../../face-app/public/agent_dashboard_apply_result.js';

test('applyAgentResultToAgents updates an existing agent in place by id', () => {
  const before = [
    { id: 'a', status: 'active', slot: 0, session_id: 's-a', last_message: 'working' },
    { id: 'b', status: 'paused', slot: 1, session_id: 's-b', last_message: 'paused' }
  ];
  const next = applyAgentResultToAgents(before, {
    id: 'b',
    status: 'active',
    slot: 1,
    session_id: 's-b',
    last_message: 'resumed'
  });
  assert.equal(next.length, 2);
  assert.equal(next[1].id, 'b');
  assert.equal(next[1].status, 'active');
  assert.equal(next[1].last_message, 'resumed');
});

test('applyAgentResultToAgents appends new agent and keeps sorted order', () => {
  const before = [{ id: 'a', status: 'active', slot: 0, session_id: 's-a' }];
  const next = applyAgentResultToAgents(before, {
    id: 'c',
    status: 'active',
    slot: 2,
    session_id: 's-c'
  });
  assert.equal(next.length, 2);
  assert.equal(next[0].id, 'a');
  assert.equal(next[1].id, 'c');
});

test('applyAgentResultToAgents keeps original list when result agent is invalid', () => {
  const before = [{ id: 'a', status: 'active', slot: 0, session_id: 's-a' }];
  const next = applyAgentResultToAgents(before, null);
  assert.deepEqual(next, before);
});
