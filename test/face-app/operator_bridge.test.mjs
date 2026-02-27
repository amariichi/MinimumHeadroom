import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorBridgeRuntime, createTmuxController } from '../../face-app/dist/operator_bridge.js';

function createFakeTmux() {
  const calls = [];
  return {
    calls,
    pane: 'demo:0.0',
    async sendKey(token) {
      calls.push({ kind: 'key', token });
    },
    async sendText(text, options = {}) {
      calls.push({ kind: 'text', text, options });
    },
    async restart() {
      calls.push({ kind: 'restart' });
    },
    async captureTail() {
      return {
        pane: 'demo:0.0',
        lines: ['line'],
        truncated: false
      };
    }
  };
}

function createRuntimeHarness() {
  const payloads = [];
  const tmux = createFakeTmux();
  const runtime = createOperatorBridgeRuntime({
    sessionId: 's1',
    tmuxController: tmux,
    sendPayload(payload) {
      payloads.push(payload);
      return true;
    },
    now: (() => {
      let ts = 1_000;
      return () => {
        ts += 1;
        return ts;
      };
    })()
  });
  return { runtime, payloads, tmux };
}

function findLatestAck(payloads) {
  const acks = payloads.filter((item) => item.type === 'operator_ack');
  return acks[acks.length - 1] ?? null;
}

test('operator prompt is rejected when speech_message_id is missing', async () => {
  const { runtime, payloads } = createRuntimeHarness();

  await runtime.handlePayload({
    v: 1,
    type: 'operator_prompt',
    session_id: 's1',
    request_id: 'r1',
    state: 'awaiting_input',
    input_kind: 'text',
    prompt: 'say hello'
  });

  const ack = findLatestAck(payloads);
  assert.ok(ack);
  assert.equal(ack.ok, false);
  assert.equal(ack.stage, 'rejected');
  assert.equal(ack.reason, 'speech_order_violation');
});

test('operator prompt accepts only after confirmed speech and response reaches tmux', async () => {
  const { runtime, payloads, tmux } = createRuntimeHarness();

  await runtime.handlePayload({
    v: 1,
    type: 'say_result',
    session_id: 's1',
    message_id: 'msg-1',
    spoken: true,
    ts: 1_500
  });

  await runtime.handlePayload({
    v: 1,
    type: 'operator_prompt',
    session_id: 's1',
    request_id: 'r1',
    speech_message_id: 'msg-1',
    state: 'awaiting_input',
    input_kind: 'text',
    prompt: 'type /plan',
    ts: 1_700
  });

  const acceptedAck = findLatestAck(payloads);
  assert.ok(acceptedAck);
  assert.equal(acceptedAck.ok, true);
  assert.equal(acceptedAck.stage, 'accepted');
  assert.equal(runtime.getActiveRequest('s1')?.request_id, 'r1');

  await runtime.handlePayload({
    v: 1,
    type: 'operator_response',
    session_id: 's1',
    request_id: 'r1',
    response_kind: 'text',
    value: '/plan'
  });

  const sentAck = findLatestAck(payloads);
  assert.ok(sentAck);
  assert.equal(sentAck.ok, true);
  assert.equal(sentAck.stage, 'sent_to_tmux');
  assert.equal(tmux.calls.some((entry) => entry.kind === 'text' && entry.text === '/plan'), true);
  assert.equal(runtime.getActiveRequest('s1'), null);
});

test('operator response request mismatch is rejected', async () => {
  const { runtime, payloads } = createRuntimeHarness();

  await runtime.handlePayload({
    v: 1,
    type: 'say_result',
    session_id: 's1',
    message_id: 'msg-1',
    spoken: true,
    ts: 2_000
  });
  await runtime.handlePayload({
    v: 1,
    type: 'operator_prompt',
    session_id: 's1',
    request_id: 'r1',
    speech_message_id: 'msg-1',
    state: 'awaiting_input',
    input_kind: 'text',
    prompt: 'type value',
    ts: 2_100
  });

  await runtime.handlePayload({
    v: 1,
    type: 'operator_response',
    session_id: 's1',
    request_id: 'r2',
    response_kind: 'text',
    value: 'oops'
  });

  const ack = findLatestAck(payloads);
  assert.ok(ack);
  assert.equal(ack.ok, false);
  assert.equal(ack.reason, 'request_mismatch');
});

test('unsupported key returns failed ack with stable reason', async () => {
  const { runtime, payloads } = createRuntimeHarness();

  await runtime.handlePayload({
    v: 1,
    type: 'operator_response',
    session_id: 's1',
    response_kind: 'key',
    value: 'Ctrl+C'
  });

  const acks = payloads.filter((item) => item.type === 'operator_ack');
  assert.equal(acks.length >= 2, true);
  assert.equal(acks[acks.length - 1].ok, false);
  assert.equal(acks[acks.length - 1].stage, 'failed');
  assert.equal(acks[acks.length - 1].reason, 'unsupported_key');
});

test('manual text without request_id is accepted when no active request exists', async () => {
  const { runtime, payloads, tmux } = createRuntimeHarness();

  await runtime.handlePayload({
    v: 1,
    type: 'operator_response',
    session_id: 's1',
    request_id: null,
    response_kind: 'text',
    value: '聞こえますか?'
  });

  const ack = findLatestAck(payloads);
  assert.ok(ack);
  assert.equal(ack.ok, true);
  assert.equal(ack.stage, 'sent_to_tmux');
  assert.equal(ack.request_id, null);
  assert.equal(
    tmux.calls.some((entry) => entry.kind === 'text' && entry.text === '聞こえますか?' && entry.options?.reinforceSubmit === true),
    true
  );
});

test('captureTail keeps ANSI escape sequences for terminal color rendering', async () => {
  let argsUsed = null;
  const controller = createTmuxController({
    pane: 'demo:1.0',
    runCommand: async (_command, args) => {
      argsUsed = args;
      return {
        code: 0,
        stdout: '\u001b[38;5;39mcyan\u001b[0m\n',
        stderr: ''
      };
    }
  });

  const snapshot = await controller.captureTail(24);

  assert.deepEqual(argsUsed, ['capture-pane', '-t', 'demo:1.0', '-p', '-e', '-S', '-24']);
  assert.deepEqual(snapshot.lines, ['\u001b[38;5;39mcyan\u001b[0m']);
});
