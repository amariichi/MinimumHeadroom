import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isSupportedNodeVersion, NODE_ENGINE_RANGE } from '../../scripts/check-node-version.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = name => readFileSync(path.join(repoRoot, name), 'utf8');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t, { rejectNode = false, stopInstall = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mh-install-requirements-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const log = path.join(root, 'uv.jsonl');
  const node = path.join(bin, 'node');
  writeFileSync(node, `#!/bin/sh\n${rejectNode ? 'exit 2' : `exec ${quote(process.execPath)} "$@"`}\n`);
  chmodSync(node, 0o755);
  const uv = path.join(bin, 'uv');
  writeFileSync(uv, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MH_TEST_INSTALL_LOG, JSON.stringify(args) + '\\n');
if (${stopInstall} && args[0] === 'pip' && args[1] === 'install') process.exit(77);
`);
  chmodSync(uv, 0o755);
  const venv = path.join(root, 'qwen environment');
  const cache = path.join(root, 'model-cache');
  const manifest = path.join(root, 'model-manifest.json');
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    QWEN3_TTS_VENV: venv,
    QWEN3_TTS_HF_HOME: cache,
    QWEN3_TTS_INSTALL_MANIFEST: manifest,
    MH_TEST_INSTALL_LOG: log
  };
  return {
    root, venv, cache, manifest,
    run: (script, args = []) => spawnSync(path.join(repoRoot, script), args, { cwd: repoRoot, env, encoding: 'utf8' }),
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []
  };
}

test('supported Node majors enforce their own security patch floors', () => {
  for (const version of ['22.23.4', 'v22.23.5', '22.24.0', '24.22.1', '24.22.2', '24.23.0', '26.12.1', '26.13.0']) {
    assert.equal(isSupportedNodeVersion(version), true, version);
  }
  for (const version of ['20.99.0', '22.23.3', '22.22.99', '23.99.0', '24.22.0', '24.21.99', '25.99.0', '26.12.0', '26.11.99', '27.0.0', '24.22', '24.22.1-rc.1', '24.22.1+custom', '024.22.1', '', null]) {
    assert.equal(isSupportedNodeVersion(version), false, String(version));
  }
});

test('installer Node rejection happens before dependency or model work', t => {
  const f = fixture(t, { rejectNode: true });
  for (const script of ['scripts/setup.sh', 'scripts/setup-qwen3-tts.sh']) {
    const result = f.run(script);
    assert.equal(result.status, 2, result.stderr);
  }
  assert.deepEqual(f.calls(), []);
  for (const target of [f.venv, f.cache, f.manifest]) assert.equal(existsSync(target), false);
});

test('Node CLI validation also runs when the checker is reached through a symlink', t => {
  const f = fixture(t);
  const link = path.join(f.root, 'linked-node-check.mjs');
  symlinkSync(path.join(repoRoot, 'scripts/check-node-version.mjs'), link);
  for (const flags of [[], ['--preserve-symlinks-main']]) {
    const result = spawnSync(process.execPath, [...flags, link], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[setup\] Node\.js /);
  }
});

test('new Qwen installation explicitly requests the patched Brotli with existing pins', t => {
  const f = fixture(t, { stopInstall: true });
  const result = f.run('scripts/setup-qwen3-tts.sh');
  assert.equal(result.status, 77, result.stderr);
  const calls = f.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'venv');
  assert.deepEqual(calls[1], [
    'pip', 'install', '--python', path.join(f.venv, 'bin/python'),
    'qwen-tts==0.1.1', 'torch==2.10.0', 'transformers==4.57.3',
    'brotli==1.2.1', 'numpy', 'sounddevice', 'soundfile'
  ]);
  assert.match(result.stdout, /brotli==1\.2\.1/);
  assert.equal(existsSync(f.cache), false);
  assert.equal(existsSync(f.manifest), false);
});

test('existing Qwen update changes only Brotli without rebuilding or running Python/model work', t => {
  const f = fixture(t, { rejectNode: true });
  mkdirSync(path.join(f.venv, 'bin'), { recursive: true });
  const python = path.join(f.venv, 'bin/python');
  writeFileSync(python, '#!/bin/sh\nexit 99\n');
  chmodSync(python, 0o755);
  const sentinel = path.join(f.venv, 'keep-existing-environment');
  writeFileSync(sentinel, 'preserved');
  const result = f.run('scripts/setup-qwen3-tts.sh', ['--update-brotli']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), [
    ['pip', 'install', '--python', python, '--no-deps', '--upgrade', 'brotli==1.2.1'],
    ['pip', 'check', '--python', python]
  ]);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserved');
  assert.equal(existsSync(f.cache), false);
  assert.equal(existsSync(f.manifest), false);
});

test('Qwen update refuses a missing environment instead of creating one', t => {
  const f = fixture(t);
  const result = f.run('scripts/setup-qwen3-tts.sh', ['--update-brotli']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /existing Qwen3 environment not found/);
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(f.venv), false);
});

test('Qwen install and update previews have no dependency or model side effects', t => {
  const f = fixture(t, { rejectNode: true });
  for (const args of [['--dry-run'], ['--update-brotli', '--dry-run']]) {
    const result = f.run('scripts/setup-qwen3-tts.sh', args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /brotli==1\.2\.1/);
  }
  assert.deepEqual(f.calls(), []);
  for (const target of [f.venv, f.cache, f.manifest]) assert.equal(existsSync(target), false);
});

test('the seven product version files and declared Node ranges stay consistent', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const version = pkg.version;
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  assert.equal(pkg.engines.node, NODE_ENGINE_RANGE);
  assert.equal(lock.packages[''].engines.node, NODE_ENGINE_RANGE);
  assert.equal(read('mcp-server/dist/index.js').match(/const SERVER_VERSION = '([^']+)'/)[1], version);
  assert.equal(read('tts-worker/pyproject.toml').match(/^version = "([^"]+)"/m)[1], version);
  assert.equal(read('tts-worker/uv.lock').match(/name = "minimum-headroom-tts-worker"\nversion = "([^"]+)"/)[1], version);
  for (const file of ['doc/examples/antigravity/plugin.json', 'examples/rmh-voice-mode/templates/antigravity-plugin/plugin.json']) {
    assert.equal(JSON.parse(read(file)).version, version, file);
  }
});
