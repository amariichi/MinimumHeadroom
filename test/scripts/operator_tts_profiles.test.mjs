import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');

function run(script, args = []) {
  return spawnSync(script, args, {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8'
  });
}

function assertOperatorProfiles(script) {
  const result = run(script, ['--list-profiles']);
  assert.equal(result.status, 0, result.stderr);
  for (const profile of [
    'default',
    'realtime',
    'supertonic',
    'supertonic-realtime',
    'qwen3',
    'qwen3-realtime'
  ]) {
    assert.match(result.stdout, new RegExp(`(^|\\s)${profile}(\\s|$)`, 'm'));
  }
}

test('initial Operator launcher lists optional Supertonic profiles', () => {
  assertOperatorProfiles('./scripts/run-operator-once.sh');
});

test('in-place Operator restart lists the same optional Supertonic profiles', () => {
  assertOperatorProfiles('./scripts/restart-operator-stack-in-place.sh');
});

test('allowlisted runtime Operator wrapper lists the same profiles', () => {
  const result = run('./scripts/run-operator-profile.sh', ['--list-profiles']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'default',
    'realtime',
    'supertonic',
    'supertonic-realtime',
    'qwen3',
    'qwen3-realtime'
  ]);
});

test('Operator launchers map Supertonic profiles to the Supertonic engine', () => {
  for (const file of [
    'scripts/run-operator-once.sh',
    'scripts/restart-operator-stack-in-place.sh'
  ]) {
    const source = readFileSync(path.join(repoRoot, file), 'utf8');
    assert.match(
      source,
      /append_env "MH_AGENT_TMUX_SESSION" "\$SESSION_NAME"/u
    );
    assert.match(
      source,
      /supertonic\)\s+if .*?STACK_CMD="TTS_ENGINE=supertonic \.\/scripts\/run-operator-stack\.sh"/s
    );
    assert.match(
      source,
      /supertonic-realtime\)\s+if .*?STACK_CMD="TTS_ENGINE=supertonic MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 \.\/scripts\/run-operator-stack\.sh"/s
    );
  }
});

test('initial Operator launcher records a nonsecret two-pane runtime recipe', () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'mh-operator-runtime-'));
  try {
    const fakeTmux = path.join(fakeBin, 'tmux');
    const tmuxLog = path.join(fakeBin, 'tmux.log');
    writeFileSync(
      fakeTmux,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$MH_TEST_TMUX_LOG"',
        'case "$1" in',
        '  has-session) exit 1 ;;',
        '  display-message)',
        '    if [[ "$*" == *".1"* ]]; then printf "%%2\\n"; else printf "%%1\\n"; fi',
        '    ;;',
        'esac',
        ''
      ].join('\n')
    );
    chmodSync(fakeTmux, 0o755);
    const result = spawnSync(
      './scripts/run-operator-once.sh',
      [
        '--profile', 'default',
        '--agent-cmd', 'bash',
        '--ui-mode', 'auto',
        '--audio-target', 'browser',
        '--no-attach'
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          MH_TEST_TMUX_LOG: tmuxLog,
          MH_ENV_FILE: path.join(fakeBin, 'missing.env'),
          TMUX: ''
        },
        encoding: 'utf8'
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(tmuxLog, 'utf8');
    assert.match(
      calls,
      /set-option -w -t agent:operator @minimum_headroom_runtime_shell_pane %1/u
    );
    assert.match(
      calls,
      /set-option -w -t agent:operator @minimum_headroom_runtime_stack_pane %2/u
    );
    assert.match(
      calls,
      /set-option -w -t agent:operator @minimum_headroom_runtime_mode operator/u
    );
    assert.match(
      calls,
      /set-option -w -t agent:operator @minimum_headroom_runtime_operator_profile default/u
    );
    assert.match(calls, /MH_RUNTIME_ACTIVE_MODE=operator/u);
    assert.match(calls, /MH_RUNTIME_OPERATOR_PROFILE=default/u);
    assert.match(calls, /MH_AGENT_TMUX_SESSION=agent/u);
    assert.doesNotMatch(calls, /AUTH_TOKEN|secret/u);
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('general setup advertises Supertonic as optional and dedicated setup remains dry-run safe', () => {
  const help = run('./scripts/setup.sh', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--with-supertonic/);

  const preview = run('./scripts/setup-supertonic.sh', ['--dry-run']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /supertonic==1\.3\.1/);
  assert.match(preview.stdout, /prefetch approximately 400 MB/);

  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
  );
  assert.equal(
    packageJson.scripts['setup:supertonic'],
    './scripts/setup-supertonic.sh'
  );
});
