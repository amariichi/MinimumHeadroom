import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveAgentTransientUpdate,
  resolveAgentIdForPayload,
  summarizeAgentEventMessage
} from '../../face-app/public/agent_dashboard_feed.js';

test('resolveAgentIdForPayload matches explicit agent_id first', () => {
  const agents = [
    { id: 'a', session_id: 'session-a' },
    { id: 'b', session_id: 'session-b' }
  ];
  assert.equal(resolveAgentIdForPayload({ agent_id: 'b', session_id: 'session-a' }, agents), 'b');
});

test('resolveAgentIdForPayload falls back to session_id mapping', () => {
  const agents = [
    { id: 'a', session_id: 'session-a' },
    { id: 'b', session_id: 'session-b' }
  ];
  assert.equal(resolveAgentIdForPayload({ session_id: 'session-b' }, agents), 'b');
  assert.equal(resolveAgentIdForPayload({ session_id: 'a' }, agents), 'a');
  assert.equal(resolveAgentIdForPayload({ session_id: 'missing' }, agents), null);
});

test('summarizeAgentEventMessage normalizes key events', () => {
  assert.equal(
    summarizeAgentEventMessage({ name: 'cmd_started', meta: { action: 'run tests' } }),
    'running: run tests'
  );
  assert.equal(summarizeAgentEventMessage({ name: 'tests_passed' }), 'completed successfully');
  assert.equal(summarizeAgentEventMessage({ name: 'permission_required' }), 'approval required');
});

test('deriveAgentTransientUpdate maps say and say_result payloads', () => {
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'say', text: 'hello world' }), {
    message: 'hello world',
    speaking: true
  });
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'say_result', spoken: false, reason: 'dropped' }), {
    message: 'speech skipped: dropped',
    speaking: false
  });
});

test('deriveAgentTransientUpdate maps tts_state and focus results', () => {
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'tts_state', phase: 'play_start' }), { speaking: true });
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'tts_state', phase: 'play_stop' }), { speaking: false });
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'operator_set_pane_result', ok: true }), {
    message: 'focused in operator'
  });
});

