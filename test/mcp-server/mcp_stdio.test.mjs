import assert from 'node:assert/strict';
import test from 'node:test';
import { createFramedMessageParser } from '../../mcp-server/dist/mcp_stdio.js';

function frame(message, separator) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}${separator}${body}`;
}

test('mcp stdio parser accepts CRLF header terminator', () => {
  const messages = [];
  const parse = createFramedMessageParser((message) => {
    messages.push(message);
  });

  parse(Buffer.from(frame({ jsonrpc: '2.0', id: 1, method: 'initialize' }, '\r\n\r\n'), 'utf8'));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].method, 'initialize');
});

test('mcp stdio parser accepts LF header terminator', () => {
  const messages = [];
  const parse = createFramedMessageParser((message) => {
    messages.push(message);
  });

  parse(Buffer.from(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, '\n\n'), 'utf8'));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].method, 'tools/list');
});

test('mcp stdio parser handles chunked LF framed payloads', () => {
  const messages = [];
  const parse = createFramedMessageParser((message) => {
    messages.push(message);
  });

  const payload = frame({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'face.ping' } }, '\n\n');
  const bytes = Buffer.from(payload, 'utf8');
  const firstChunk = bytes.subarray(0, 18);
  const secondChunk = bytes.subarray(18);

  parse(firstChunk);
  assert.equal(messages.length, 0);

  parse(secondChunk);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].method, 'tools/call');
  assert.equal(messages[0].params.name, 'face.ping');
});

test('mcp stdio parser accepts json-line payloads without Content-Length', () => {
  const messages = [];
  const parse = createFramedMessageParser((message) => {
    messages.push(message);
  });

  parse(Buffer.from('{"jsonrpc":"2.0","id":4,"method":"initialize"}\n', 'utf8'));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 4);
  assert.equal(messages[0].method, 'initialize');
});

test('mcp stdio parser accepts chunked json-line payloads without Content-Length', () => {
  const messages = [];
  const parse = createFramedMessageParser((message) => {
    messages.push(message);
  });

  parse(Buffer.from('{"jsonrpc":"2.0","id":5,', 'utf8'));
  assert.equal(messages.length, 0);

  parse(Buffer.from('"method":"tools/list"}\n', 'utf8'));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 5);
  assert.equal(messages[0].method, 'tools/list');
});
