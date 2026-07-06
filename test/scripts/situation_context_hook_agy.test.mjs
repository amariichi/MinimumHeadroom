import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import {
  buildAgyPreInvocationOutput,
  extractConversationId,
  runAgySituationContextHook
} from '../../scripts/situation-context-hook-agy.mjs';

function runHook({ input = '', env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/situation-context-hook-agy.mjs'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function withSituationTextServer(callback) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'x-situation-watermark': '2026-07-06T10:00:00+09:00'
    });
    response.end('[カメラ 10:00] 机の上にマグカップが見える。');
  });
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1');
    server.on('listening', resolve);
    server.on('error', reject);
  });
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    await callback(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('agy situation hook wraps the digest as a PreInvocation ephemeralMessage', async () => {
  await withSituationTextServer(async (baseUrl, requests) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mh-agy-situation-'));
    try {
      const result = await runHook({
        input: JSON.stringify({ invocationNum: 1, conversationId: 'conv-42' }),
        env: {
          MH_SITUATION_INJECT: '1',
          VISION_BASE_URL: baseUrl,
          XDG_RUNTIME_DIR: tmp
        }
      });
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      const payload = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(payload), ['injectSteps']);
      assert.equal(payload.injectSteps.length, 1);
      assert.match(payload.injectSteps[0].ephemeralMessage, /\[カメラ 10:00\]/);
      assert.equal(requests.length, 1);
      assert.match(requests[0].url, /format=text/);

      // The watermark state must be keyed by the agy conversation id so the
      // per-invocation hook does not restart the watermark every call.
      const stateFiles = await readdir(path.join(tmp, 'minimum-headroom-situation'));
      assert.ok(
        stateFiles.includes('watermark-agy-conv-42'),
        `expected watermark-agy-conv-42 in ${stateFiles.join(', ')}`
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

test('agy situation hook prints an empty JSON object when injection is disabled', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mh-agy-situation-'));
  try {
    const result = await runHook({
      input: JSON.stringify({ invocationNum: 1, conversationId: 'conv-42' }),
      env: {
        MH_SITUATION_INJECT: '0',
        XDG_RUNTIME_DIR: tmp
      }
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), '{}');
    assert.equal(result.stderr, '');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('agy situation hook tolerates non-JSON stdin', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mh-agy-situation-'));
  try {
    const result = await runHook({
      input: 'not json at all',
      env: {
        MH_SITUATION_INJECT: '0',
        XDG_RUNTIME_DIR: tmp
      }
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), '{}');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('extractConversationId reads camelCase protojson payloads', () => {
  assert.equal(extractConversationId('{"conversationId":"abc"}'), 'abc');
  assert.equal(extractConversationId('{"conversationId":"  "}'), null);
  assert.equal(extractConversationId('{"other":1}'), null);
  assert.equal(extractConversationId('garbage'), null);
});

test('buildAgyPreInvocationOutput trims and rejects empty digests', () => {
  assert.equal(buildAgyPreInvocationOutput(''), null);
  assert.equal(buildAgyPreInvocationOutput('   \n'), null);
  assert.deepEqual(buildAgyPreInvocationOutput('[カメラ] test\n'), {
    injectSteps: [{ ephemeralMessage: '[カメラ] test' }]
  });
});

test('runAgySituationContextHook passes the session key env to the plain hook', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mh-agy-situation-'));
  try {
    const fakeHook = path.join(tmp, 'fake-hook.sh');
    await writeFile(fakeHook, '#!/bin/sh\nprintf \'key=%s\' "$MH_SITUATION_SESSION_KEY"\n', 'utf8');
    await chmod(fakeHook, 0o755);
    let stdout = '';
    const output = await runAgySituationContextHook({
      input: JSON.stringify({ conversationId: 'conv-77' }),
      env: { PATH: process.env.PATH },
      hookPath: fakeHook,
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: () => {} }
    });
    assert.deepEqual(output, { injectSteps: [{ ephemeralMessage: 'key=agy-conv-77' }] });
    assert.equal(JSON.parse(stdout).injectSteps[0].ephemeralMessage, 'key=agy-conv-77');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
