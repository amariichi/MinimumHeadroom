import assert from 'node:assert/strict';
import test from 'node:test';
import { applyAgentResultToAgents } from '../../face-app/public/agent_dashboard_apply_result.js';
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

test('dashboard flow integration: say -> stop partial -> persisted state transition', () => {
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

  const stopFeedback = summarizeAgentActionSuccess('agent-b', 'stop', {
    ok: true,
    result: {
      noop: false,
      orchestration: {
        pane_killed: false
      },
      agent: {
        pane_id: '%77'
      }
    }
  });
  assert.equal(stopFeedback.statusTone, 'warn');
  transientById.set('agent-b', {
    message: stopFeedback.tileMessage,
    speaking: false
  });

  agents = applyAgentResultToAgents(agents, {
    id: 'agent-b',
    status: 'stopped',
    slot: 1,
    session_id: 'session-b',
    pane_id: '%77',
    last_message: 'stopped; pane is still attached'
  });
  const stopped = agents.find((agent) => agent.id === 'agent-b');
  assert.equal(stopped?.status, 'stopped');
  assert.equal(summarizeAgentTileMessage(stopped, transientMessageFor('agent-b', transientById)), 'stopped; pane is still attached');

  transientById.delete('agent-b');
  assert.equal(summarizeAgentTileMessage(stopped, transientMessageFor('agent-b', transientById)), 'stopped; pane is still attached');
});

test('dashboard flow integration: restore partial warning remains visible with updated state', () => {
  let agents = [{ id: 'agent-b', status: 'removed', slot: null, session_id: 'session-b', last_message: 'removed' }];
  const transientById = new Map();

  const restoreFeedback = summarizeAgentActionSuccess('agent-b', 'restore', {
    ok: true,
    result: {
      noop: false,
      restore: {
        pane_available: false
      }
    }
  });
  assert.equal(restoreFeedback.statusTone, 'warn');
  transientById.set('agent-b', {
    message: restoreFeedback.tileMessage,
    speaking: false
  });

  agents = applyAgentResultToAgents(agents, {
    id: 'agent-b',
    status: 'active',
    slot: 1,
    session_id: 'session-b',
    pane_id: null,
    last_message: 'restored; pane unavailable'
  });
  const restored = agents.find((agent) => agent.id === 'agent-b');
  assert.equal(restored?.status, 'active');
  assert.equal(deriveAgentTileTone(restored, { speaking: false }), 'working');
  assert.equal(summarizeAgentTileMessage(restored, transientMessageFor('agent-b', transientById)), 'restored; pane unavailable');
});

test('dashboard flow integration: action failure feedback keeps actionable detail', () => {
  const error = new Error('restore failed (409): restore requires existing worktree path: /tmp/worktree');
  const feedback = summarizeAgentActionFailure('agent-b', 'restore', error);
  assert.equal(feedback.statusTone, 'warn');
  assert.match(feedback.statusText, /restore requires existing worktree path/);
  assert.match(feedback.tileMessage, /restore failed/);
});
