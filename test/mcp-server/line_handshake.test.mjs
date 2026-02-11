import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';

function parseJsonLine(buffer) {
  const newline = buffer.indexOf('\n');
  if (newline === -1) {
    return null;
  }
  const line = buffer.subarray(0, newline).toString('utf8').trim();
  if (line === '') {
    return null;
  }
  return JSON.parse(line);
}

test('mcp server returns initialize response as json line when request is json line', async () => {
  const serverPath = path.resolve(process.cwd(), 'mcp-server/dist/index.js');
  const child = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  child.stderr.resume();

  const response = await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      reject(new Error('timed out waiting initialize response'));
    }, 2000);

    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseJsonLine(buffer);
      if (!parsed) {
        return;
      }
      clearTimeout(timeout);
      resolve(parsed);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'line-test', version: '0.0.0' }
      }
    });
    child.stdin.write(`${request}\n`);
  });

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, 'minimum-headroom');

  child.kill('SIGTERM');
});
