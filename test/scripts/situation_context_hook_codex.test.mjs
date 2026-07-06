import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';

function runHook({ input = '', env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/situation-context-hook-codex.mjs'], {
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
      'x-situation-watermark': '2026-07-04T10:00:00+09:00'
    });
    response.end('[カメラ 10:00] 机の上にモニターとキーボードが見える。');
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

test('codex situation hook wraps situation text as UserPromptSubmit additionalContext JSON', async () => {
  await withSituationTextServer(async (baseUrl, requests) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mh-codex-situation-'));
    try {
      const result = await runHook({
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: '今見える?' }),
        env: {
          MH_SITUATION_INJECT: '1',
          VISION_BASE_URL: baseUrl,
          XDG_RUNTIME_DIR: tmp,
          MH_FACE_SESSION_ID: 'codex-wrapper-test'
        }
      });
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      const payload = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(payload), ['hookSpecificOutput']);
      assert.equal(payload.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      assert.match(payload.hookSpecificOutput.additionalContext, /\[カメラ 10:00\]/);
      assert.equal(requests.length, 1);
      assert.match(requests[0].url, /format=text/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

test('codex situation hook emits empty stdout when the plain hook has no context', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'mh-codex-situation-'));
  try {
    const result = await runHook({
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' }),
      env: {
        MH_SITUATION_INJECT: '0',
        XDG_RUNTIME_DIR: tmp
      }
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
