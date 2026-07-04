import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';

function runHook({ input = '', env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['scripts/vision-companion-context-hook.py'], {
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

async function withSituationServer(handler, callback) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    handler(request, response);
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

function situation(overview, change = '') {
  return {
    now: '2026-07-04T08:00:00+00:00',
    observing: true,
    current: {
      overview,
      stable_seconds: 3,
      stale: false
    },
    recent: change ? [{ at: '2026-07-04T08:00:00+00:00', overview, change }] : [],
    summaries: []
  };
}

test('vision companion hook emits nothing when disabled', async () => {
  let hit = false;
  await withSituationServer((request, response) => {
    hit = true;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(situation('机の上にマグカップがある。')));
  }, async (baseUrl) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mh-vision-brief-'));
    try {
      const result = await runHook({
        input: '今度はマグカップ',
        env: {
          MH_VISION_COMPANION: '0',
          VISION_BASE_URL: baseUrl,
          XDG_RUNTIME_DIR: tmp
        }
      });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, '');
      assert.equal(hit, false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

test('vision companion hook detects companion mode and visual topics', async () => {
  await withSituationServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(situation('机の上にマグカップと書類がある。')));
  }, async (baseUrl) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mh-vision-brief-'));
    try {
      const result = await runHook({
        input: '見えましたっていうだけなので、もうちょっと話ができるといいです。今度はマグカップ。',
        env: {
          MH_VISION_COMPANION: '1',
          VISION_BASE_URL: baseUrl,
          XDG_RUNTIME_DIR: tmp,
          MH_FACE_SESSION_ID: 'brief-test'
        }
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /\[共有視界ブリーフ\]/);
      assert.match(result.stdout, /会話モード: companion/);
      assert.match(result.stdout, /マグカップ/);
      assert.match(result.stdout, /推奨応答: answer_visual_question|推奨応答: relate_to_memory|推奨応答: smalltalk_about_scene/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

test('vision companion hook carries previous camera scene into delta', async () => {
  let overview = '机の上にヘッドホンがある。';
  await withSituationServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(situation(overview)));
  }, async (baseUrl) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mh-vision-brief-'));
    try {
      const env = {
        MH_VISION_COMPANION: '1',
        VISION_BASE_URL: baseUrl,
        XDG_RUNTIME_DIR: tmp,
        MH_FACE_SESSION_ID: 'brief-delta'
      };
      const first = await runHook({ input: '今、手元のヘッドホンを映しました。', env });
      assert.match(first.stdout, /ヘッドホン/);

      overview = '机の上にマグカップがある。';
      const second = await runHook({ input: '今度はマグカップ。', env });
      assert.match(second.stdout, /直前との差/);
      assert.match(second.stdout, /ヘッドホン/);
      assert.match(second.stdout, /マグカップ/);
      assert.match(second.stdout, /推奨応答: relate_to_memory/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

test('vision companion hook detects short correction', async () => {
  await withSituationServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(situation('広場にハトが一羽歩いている。')));
  }, async (baseUrl) => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'mh-vision-brief-'));
    try {
      const result = await runHook({
        input: '鳥居です。',
        env: {
          MH_VISION_COMPANION: '1',
          VISION_BASE_URL: baseUrl,
          XDG_RUNTIME_DIR: tmp,
          MH_FACE_SESSION_ID: 'brief-correction'
        }
      });
      assert.equal(result.code, 0);
      assert.match(result.stdout, /直近の訂正: 鳥居/);
      assert.match(result.stdout, /推奨応答: repair_misrecognition/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
