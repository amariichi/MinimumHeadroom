import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPromptIdleFaceEvent, runNotifyCli } from '../../scripts/codex-notify-to-face.mjs';
import { startFaceWebSocketServer } from '../../face-app/dist/ws_server.js';

async function waitForCondition(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition timeout');
}

test('buildPromptIdleFaceEvent maps agent-turn-complete to operator prompt_idle', () => {
  const payload = buildPromptIdleFaceEvent(
    {
      event: 'agent-turn-complete',
      summary: 'done'
    },
    {
      env: { MH_BRIDGE_SESSION_ID: 'default' },
      now: () => 1234
    }
  );

  assert.deepEqual(payload, {
    v: 1,
    type: 'event',
    session_id: 'default',
    ts: 1234,
    name: 'prompt_idle',
    severity: 0.2,
    meta: {
      source: 'codex_notify',
      notify_event: 'agent-turn-complete',
      summary: 'done'
    }
  });
});

test('runNotifyCli emits prompt_idle websocket event for agent-turn-complete', async (t) => {
  const received = [];
  const server = await startFaceWebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/ws',
    relayPayloads: true,
    onPayload(payload) {
      received.push(payload);
    },
    log: { info: () => {}, error: () => {} }
  });

  t.after(async () => {
    await server.stop();
  });

  const result = await runNotifyCli({
    argv: [JSON.stringify({ event: 'agent-turn-complete', title: 'turn complete' })],
    env: {
      FACE_WS_URL: server.url,
      MH_BRIDGE_SESSION_ID: 'default'
    },
    now: () => 4567
  });

  assert.equal(result.emitted, true);
  await waitForCondition(() => received.length === 1);
  assert.deepEqual(received[0], {
    v: 1,
    type: 'event',
    session_id: 'default',
    ts: 4567,
    name: 'prompt_idle',
    severity: 0.2,
    meta: {
      source: 'codex_notify',
      notify_event: 'agent-turn-complete',
      summary: 'turn complete'
    }
  });
});

test('runNotifyCli ignores unrelated notify events', async () => {
  const result = await runNotifyCli({
    argv: [JSON.stringify({ event: 'approval-requested' })]
  });
  assert.deepEqual(result, {
    emitted: false,
    reason: 'ignored_event'
  });
});
