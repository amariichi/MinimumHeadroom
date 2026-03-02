import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorRealtimeAsrProxy } from '../../face-app/dist/operator_realtime_asr_proxy.js';

class MockSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
    this.closed = false;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.closed = true;
    this.emit('close', {});
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}

test('operator realtime ASR proxy relays browser chunks into an upstream session', async () => {
  const broadcasts = [];
  const sockets = [];
  const proxy = createOperatorRealtimeAsrProxy({
    enabled: true,
    endpointUrl: 'ws://127.0.0.1:8000/v1/realtime',
    model: 'mistralai/Voxtral-Mini-4B-Realtime-2602',
    websocketFactory(url) {
      const socket = new MockSocket(url);
      sockets.push(socket);
      return socket;
    },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    }
  });

  const startDirective = proxy.handlePayload({
    v: 1,
    type: 'operator_realtime_asr_start',
    session_id: 'realtime#test',
    language: 'ja',
    ts: Date.now()
  });
  assert.deepEqual(startDirective, { relay: false });
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'ws://127.0.0.1:8000/v1/realtime');

  proxy.handlePayload({
    v: 1,
    type: 'operator_realtime_asr_chunk',
    session_id: 'realtime#test',
    language: 'ja',
    audio: 'ZmFrZS1hdWRpbw==',
    ts: Date.now()
  });

  assert.equal(sockets[0].sent.length, 0);

  sockets[0].emit('message', {
    data: JSON.stringify({
      type: 'session.created'
    })
  });

  assert.equal(sockets[0].sent.length, 3);
  assert.deepEqual(sockets[0].sent[0], {
    type: 'session.update',
    model: 'mistralai/Voxtral-Mini-4B-Realtime-2602'
  });
  assert.deepEqual(sockets[0].sent[1], {
    type: 'input_audio_buffer.commit'
  });
  assert.deepEqual(sockets[0].sent[2], {
    type: 'input_audio_buffer.append',
    audio: 'ZmFrZS1hdWRpbw=='
  });

  sockets[0].emit('message', {
    data: JSON.stringify({
      type: 'transcription.delta',
      delta: 'hello '
    })
  });
  sockets[0].emit('message', {
    data: JSON.stringify({
      type: 'transcription.done',
      text: 'hello world'
    })
  });

  assert.equal(broadcasts.length, 2);
  assert.equal(broadcasts[0].type, 'operator_realtime_asr_delta');
  assert.equal(broadcasts[0].delta, 'hello ');
  assert.equal(broadcasts[0].text, 'hello ');
  assert.equal(broadcasts[1].type, 'operator_realtime_asr_done');
  assert.equal(broadcasts[1].text, 'hello world');

  proxy.handlePayload({
    v: 1,
    type: 'operator_realtime_asr_stop',
    session_id: 'realtime#test',
    language: 'ja',
    ts: Date.now()
  });

  assert.deepEqual(sockets[0].sent[3], {
    type: 'input_audio_buffer.commit',
    final: true
  });
});

test('operator realtime ASR proxy reports configuration errors without relaying payloads', async () => {
  const broadcasts = [];
  const proxy = createOperatorRealtimeAsrProxy({
    enabled: false,
    endpointUrl: '',
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    }
  });

  const directive = proxy.handlePayload({
    v: 1,
    type: 'operator_realtime_asr_start',
    session_id: 'disabled#test',
    language: 'en',
    ts: Date.now()
  });

  assert.deepEqual(directive, { relay: false });
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].type, 'operator_realtime_asr_error');
  assert.equal(broadcasts[0].error, 'realtime_asr_not_configured');
});

test('operator realtime ASR proxy synthesizes done when upstream closes after final commit', async () => {
  const broadcasts = [];
  const sockets = [];
  const proxy = createOperatorRealtimeAsrProxy({
    enabled: true,
    endpointUrl: 'ws://127.0.0.1:8000/v1/realtime',
    websocketFactory(url) {
      const socket = new MockSocket(url);
      sockets.push(socket);
      return socket;
    },
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    }
  });

  proxy.handlePayload({
    v: 1,
    type: 'operator_realtime_asr_start',
    session_id: 'realtime#close',
    language: 'en',
    ts: Date.now()
  });

  sockets[0].emit('message', {
    data: JSON.stringify({
      type: 'session.created'
    })
  });

  sockets[0].emit('message', {
    data: JSON.stringify({
      type: 'transcription.delta',
      delta: 'partial text'
    })
  });

  proxy.handlePayload({
    v: 1,
    type: 'operator_realtime_asr_stop',
    session_id: 'realtime#close',
    language: 'en',
    ts: Date.now()
  });

  sockets[0].emit('close', {});

  assert.equal(broadcasts.length, 2);
  assert.equal(broadcasts[0].type, 'operator_realtime_asr_delta');
  assert.equal(broadcasts[0].text, 'partial text');
  assert.equal(broadcasts[1].type, 'operator_realtime_asr_done');
  assert.equal(broadcasts[1].text, 'partial text');
});

test('operator realtime ASR proxy ignores cancel when no session is active', async () => {
  const broadcasts = [];
  const proxy = createOperatorRealtimeAsrProxy({
    enabled: true,
    endpointUrl: 'ws://127.0.0.1:8000/v1/realtime',
    broadcast(payload) {
      broadcasts.push(payload);
      return true;
    }
  });

  const directive = proxy.handlePayload({
    v: 1,
    type: 'operator_realtime_asr_cancel',
    session_id: 'realtime#missing',
    language: 'en',
    ts: Date.now()
  });

  assert.deepEqual(directive, { relay: false });
  assert.equal(broadcasts.length, 0);
});
