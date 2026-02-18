import assert from 'node:assert/strict';
import test from 'node:test';
import { createTtsController } from '../../face-app/dist/tts_controller.js';

class FakeWorker {
  constructor() {
    this.handlers = new Map();
    this.sent = [];
    this.stopped = false;
  }

  on(eventName, handler) {
    const list = this.handlers.get(eventName) ?? [];
    list.push(handler);
    this.handlers.set(eventName, list);
  }

  send(payload) {
    this.sent.push(payload);
    return true;
  }

  stop() {
    this.stopped = true;
  }

  emit(eventName, payload) {
    const list = this.handlers.get(eventName) ?? [];
    for (const handler of list) {
      handler(payload);
    }
  }
}

function speaks(worker) {
  return worker.sent.filter((payload) => payload.op === 'speak');
}

function interrupts(worker) {
  return worker.sent.filter((payload) => payload.op === 'interrupt');
}

async function speakOnce(payload) {
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => 42_000,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });
  const result = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    priority: 2,
    policy: 'replace',
    ttl_ms: 10_000,
    ts: 42_000,
    ...payload
  });

  return { worker, result };
}

test('tts controller interrupt path supersedes current generation', async () => {
  let nowMs = 1_000;
  const worker = new FakeWorker();
  const broadcasts = [];

  const controller = createTtsController({
    worker,
    now: () => nowMs,
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  const first = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    text: 'one',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: nowMs
  });
  assert.equal(first.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].generation, 1);

  nowMs += 500;
  const second = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u2',
    text: 'urgent',
    priority: 3,
    policy: 'interrupt',
    ttl_ms: 4_000,
    ts: nowMs
  });

  assert.equal(second.accepted, true);
  assert.equal(interrupts(worker).length, 1);
  assert.equal(interrupts(worker)[0].generation, 1);
  assert.equal(speaks(worker).length, 2);
  assert.equal(speaks(worker)[1].generation, 2);

  worker.emit('message', { type: 'event', phase: 'play_stop', generation: 1, utterance_id: 'u1', session_id: 's1' });
  assert.equal(controller.snapshot().activeGeneration, 2);

  worker.emit('message', { type: 'event', phase: 'play_stop', generation: 2, utterance_id: 'u2', session_id: 's1' });
  assert.equal(controller.snapshot().activeGeneration, null);

  const stopPayload = broadcasts.find((payload) => payload.type === 'tts_state' && payload.phase === 'play_stop' && payload.generation === 2);
  assert.ok(stopPayload);
});

test('tts controller keeps only latest pending replace and starts it after stop', async () => {
  let nowMs = 10_000;
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => nowMs,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  await controller.handleSayPayload({ type: 'say', session_id: 's1', utterance_id: 'u1', text: 'first', priority: 2, policy: 'replace', ttl_ms: 5_000, ts: nowMs });
  await controller.handleSayPayload({ type: 'say', session_id: 's1', utterance_id: 'u2', text: 'second', priority: 2, policy: 'replace', ttl_ms: 5_000, ts: nowMs + 100 });
  await controller.handleSayPayload({ type: 'say', session_id: 's1', utterance_id: 'u3', text: 'third', priority: 2, policy: 'replace', ttl_ms: 5_000, ts: nowMs + 200 });

  assert.equal(speaks(worker).length, 1);
  assert.equal(controller.snapshot().pendingGeneration, 3);

  worker.emit('message', { type: 'event', phase: 'play_stop', generation: 1, utterance_id: 'u1', session_id: 's1' });

  assert.equal(speaks(worker).length, 2);
  assert.equal(speaks(worker)[1].generation, 3);
  assert.equal(controller.snapshot().pendingGeneration, null);
});

