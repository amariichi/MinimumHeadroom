import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveObservedAgentFromPayload,
  deriveAgentTransientUpdate,
  matchesOperatorIdentity,
  resolveAgentIdForPane,
  resolveAgentIdForPayload,
  shouldCountPayloadAsAgentActivity,
  summarizeAgentEventMessage,
  summarizeSpeechBubbleText
} from '../../face-app/public/agent_dashboard_feed.js';

test('resolveAgentIdForPayload matches explicit agent_id first', () => {
  const agents = [
    { id: 'a', session_id: 'session-a' },
    { id: 'b', session_id: 'session-b' }
  ];
  assert.equal(resolveAgentIdForPayload({ agent_id: 'b', session_id: 'session-a' }, agents), 'b');
  assert.equal(resolveAgentIdForPayload({ agent_id: 'helper-ephemeral' }, agents), 'helper-ephemeral');
});

test('resolveAgentIdForPayload canonicalizes operator aliases when configured', () => {
  const agents = [
    { id: 'a', session_id: 'session-a' },
    { id: 'b', session_id: 'session-b' }
  ];
  const options = {
    operatorAgentId: '__operator__',
    operatorSessionId: 'prod-operator',
    operatorAliases: ['operator', 'default']
  };
  assert.equal(resolveAgentIdForPayload({ agent_id: 'operator' }, agents, options), '__operator__');
  assert.equal(resolveAgentIdForPayload({ session_id: '__operator__' }, agents, options), '__operator__');
  assert.equal(resolveAgentIdForPayload({ session_id: 'default' }, agents, options), '__operator__');
  assert.equal(resolveAgentIdForPayload({ session_id: 'prod-operator' }, agents, options), '__operator__');
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

test('deriveObservedAgentFromPayload builds a provisional helper tile model from explicit identity', () => {
  assert.deepEqual(
    deriveObservedAgentFromPayload({
      type: 'say',
      agent_id: 'helper-review',
      agent_label: 'Review Helper',
      session_id: 'default',
      ts: 1234
    }, {
      operatorAgentId: '__operator__'
    }),
    {
      id: 'helper-review',
      label: 'Review Helper',
      status: 'active',
      slot: null,
      pane_id: null,
      session_id: 'default',
      last_message: 'observed helper activity',
      message_source: 'speech',
      updated_at: 1234,
      provisional: true
    }
  );
  assert.equal(
    deriveObservedAgentFromPayload({ agent_id: '__operator__' }, { operatorAgentId: '__operator__' }),
    null
  );
  assert.equal(
    deriveObservedAgentFromPayload(
      { agent_id: 'operator' },
      {
        operatorAgentId: '__operator__',
        operatorSessionId: 'prod-operator',
        operatorAliases: ['operator', 'default']
      }
    ),
    null
  );
});

test('matchesOperatorIdentity recognizes configured operator aliases', () => {
  const options = {
    operatorAgentId: '__operator__',
    operatorSessionId: 'prod-operator',
    operatorAliases: ['operator', 'default']
  };
  assert.equal(matchesOperatorIdentity('__operator__', options), true);
  assert.equal(matchesOperatorIdentity('operator', options), true);
  assert.equal(matchesOperatorIdentity('default', options), true);
  assert.equal(matchesOperatorIdentity('prod-operator', options), true);
  assert.equal(matchesOperatorIdentity('helper-1', options), false);
});

test('resolveAgentIdForPane maps helper panes and falls back to operator', () => {
  const agents = [
    { id: 'a', pane_id: '%2' },
    { id: 'b', pane_id: '%9' }
  ];
  assert.equal(resolveAgentIdForPane('%9', agents, { operatorAgentId: '__operator__' }), 'b');
  assert.equal(resolveAgentIdForPane('%404', agents, { operatorAgentId: '__operator__' }), '__operator__');
  assert.equal(resolveAgentIdForPane(null, agents, { operatorAgentId: '__operator__' }), '__operator__');
});

test('shouldCountPayloadAsAgentActivity ignores control-plane state chatter', () => {
  assert.equal(shouldCountPayloadAsAgentActivity({ type: 'say' }), true);
  assert.equal(shouldCountPayloadAsAgentActivity({ type: 'event' }), true);
  assert.equal(shouldCountPayloadAsAgentActivity({ type: 'operator_prompt' }), true);
  assert.equal(shouldCountPayloadAsAgentActivity({ type: 'operator_set_pane_result', ok: true }), false);
  assert.equal(shouldCountPayloadAsAgentActivity({ type: 'operator_terminal_snapshot' }), false);
  assert.equal(shouldCountPayloadAsAgentActivity({ type: 'operator_state' }), false);
  assert.equal(shouldCountPayloadAsAgentActivity({ type: 'say_result', spoken: true }), false);
});

test('summarizeAgentEventMessage normalizes key events', () => {
  assert.equal(
    summarizeAgentEventMessage({ name: 'cmd_started', meta: { action: 'run tests' } }),
    'running: run tests'
  );
  assert.equal(summarizeAgentEventMessage({ name: 'tests_passed' }), 'completed successfully');
  assert.equal(summarizeAgentEventMessage({ name: 'permission_required' }), 'approval required');
  assert.equal(summarizeAgentEventMessage({ name: 'prompt_idle' }), 'ready for next prompt');
});

test('deriveAgentTransientUpdate maps say and say_result payloads', () => {
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'say', text: 'hello world' }), {
    message: 'hello world',
    speaking: true,
    needsAttention: false,
    promptIdle: false,
    speechBubble: 'hello world',
    speechBubbleTtlMs: 5000
  });
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'say_result', spoken: false, reason: 'dropped' }), {
    message: 'speech skipped: dropped',
    speaking: false
  });
});

