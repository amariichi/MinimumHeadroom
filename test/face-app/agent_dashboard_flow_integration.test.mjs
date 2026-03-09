import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAgentResultToAgents, resolveAgentsFromActionResult } from '../../face-app/public/agent_dashboard_apply_result.js';
import { summarizeAgentActionFailure, summarizeAgentActionSuccess } from '../../face-app/public/agent_dashboard_action_feedback.js';
import { deriveAgentTransientUpdate, resolveAgentIdForPayload } from '../../face-app/public/agent_dashboard_feed.js';
import { deriveAgentTileTone, summarizeAgentTileMessage } from '../../face-app/public/agent_dashboard_state.js';

function applyFeedPayload(payload, agents, transientById) {
  const agentId = resolveAgentIdForPayload(payload, agents);
  if (!agentId) {
    return;
  }
  const update = deriveAgentTransientUpdate(payload);
  if (!update) {
    return;
  }
  const next = transientById.get(agentId) ?? { message: null, speaking: false };
  if (typeof update.message === 'string' && update.message.trim() !== '') {
    next.message = update.message;
  }
  if (typeof update.speaking === 'boolean') {
    next.speaking = update.speaking;
  }
  transientById.set(agentId, next);
}

function transientMessageFor(agentId, transientById) {
  return transientById.get(agentId)?.message ?? null;
}

function transientSpeakingFor(agentId, transientById) {
  return transientById.get(agentId)?.speaking === true;
}

test('dashboard flow integration: say -> missing transition -> persisted state transition', () => {
  let agents = [
    { id: 'agent-a', status: 'active', slot: 0, session_id: 'session-a', last_message: null },
    { id: 'agent-b', status: 'active', slot: 1, session_id: 'session-b', last_message: 'working' }
  ];
  const transientById = new Map();

  applyFeedPayload(
    {
      type: 'say',
      session_id: 'session-b',
      text: 'running tests now'
    },
    agents,
    transientById
  );

  assert.equal(transientMessageFor('agent-b', transientById), 'running tests now');
  assert.equal(deriveAgentTileTone(agents[1], { speaking: transientSpeakingFor('agent-b', transientById) }), 'speaking');
  assert.equal(summarizeAgentTileMessage(agents[1], transientMessageFor('agent-b', transientById)), 'running tests now');

  const missingFeedback = summarizeAgentActionFailure(
    'agent-b',
    'focus',
    new Error('focus failed (409): focus target pane is unavailable: %77')
  );
  assert.equal(missingFeedback.statusTone, 'warn');
  transientById.set('agent-b', {
    message: missingFeedback.tileMessage,
    speaking: false
  });

  agents = applyAgentResultToAgents(agents, {
    id: 'agent-b',
    status: 'missing',
    slot: 1,
    session_id: 'session-b',
    pane_id: null,
    last_message: 'pane missing'
  });
  const missing = agents.find((agent) => agent.id === 'agent-b');
  assert.equal(missing?.status, 'missing');
  assert.equal(
    summarizeAgentTileMessage(missing, transientMessageFor('agent-b', transientById)),
    'focus failed: focus target pane is unavailable: %77'
  );

  transientById.delete('agent-b');
  assert.equal(summarizeAgentTileMessage(missing, transientMessageFor('agent-b', transientById)), 'pane missing');
});

test('dashboard flow integration: delete success removes the tile after state refresh', () => {
  let agents = [
    { id: 'agent-a', status: 'active', slot: 0, session_id: 'session-a', last_message: 'working' },
    { id: 'agent-b', status: 'missing', slot: 1, session_id: 'session-b', last_message: 'pane missing' }
  ];
  const transientById = new Map();

  const deleteFeedback = summarizeAgentActionSuccess('agent-b', 'delete', {
    ok: true,
    result: {
      noop: false,
      state: {
        agents: [{ id: 'agent-a', status: 'active', slot: 0, session_id: 'session-a', last_message: 'working' }]
      }
    }
  });
  assert.equal(deleteFeedback.statusTone, 'ok');
  transientById.set('agent-b', {
    message: deleteFeedback.tileMessage,
    speaking: false
  });

  agents = applyAgentResultToAgents(agents, {
    id: 'agent-b',
    status: 'missing',
    slot: 1,
    session_id: 'session-b',
    last_message: 'deleted'
  });

  const pendingDelete = agents.find((agent) => agent.id === 'agent-b');
  assert.equal(pendingDelete?.status, 'missing');
  assert.equal(summarizeAgentTileMessage(pendingDelete, transientMessageFor('agent-b', transientById)), 'deleted');

  agents = resolveAgentsFromActionResult(agents, {
    state: {
      agents: [{ id: 'agent-a', status: 'active', slot: 0, session_id: 'session-a', last_message: 'working' }]
    }
  });
  assert.equal(agents.some((agent) => agent.id === 'agent-b'), false);
});

test('dashboard flow integration: action failure feedback keeps actionable detail', () => {
  const error = new Error('delete failed (409): delete requires pane to be detached first');
  const feedback = summarizeAgentActionFailure('agent-b', 'delete', error);
  assert.equal(feedback.statusTone, 'warn');
  assert.match(feedback.statusText, /delete requires pane to be detached first/);
  assert.match(feedback.tileMessage, /delete failed/);
});
