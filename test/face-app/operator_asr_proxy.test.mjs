import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createOperatorAsrProxy } from '../../face-app/dist/operator_asr_proxy.js';
import { chooseFixedAck } from '../../face-app/dist/fixed_ack.js';

function createMockRequest({ method = 'POST', url = '/', headers = {}, body = '' } = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const stream = new Readable({
    read() {
      this.push(payload);
      this.push(null);
    }
  });
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

function createMockResponse() {
  let statusCode = null;
  let responseHeaders = null;
  let rawBody = '';
  return {
    writableEnded: false,
    writeHead(code, headers) {
      statusCode = code;
      responseHeaders = headers;
    },
    end(chunk = '') {
      rawBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.writableEnded = true;
    },
    result() {
      return {
        statusCode,
        headers: responseHeaders,
        body: rawBody
      };
    }
  };
}

test('operator ASR proxy converts binary upload to JSON request and routes by lang', async () => {
  const captured = [];
  const proxy = createOperatorAsrProxy({
    baseUrl: 'http://127.0.0.1:8091',
    fetchImpl: async (url, options) => {
      captured.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            text: 'hello',
            language: 'en',
            confidence: 0.91
          });
        }
      };
    }
  });

  const request = createMockRequest({
    method: 'POST',
    url: '/api/operator/asr?lang=ja',
    headers: { 'content-type': 'audio/webm' },
    body: Buffer.from('sample-audio')
  });
  const response = createMockResponse();

  const handled = await proxy.handleHttpRequest(request, response);
  assert.equal(handled, true);
  assert.equal(captured.length, 1);
  assert.match(captured[0].url, /\/v1\/asr\/ja$/);

  const upstreamBody = JSON.parse(captured[0].options.body);
  assert.equal(upstreamBody.mimeType, 'audio/webm');
  assert.equal(typeof upstreamBody.audioBase64, 'string');
  assert.equal(upstreamBody.audioBase64.length > 0, true);

  const result = response.result();
  assert.equal(result.statusCode, 200);
  const body = JSON.parse(result.body);
  assert.equal(body.ok, true);
  assert.equal(body.text, 'hello');
  assert.equal(body.confidence, 0.91);
});

test('operator ASR proxy uses MH_LANG as the query language fallback', async () => {
  const captured = [];
  const proxy = createOperatorAsrProxy({
    baseUrl: 'http://127.0.0.1:8091',
    env: { MH_LANG: 'ja' },
    fetchImpl: async (url, options) => {
      captured.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ text: '了解', confidence: 0.8 });
        }
      };
    }
  });

  const request = createMockRequest({
    method: 'POST',
    url: '/api/operator/asr',
    headers: { 'content-type': 'audio/webm' },
    body: Buffer.from('sample-audio')
  });
  const response = createMockResponse();

  await proxy.handleHttpRequest(request, response);
  assert.equal(captured.length, 1);
  assert.match(captured[0].url, /\/v1\/asr\/ja$/);
  const body = JSON.parse(response.result().body);
  assert.equal(body.language, 'ja');
});

test('operator ASR proxy keeps explicit query language over MH_LANG', async () => {
  const captured = [];
  const proxy = createOperatorAsrProxy({
    baseUrl: 'http://127.0.0.1:8091',
    env: { MH_LANG: 'ja' },
    fetchImpl: async (url) => {
      captured.push(String(url));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ text: 'hello', confidence: 0.8 });
        }
      };
    }
  });

  const request = createMockRequest({
    method: 'POST',
    url: '/api/operator/asr?lang=en',
    headers: { 'content-type': 'audio/webm' },
    body: Buffer.from('sample-audio')
  });
  const response = createMockResponse();

  await proxy.handleHttpRequest(request, response);
  assert.equal(captured.length, 1);
  assert.match(captured[0], /\/v1\/asr\/en$/);
  const body = JSON.parse(response.result().body);
  assert.equal(body.language, 'en');
});

test('operator ASR proxy defaults to English when MH_LANG is unset', async () => {
  const captured = [];
  const proxy = createOperatorAsrProxy({
    baseUrl: 'http://127.0.0.1:8091',
    env: {},
    fetchImpl: async (url) => {
      captured.push(String(url));
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ text: 'hello', confidence: 0.8 });
        }
      };
    }
  });

  const request = createMockRequest({
    method: 'POST',
    url: '/api/operator/asr',
    headers: { 'content-type': 'audio/webm' },
    body: Buffer.from('sample-audio')
  });
  const response = createMockResponse();

  await proxy.handleHttpRequest(request, response);
  assert.equal(captured.length, 1);
  assert.match(captured[0], /\/v1\/asr\/en$/);
});

test('operator ASR proxy returns 503 when upstream is not configured', async () => {
  const proxy = createOperatorAsrProxy({
    baseUrl: '',
    endpointUrl: ''
  });

  const request = createMockRequest({
    method: 'POST',
    url: '/api/operator/asr?lang=en',
    headers: { 'content-type': 'audio/webm' },
    body: Buffer.from('sample-audio')
  });
  const response = createMockResponse();

  const handled = await proxy.handleHttpRequest(request, response);
  assert.equal(handled, true);
  const result = response.result();
  assert.equal(result.statusCode, 503);
  const body = JSON.parse(result.body);
  assert.equal(body.error, 'asr_upstream_not_configured');
});