test('summarizeSpeechBubbleText prefers whole sentences when possible', () => {
  assert.equal(
    summarizeSpeechBubbleText('最初の文です。次の文は少し長めですが、ここでは省略されます。', 18),
    '最初の文です。'
  );
  assert.equal(
    summarizeSpeechBubbleText('one sentence ends here. second sentence keeps going for a while.', 22),
    'one sentence ends here.'
  );
});

test('deriveAgentTransientUpdate maps tts_state and focus results', () => {
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'tts_state', phase: 'play_start' }), {
    speaking: true,
    needsAttention: false,
    promptIdle: false
  });
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'tts_state', phase: 'play_stop' }), {
    speaking: false,
    promptIdle: false
  });
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'tts_state', phase: 'error' }), {
    speaking: false,
    promptIdle: false,
    error: true
  });
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'operator_set_pane_result', ok: true }), {
    message: 'focused in operator'
  });
});

test('deriveAgentTransientUpdate maps attention, prompt-idle, and error oriented events', () => {
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'event', name: 'permission_required' }), {
    message: 'approval required',
    needsAttention: true,
    needsAttentionTtlMs: 300000,
    promptIdle: false
  });
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'event', name: 'needs_attention', meta: { action: 'approval' } }), {
    message: 'attention: approval',
    needsAttention: true,
    needsAttentionTtlMs: 300000,
    promptIdle: false
  });
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'event', name: 'prompt_idle' }), {
    message: 'ready for next prompt',
    needsAttention: false,
    promptIdle: true,
    speaking: false
  });
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'event', name: 'cmd_failed' }), {
    message: 'task failed',
    needsAttention: false,
    error: true,
    promptIdle: false
  });
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'operator_prompt', state: 'awaiting_input' }), {
    message: 'attention needed',
    needsAttention: true,
    needsAttentionTtlMs: 300000,
    promptIdle: false
  });
});

test('deriveAgentTransientUpdate clears attention when work resumes or completes', () => {
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'event', name: 'cmd_started', meta: { action: 'run tests' } }), {
    message: 'running: run tests',
    needsAttention: false,
    promptIdle: false
  });
  assert.deepEqual(deriveAgentTransientUpdate({ type: 'event', name: 'cmd_succeeded' }), {
    message: 'completed successfully',
    needsAttention: false,
    promptIdle: false
  });
});
