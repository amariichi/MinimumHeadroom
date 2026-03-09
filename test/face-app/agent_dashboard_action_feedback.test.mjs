import assert from 'node:assert/strict';
import test from 'node:test';
import {
  summarizeAgentActionFailure,
  summarizeAgentActionSuccess
} from '../../face-app/public/agent_dashboard_action_feedback.js';

test('summarizeAgentActionSuccess returns generic ok feedback', () => {
  const feedback = summarizeAgentActionSuccess('agent-a', 'delete-worktree', {
    ok: true,
    result: {
      noop: false,
      agent: {
        last_message: 'worktree deleted'
      }
    }
  });
  assert.equal(feedback.statusTone, 'ok');
  assert.equal(feedback.statusText, 'agent-a: delete-worktree ok');
  assert.equal(feedback.tileMessage, 'worktree deleted');
});

test('summarizeAgentActionSuccess handles focus and delete-worktree noop', () => {
  const focus = summarizeAgentActionSuccess('agent-a', 'focus', {
    ok: true,
    result: {
      noop: false
    }
  });
  assert.equal(focus.statusText, 'agent-a: focus ok');
  assert.equal(focus.tileMessage, 'focused in operator');

  const deleteNoop = summarizeAgentActionSuccess('agent-a', 'delete-worktree', {
    ok: true,
    result: {
      noop: true
    }
  });
  assert.equal(deleteNoop.statusText, 'agent-a: delete-worktree noop');
  assert.equal(deleteNoop.tileMessage, 'worktree already absent');
});

test('summarizeAgentActionSuccess handles delete success', () => {
  const feedback = summarizeAgentActionSuccess('agent-a', 'delete', {
    ok: true,
    result: {
      noop: false
    }
  });
  assert.equal(feedback.statusTone, 'ok');
  assert.equal(feedback.statusText, 'agent-a: deleted');
  assert.equal(feedback.tileMessage, 'deleted');
});

test('summarizeAgentActionFailure prefers error.detail', () => {
  const error = new Error('delete-worktree failed (409): should not be shown');
  error.detail = 'delete-worktree requires pane to be detached first';
  const feedback = summarizeAgentActionFailure('agent-a', 'delete-worktree', error);
  assert.equal(feedback.statusTone, 'warn');
  assert.match(feedback.statusText, /pane to be detached first/);
  assert.match(feedback.tileMessage, /delete-worktree failed/);
  assert.match(feedback.tileMessage, /pane to be detached first/);
});

test('summarizeAgentActionFailure falls back to error message detail parsing', () => {
  const error = new Error('focus failed (409): focus target pane is unavailable: %3');
  const feedback = summarizeAgentActionFailure('agent-a', 'focus', error);
  assert.equal(feedback.statusTone, 'warn');
  assert.match(feedback.statusText, /focus target pane is unavailable/);
  assert.match(feedback.tileMessage, /focus failed: focus target pane is unavailable/);
});