test('operator ASR proxy invokes onBargeIn for a POST audio upload', async () => {
  const bargeIns = [];
  const proxy = createOperatorAsrProxy({
    baseUrl: 'http://127.0.0.1:8091',
    onBargeIn: (reason) => bargeIns.push(reason),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ text: 'hi', language: 'ja', confidence: 0.9 });
      }
    })
  });

  const request = createMockRequest({
    method: 'POST',
    url: '/api/operator/asr?lang=ja',
    headers: { 'content-type': 'audio/webm' },
    body: Buffer.from('sample-audio')
  });
  const response = createMockResponse();

  await proxy.handleHttpRequest(request, response);
  assert.deepEqual(bargeIns, ['operator_ptt']);
});

test('operator ASR proxy does not invoke onBargeIn for non-ASR paths', async () => {
  const bargeIns = [];
  const proxy = createOperatorAsrProxy({
    baseUrl: 'http://127.0.0.1:8091',
    onBargeIn: (reason) => bargeIns.push(reason),
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '{}'; } })
  });

  const request = createMockRequest({ method: 'POST', url: '/api/other', headers: {}, body: '' });
  const response = createMockResponse();

  const handled = await proxy.handleHttpRequest(request, response);
  assert.equal(handled, false);
  assert.deepEqual(bargeIns, []);
});

test('operator ASR proxy still responds if onBargeIn throws', async () => {
  const proxy = createOperatorAsrProxy({
    baseUrl: 'http://127.0.0.1:8091',
    onBargeIn: () => { throw new Error('boom'); },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ text: 'ok', language: 'ja', confidence: 0.8 });
      }
    })
  });

  const request = createMockRequest({
    method: 'POST',
    url: '/api/operator/asr?lang=ja',
    headers: { 'content-type': 'audio/webm' },
    body: Buffer.from('audio')
  });
  const response = createMockResponse();

  const handled = await proxy.handleHttpRequest(request, response);
  assert.equal(handled, true);
  assert.equal(response.result().statusCode, 200);
});


test('fixed ack chooses Japanese and English accepted phrases and variants', () => {
  assert.deepEqual(chooseFixedAck({ language: 'ja', kind: 'accepted' }), {
    language: 'ja',
    kind: 'accepted',
    text: '確認します。'
  });
  assert.deepEqual(chooseFixedAck({ language: 'ja', kind: 'accepted', index: 1 }), {
    language: 'ja',
    kind: 'accepted',
    text: '少々お待ちください。'
  });
  assert.deepEqual(chooseFixedAck({ language: 'en-US', kind: 'accepted' }), {
    language: 'en',
    kind: 'accepted',
    text: 'Checking.'
  });
  assert.deepEqual(chooseFixedAck({ language: 'en-US', kind: 'accepted', index: 1 }), {
    language: 'en',
    kind: 'accepted',
    text: 'One moment.'
  });
  assert.equal(chooseFixedAck({ language: 'ja', kind: 'accepted', index: 2 }).text, '確認しますね。');
  assert.equal(chooseFixedAck({ language: 'ja', kind: 'accepted', index: 9 }).text, '受け取りました。');
  assert.equal(chooseFixedAck({ language: 'ja', kind: 'accepted', index: 10 }).text, '確認します。');
  assert.equal(chooseFixedAck({ language: 'en', kind: 'accepted', index: 2 }).text, 'Let me check.');
  assert.equal(chooseFixedAck({ language: 'en', kind: 'accepted', index: 9 }).text, 'Received.');
  assert.equal(chooseFixedAck({ language: 'en', kind: 'accepted', index: 10 }).text, 'Checking.');
});

test('operator ASR proxy invokes onAcceptedSpeech after successful ASR', async () => {
  const accepted = [];
  const proxy = createOperatorAsrProxy({
    baseUrl: 'http://127.0.0.1:8091',
    onAcceptedSpeech: (payload) => accepted.push(payload),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ text: '了解', language: 'ja', confidence: 0.88 });
      }
    })
  });

  const request = createMockRequest({
    method: 'POST',
    url: '/api/operator/asr?lang=ja',
    headers: { 'content-type': 'audio/wav' },
    body: Buffer.from('audio')
  });
  const response = createMockResponse();

  await proxy.handleHttpRequest(request, response);
  assert.equal(response.result().statusCode, 200);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].text, '了解');
  assert.equal(accepted[0].language, 'ja');
  assert.equal(accepted[0].requestedLanguage, 'ja');
  assert.equal(accepted[0].source, 'operator_asr_proxy');
});

test('operator ASR proxy does not invoke onAcceptedSpeech on invalid ASR response', async () => {
  const accepted = [];
  const proxy = createOperatorAsrProxy({
    baseUrl: 'http://127.0.0.1:8091',
    onAcceptedSpeech: (payload) => accepted.push(payload),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ text: '', language: 'en' });
      }
    })
  });

  const request = createMockRequest({
    method: 'POST',
    url: '/api/operator/asr?lang=en',
    headers: { 'content-type': 'audio/wav' },
    body: Buffer.from('audio')
  });
  const response = createMockResponse();

  await proxy.handleHttpRequest(request, response);
  assert.equal(response.result().statusCode, 502);
  assert.deepEqual(accepted, []);
});
