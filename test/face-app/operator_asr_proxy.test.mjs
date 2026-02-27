import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createOperatorAsrProxy } from '../../face-app/dist/operator_asr_proxy.js';

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
