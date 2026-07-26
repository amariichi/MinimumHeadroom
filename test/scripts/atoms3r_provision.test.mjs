import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repoRoot, 'scripts/atoms3r-provision.mjs');
const fakeSerial = path.join(repoRoot, 'test/fixtures/fake_atoms3r_serial.py');
const isolatedEnv = {
  ...process.env,
  MH_FACE_AUTH_TOKEN: '',
  MH_SHARED_ENV_FILE: path.join(repoRoot, '.nonexistent-atoms3r-provision-test-env'),
};

function runWithEnv(extraEnv, ...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...isolatedEnv, ...extraEnv },
  });
}

function run(...args) {
  return runWithEnv({}, ...args);
}

function readFirstLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline).trim());
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`fake serial ended before publishing a port: ${buffer}`));
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.on('error', onError);
    stream.on('end', onEnd);
  });
}

test('dry run emits the minimum supported playback cooldown', () => {
  const result = run('--vad-playback-cooldown-ms', '200', '--dry-run');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"vad_playback_cooldown_ms":200/);
  assert.match(result.stdout, /dry-run: port not opened/);
});

test('playback cooldown below the supported range is rejected', () => {
  const result = run('--vad-playback-cooldown-ms', '199', '--dry-run');

  assert.equal(result.status, 2);
  assert.match(result.stderr, /integer between 200 and 5000/);
});

test('playback cooldown above the supported range is rejected', () => {
  const result = run('--vad-playback-cooldown-ms', '5001', '--dry-run');

  assert.equal(result.status, 2);
  assert.match(result.stderr, /integer between 200 and 5000/);
});

test('persistent speaker volume accepts the safe Atom range', () => {
  const muted = run('--speaker-volume', '0', '--dry-run');
  const maximum = run('--speaker-volume', '200', '--dry-run');

  assert.equal(muted.status, 0, muted.stderr);
  assert.match(muted.stdout, /"speaker_volume":0/);
  assert.equal(maximum.status, 0, maximum.stderr);
  assert.match(maximum.stdout, /"speaker_volume":200/);
});

test('persistent speaker volume rejects values outside 0 through 200', () => {
  const result = run('--speaker-volume', '201', '--dry-run');

  assert.equal(result.status, 2);
  assert.match(result.stderr, /integer between 0 and 200/);
});

test('serial ready handshake retries only the harmless query and sends configuration once', async (t) => {
  const fake = spawn('python3', [fakeSerial], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fakeStderr = '';
  fake.stderr.on('data', (chunk) => { fakeStderr += chunk.toString('utf8'); });
  t.after(() => {
    if (fake.exitCode === null && fake.signalCode === null) fake.kill();
  });

  const port = await Promise.race([
    readFirstLine(fake.stdout),
    wait(2000).then(() => { throw new Error(`fake serial did not start: ${fakeStderr}`); }),
  ]);
  const fakeExit = new Promise((resolve) => {
    fake.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const result = runWithEnv(
    {
      MH_ATOM_SERIAL_SETTLE_MS: '10',
      MH_ATOM_SERIAL_PROBE_INTERVAL_MS: '25',
      MH_ATOM_SERIAL_POLL_MS: '5',
    },
    '--port', port,
    '--vad-encoding', 'ima_adpcm',
    '--token', '',
    '--timeout-ms', '1200',
  );
  const fakeResult = await Promise.race([
    fakeExit,
    wait(2000).then(() => ({ code: null, signal: 'test-timeout' })),
  ]);

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${fakeStderr}`);
  assert.match(result.stdout, /atom ready: RMHCFG STATE/);
  assert.match(result.stdout, /atom: RMHCFG OK saved/);
  assert.match(result.stdout, /atom state: RMHCFG STATE/);
  assert.equal(fakeResult.code, 0, `${JSON.stringify(fakeResult)} ${fakeStderr}`);
  assert.match(fakeStderr, /queries=3 configs=1/);
});
