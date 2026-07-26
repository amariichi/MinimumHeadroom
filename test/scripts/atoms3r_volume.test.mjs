import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repoRoot, 'scripts/atoms3r-volume.mjs');
const isolatedEnv = {
  ...process.env,
  ATOM_HEADROOM_AUTH_TOKEN: '',
  ATOM_HEADROOM_URL: 'auto',
  MH_FACE_AUTH_TOKEN: '',
  MH_SHARED_ENV_FILE: path.join(repoRoot, '.nonexistent-atoms3r-volume-test-env'),
  ATOM_HEADROOM_DISCOVERY: '0',
};

function run(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: { ...isolatedEnv, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('dry-run resolves faced-Atom presets without network access', async () => {
  const result = await run(['--preset', 'outdoor', '--dry-run']);

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.url, 'auto');
  assert.equal(payload.speaker_volume, 160);
  assert.equal(payload.preset, 'outdoor');
  assert.equal(payload.persistent, false);
});

test('volume and preset are mutually exclusive', async () => {
  const result = await run(['--volume', '112', '--preset', 'indoor', '--dry-run']);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /exactly one/);
});

test('runtime volume accepts 200 and rejects the noisy range above it', async () => {
  const maximum = await run(['--volume', '200', '--dry-run']);
  const tooHigh = await run(['--volume', '201', '--dry-run']);

  assert.equal(maximum.code, 0, maximum.stderr);
  assert.equal(JSON.parse(maximum.stdout).speaker_volume, 200);
  assert.equal(tooHigh.code, 1);
  assert.match(tooHigh.stderr, /integer between 0 and 200/);
});

test('authenticated runtime change is verified through Atom health', async (t) => {
  let volume = 112;
  let healthRequests = 0;
  let volumeRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      healthRequests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        service: 'atoms3r-headroom',
        device_id: 'atom-headroom-1',
        speaker_volume: volume,
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/headroom/volume') {
      volumeRequests += 1;
      assert.equal(request.headers['x-headroom-auth'], 'test-secret');
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const payload = JSON.parse(body);
        volume = payload.volume;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          ok: true,
          speaker_volume: volume,
          persistent: false,
        }));
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const result = await run([
    '--url', `http://127.0.0.1:${address.port}`,
    '--token', 'test-secret',
    '--volume', '160',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /speaker volume 112 -> 160/);
  assert.match(result.stdout, /saved reboot baseline unchanged/);
  assert.doesNotMatch(result.stdout + result.stderr, /test-secret/);
  assert.equal(volume, 160);
  assert.equal(healthRequests, 2);
  assert.equal(volumeRequests, 1);
});