test('tts controller drops ttl-expired utterance before dispatch', async () => {
  let nowMs = 8_000;
  const worker = new FakeWorker();
  const broadcasts = [];
  const controller = createTtsController({
    worker,
    now: () => nowMs,
    gate: { check: () => ({ allow: true }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  const result = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'late',
    text: 'late',
    priority: 2,
    policy: 'replace',
    ttl_ms: 500,
    ts: 1_000
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'ttl_expired');
  assert.equal(speaks(worker).length, 0);

  const dropped = broadcasts.find((payload) => payload.type === 'tts_state' && payload.phase === 'dropped');
  assert.ok(dropped);
  assert.equal(dropped.reason, 'ttl_expired');
});

test('tts controller returns dropped result with message_id/revision when gate blocks speech', async () => {
  const worker = new FakeWorker();
  const broadcasts = [];
  const controller = createTtsController({
    worker,
    now: () => 20_000,
    gate: { check: () => ({ allow: false, reason: 'dedupe' }) },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  const result = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    message_id: 'm-1',
    revision: 777,
    text: 'same',
    priority: 2,
    policy: 'replace',
    ttl_ms: 4_000,
    ts: 20_000,
    dedupe_key: 'same'
  });

  assert.equal(result.accepted, false);
  assert.equal(result.spoken, false);
  assert.equal(result.reason, 'dedupe');
  assert.equal(result.message_id, 'm-1');
  assert.equal(result.revision, 777);

  const dropped = broadcasts.find((payload) => payload.type === 'tts_state' && payload.phase === 'dropped');
  assert.ok(dropped);
  assert.equal(dropped.reason, 'dedupe');
  assert.equal(dropped.message_id, 'm-1');
  assert.equal(dropped.revision, 777);
});

test('tts controller uses long default ttl when ttl_ms is omitted', async () => {
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => 5_000,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  const result = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    text: 'ttl default check',
    priority: 2,
    policy: 'replace',
    ts: 0
  });

  assert.equal(result.accepted, true);
  assert.equal(result.reason, null);
});

test('tts controller auto-promotes replace to interrupt after threshold', async () => {
  let nowMs = 1_000;
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => nowMs,
    autoInterruptAfterMs: 2_000,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    text: 'first long',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: nowMs
  });

  nowMs += 3_000;

  const second = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u2',
    text: 'second after threshold',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: nowMs
  });

  assert.equal(second.accepted, true);
  assert.equal(interrupts(worker).length, 1);
  assert.equal(interrupts(worker)[0].reason, 'auto_interrupt');
  assert.equal(speaks(worker).length, 2);
  assert.equal(speaks(worker)[1].generation, 2);
});

test('tts controller keeps replace queued before auto-interrupt threshold', async () => {
  let nowMs = 10_000;
  const worker = new FakeWorker();
  const controller = createTtsController({
    worker,
    now: () => nowMs,
    autoInterruptAfterMs: 5_000,
    gate: { check: () => ({ allow: true }) },
    broadcast: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });

  worker.emit('message', { type: 'ready', voice: 'af_heart', engine: 'kokoro' });

  await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u1',
    text: 'first',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: nowMs
  });

  nowMs += 2_000;
  const second = await controller.handleSayPayload({
    type: 'say',
    session_id: 's1',
    utterance_id: 'u2',
    text: 'second queued',
    priority: 2,
    policy: 'replace',
    ttl_ms: 60_000,
    ts: nowMs
  });

  assert.equal(second.accepted, true);
  assert.equal(interrupts(worker).length, 0);
  assert.equal(speaks(worker).length, 1);
  assert.equal(controller.snapshot().pendingGeneration, 2);

  worker.emit('message', { type: 'event', phase: 'play_stop', generation: 1, utterance_id: 'u1', session_id: 's1' });

  assert.equal(speaks(worker).length, 2);
  assert.equal(speaks(worker)[1].generation, 2);
});

test('tts controller normalizes smart apostrophe and keeps hyphen normalization', async () => {
  const { worker, result } = await speakOnce({
    text: 'That’s a 9-to-5 role.'
  });

  assert.equal(result.accepted, true);
  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, "That's a 9 to 5 role.");
});

test('tts controller normalizes smart quotes, ellipsis, and no-break spaces', async () => {
  const { worker } = await speakOnce({
    text: 'He said, “Hello”… A\u00A0B\u202FC'
  });

  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, 'He said, "Hello"... A B C');
});

test('tts controller normalizes latin diacritics', async () => {
  const { worker } = await speakOnce({
    text: 'café naïve rôle'
  });

  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, 'cafe naive role');
});

test('tts controller keeps japanese intact while normalizing latin letters', async () => {
  const { worker } = await speakOnce({
    text: '日本語が café'
  });

  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, '日本語が cafe');
});

test('tts controller keeps full-width symbols untouched', async () => {
  const { worker } = await speakOnce({
    text: 'ＡＢＣ！'
  });

  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, 'ＡＢＣ！');
});

test('tts controller normalizes punctuation and latin diacritics without language hint', async () => {
  const { worker } = await speakOnce({
    text: 'That’s fine… café'
  });

  assert.equal(speaks(worker).length, 1);
  assert.equal(speaks(worker)[0].text, "That's fine... cafe");
});
