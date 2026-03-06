import assert from 'node:assert/strict';
import test from 'node:test';
import {
  summarizeAgentActionFailure,
  summarizeAgentActionSuccess
} from '../../face-app/public/agent_dashboard_action_feedback.js';

test('summarizeAgentActionSuccess returns generic ok feedback', () => {
  const feedback = summarizeAgentActionSuccess('agent-a', 'pause', {
    ok: true,
    result: {
      noop: false
    }
  });
  assert.equal(feedback.statusTone, 'ok');
  assert.equal(feedback.statusText, 'agent-a: pause ok');
  assert.equal(feedback.tileMessage, 'pause ok');
});

test('summarizeAgentActionSuccess returns warning for stop partial pane kill', () => {
  const feedback = summarizeAgentActionSuccess('agent-a', 'stop', {
    ok: true,
    result: {
      noop: false,
      orchestration: {
        pane_killed: false
      },
      agent: {
        pane_id: '%21'
      }
    }
  });
  assert.equal(feedback.statusTone, 'warn');
  assert.match(feedback.statusText, /stop partial/);
  assert.equal(feedback.tileMessage, 'stopped; pane is still attached');
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

test('summarizeAgentActionFailure prefers error.detail', () => {
  const error = new Error('delete-worktree failed (409): should not be shown');
  error.detail = 'delete-worktree requires removed/stopped status (current=active)';
  const feedback = summarizeAgentActionFailure('agent-a', 'delete-worktree', error);
  assert.equal(feedback.statusTone, 'warn');
  assert.match(feedback.statusText, /removed\/stopped status/);
  assert.match(feedback.tileMessage, /delete-worktree failed/);
  assert.match(feedback.tileMessage, /removed\/stopped status/);
});

test('summarizeAgentActionFailure falls back to error message detail parsing', () => {
  const error = new Error('resume failed (409): cannot resume from status=parked');
  const feedback = summarizeAgentActionFailure('agent-a', 'resume', error);
  assert.equal(feedback.statusTone, 'warn');
  assert.match(feedback.statusText, /cannot resume from status=parked/);
  assert.match(feedback.tileMessage, /resume failed: cannot resume from status=parked/);
});
