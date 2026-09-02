import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');
const isolatedEnvFile = path.join(
  tmpdir(),
  `minimum-headroom-test-missing-${process.pid}.env`
);

function runScript(args, env = {}) {
  return spawnSync('./scripts/run-interpreter-stack.sh', args, {
    cwd: repoRoot,
    env: { ...process.env, MH_ENV_FILE: isolatedEnvFile, ...env },
    encoding: 'utf8'
  });
}

function runOnce(args, env = {}, unsetKeys = []) {
  const childEnv = {
    ...process.env,
    MH_ENV_FILE: isolatedEnvFile,
    ...env
  };
  for (const key of unsetKeys) {
    delete childEnv[key];
  }
  return spawnSync('./scripts/run-interpreter-once.sh', args, {
    cwd: repoRoot,
    env: childEnv,
    encoding: 'utf8'
  });
}

function runRestart(args, env = {}) {
  return spawnSync('./scripts/restart-interpreter-stack-in-place.sh', args, {
    cwd: repoRoot,
    env: { ...process.env, MH_ENV_FILE: isolatedEnvFile, ...env },
    encoding: 'utf8'
  });
}

function runSetup(args, env = {}) {
  return spawnSync('./scripts/setup-interpreter-stack.sh', args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      MH_ENV_FILE: isolatedEnvFile,
      GEMMA4_MODEL_DIR: path.join(repoRoot, '.test-missing-gemma-runtime'),
      GEMMA4_ASSISTANT_SOURCE_DIR: path.join(repoRoot, '.test-missing-gemma-assistant'),
      LLAMA_CPP_DIR: path.join(repoRoot, '.test-missing-llama-cpp'),
      ...env
    },
    encoding: 'utf8'
  });
}

function runSmoke(args, env = {}) {
  return spawnSync('./scripts/smoke-interpreter-stack.sh', args, {
    cwd: repoRoot,
    env: { ...process.env, MH_ENV_FILE: isolatedEnvFile, ...env },
    encoding: 'utf8'
  });
}

function runMtpBenchmark(args, env = {}) {
  return spawnSync('./scripts/benchmark-gemma4-mtp.sh', args, {
    cwd: repoRoot,
    env: { ...process.env, MH_ENV_FILE: isolatedEnvFile, ...env },
    encoding: 'utf8'
  });
}

function runCorpusGenerator(args, env = {}) {
  return spawnSync('node', ['scripts/generate-interpreter-corpus.mjs', ...args], {
    cwd: repoRoot,
    env: { ...process.env, MH_ENV_FILE: isolatedEnvFile, ...env },
    encoding: 'utf8'
  });
}

function runCorpusBenchmark(args, env = {}) {
  return spawnSync('./scripts/benchmark-interpreter-corpus.sh', args, {
    cwd: repoRoot,
    env: { ...process.env, MH_ENV_FILE: isolatedEnvFile, ...env },
    encoding: 'utf8'
  });
}

function runDoctor(args, env = {}) {
  return spawnSync('./scripts/interpreter-doctor.sh', args, {
    cwd: repoRoot,
    env: { ...process.env, MH_ENV_FILE: isolatedEnvFile, ...env },
    encoding: 'utf8'
  });
}

test('interpreter stack lists exactly the four local presets', () => {
  const result = runScript(['--list-presets']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'gemma4-supertonic',
    'gemma4-qwen3',
    'nemotron-gemma4-supertonic',
    'nemotron-gemma4-qwen3'
  ]);
});

test('deprecated light-cloud dry-run resolves to local Nemotron, Gemma, and Supertonic', () => {
  const result = runScript(['--preset', 'light-cloud', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /light-cloud is deprecated/u);
  assert.match(result.stdout, /preset=nemotron-gemma4-supertonic/u);
  assert.match(result.stdout, /run-nemotron-asr/);
  assert.match(result.stdout, /run-gemma4-interpreter/);
  assert.match(result.stdout, /intent=gemma4 translation=gemma4/u);
  assert.match(result.stdout, /tts=supertonic/);
  assert.doesNotMatch(result.stdout, /tts=qwen3/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /agy-gemini|gemini-3\.\d/u);
  assert.match(result.stdout, /atom_tts_codec=auto/);
});

test('Gemma dry-runs select only their requested TTS engine and default MTP off', () => {
  const supertonic = runScript(
    ['--preset', 'gemma4-supertonic', '--dry-run'],
    { GEMMA4_MTP: '' }
  );
  assert.equal(supertonic.status, 0, supertonic.stderr);
  assert.match(supertonic.stdout, /tts=supertonic/);
  assert.match(supertonic.stdout, /GEMMA4_MTP=off/);

  const qwen = runScript(
    ['--preset', 'gemma4-qwen3', '--dry-run'],
    { GEMMA4_MTP: 'on' }
  );
  assert.equal(qwen.status, 0, qwen.stderr);
  assert.match(qwen.stdout, /tts=qwen3/);
  assert.match(qwen.stdout, /GEMMA4_MTP=on/);
  assert.match(qwen.stdout, /GEMMA4_INTERPRETER_DRAFT_TOKENS=8/);
});

test('interpreter Web/API defaults to the shared exclusive port 8765', () => {
  const result = runScript(
    ['--preset', 'gemma4-supertonic', '--dry-run'],
    {
      INTERPRETER_HOST: '',
      INTERPRETER_PORT: ''
    }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ui=http:\/\/127\.0\.0\.1:8765\//u);
  assert.match(
    result.stdout,
    /atoms3r-http-bridge\.mjs -> ws:\/\/127\.0\.0\.1:8765\/ws/u
  );
});

test('Nemotron hybrid dry-runs start both ASR and Gemma with the selected TTS', () => {
  const supertonic = runScript([
    '--preset', 'nemotron-gemma4-supertonic', '--dry-run'
  ]);
  assert.equal(supertonic.status, 0, supertonic.stderr);
  assert.match(supertonic.stdout, /run-nemotron-asr/u);
  assert.match(supertonic.stdout, /run-gemma4-interpreter/u);
  assert.match(supertonic.stdout, /tts=supertonic/u);

  const qwen = runScript([
    '--preset', 'nemotron-gemma4-qwen3', '--dry-run'
  ]);
  assert.equal(qwen.status, 0, qwen.stderr);
  assert.match(qwen.stdout, /run-nemotron-asr/u);
  assert.match(qwen.stdout, /run-gemma4-interpreter/u);
  assert.match(qwen.stdout, /tts=qwen3/u);
});

test('interpreter stack rejects an operator profile', () => {
  const result = runScript(['--preset', 'default', '--dry-run']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsupported preset/);
});

test('interpreter stack validates the startup-only Atom TTS codec mode', () => {
  const valid = runScript(
    ['--preset', 'light-cloud', '--dry-run'],
    { MH_ATOM_TTS_CODEC: 'ima_adpcm' }
  );
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /atom_tts_codec=ima_adpcm/);

  const invalid = runScript(
    ['--preset', 'light-cloud', '--dry-run'],
    { MH_ATOM_TTS_CODEC: 'opus' }
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /must be auto, pcm16, or ima_adpcm/);
});

test('interpreter stack validates the bounded port-release wait', () => {
  const invalid = runScript(
    ['--preset', 'light-cloud', '--dry-run'],
    { MH_INTERPRETER_PORT_RELEASE_WAIT_SECONDS: 'soon' }
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /must be a non-negative integer/);
});

test('interpreter stack refuses an occupied port before starting a model', () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'mh-interpreter-ss-'));
  try {
    const fakeSs = path.join(fakeBin, 'ss');
    const fakeRg = path.join(fakeBin, 'rg');
    writeFileSync(
      fakeSs,
      '#!/usr/bin/env bash\nprintf "LISTEN 0 128 127.0.0.1:8765 0.0.0.0:*\\n"\n'
    );
    writeFileSync(fakeRg, '#!/usr/bin/env bash\nexit 127\n');
    chmodSync(fakeSs, 0o755);
    chmodSync(fakeRg, 0o755);
    const result = runScript(['--preset', 'light-cloud'], {
      INTERPRETER_HOST: '127.0.0.1',
      INTERPRETER_PORT: '8765',
      PATH: `${fakeBin}:${process.env.PATH}`
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /port 8765 is already listening/);
    assert.doesNotMatch(result.stdout, /started nemotron/);
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('one-shot interpreter launcher creates a visible shell and stack workspace', () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'mh-interpreter-once-'));
  try {
    const fakeTmux = path.join(fakeBin, 'tmux');
    const tmuxLog = path.join(fakeBin, 'tmux.log');
    const testHome = path.join(fakeBin, 'home');
    const configDir = path.join(testHome, '.config');
    const envFile = path.join(configDir, 'minimum-headroom.env');
    const commandMarker = path.join(fakeBin, 'config-was-executed');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      envFile,
      [
        'INTERPRETER_HOST=127.0.0.1',
        'INTERPRETER_PORT=8766',
        'GEMMA4_MTP=off',
        'GEMMA4_INTERPRETER_DRAFT_TOKENS=4',
        'MH_INTERPRETER_AUTH_TOKEN=test-interpreter-token',
        'MH_SUPERTONIC_VOICE=M1',
        `MH_INTERPRETER_TEST_LITERAL=$(touch ${commandMarker})`,
        ''
      ].join('\n')
    );
    writeFileSync(
      fakeTmux,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$MH_TEST_TMUX_LOG"',
        'case "$1" in',
        '  has-session) exit 1 ;;',
        '  display-message) printf "%%1\\n" ;;',
        '  split-window) printf "%%2\\n" ;;',
        '  show-environment) printf "INTERPRETER_PORT=9999\\nGEMMA4_MTP=auto\\n" ;;',
        'esac',
        ''
      ].join('\n')
    );
    chmodSync(fakeTmux, 0o755);

    const result = runOnce(
      [
        '--preset', 'gemma4-supertonic',
        '--host', '0.0.0.0',
        '--port', '8765',
        '--gemma-mtp', 'on',
        '--draft-tokens', '8',
        '--supertonic-voice', 'F2'
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH}`,
        HOME: testHome,
        XDG_CONFIG_HOME: configDir,
        MH_ENV_FILE: '',
        MH_TEST_TMUX_LOG: tmuxLog,
        TMUX: ''
      },
      [
        'INTERPRETER_HOST',
        'INTERPRETER_PORT',
        'GEMMA4_MTP',
        'GEMMA4_INTERPRETER_DRAFT_TOKENS',
        'MH_INTERPRETER_AUTH_TOKEN',
        'MH_SUPERTONIC_VOICE'
      ]
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(commandMarker), false);
    assert.match(result.stdout, /shell pane=%1/);
    assert.match(result.stdout, /stack pane=%2/);
    assert.match(result.stdout, /config=.*minimum-headroom\.env/);

    const calls = readFileSync(tmuxLog, 'utf8');
    assert.match(
      calls,
      /new-session -d -s interpreter -n stack -c \S+/u
    );
    assert.match(
      calls,
      /respawn-pane -k -c \S+ -t %1 bash/u
    );
    assert.match(
      calls,
      /split-window -d -h -t %1 -c \S+ -P -F #\{pane_id\} exec \.\/scripts\/run-interpreter-stack\.sh --preset gemma4-supertonic/u
    );
    assert.match(
      calls,
      /set-option -w -t interpreter:stack @minimum_headroom_interpreter_shell_pane %1/u
    );
    assert.match(
      calls,
      /set-option -w -t interpreter:stack @minimum_headroom_interpreter_stack_pane %2/u
    );
    assert.match(
      calls,
      /set-option -w -t interpreter:stack @minimum_headroom_runtime_shell_pane %1/u
    );
    assert.match(
      calls,
      /set-option -w -t interpreter:stack @minimum_headroom_runtime_stack_pane %2/u
    );
    assert.match(
      calls,
      /set-option -w -t interpreter:stack @minimum_headroom_runtime_mode interpreter/u
    );
    assert.match(
      calls,
      /set-option -w -t interpreter:stack @minimum_headroom_runtime_interpreter_preset gemma4-supertonic/u
    );
    assert.match(calls, /select-layout -t interpreter:stack even-horizontal/u);
    assert.match(calls, /attach-session -t interpreter/u);

    assert.match(
      calls,
      /set-environment -t interpreter INTERPRETER_HOST 0\.0\.0\.0/u
    );
    assert.match(calls, /set-environment -u -t interpreter INTERPRETER_PORT/u);
    assert.match(calls, /set-environment -u -t interpreter GEMMA4_MTP/u);
    assert.match(
      calls,
      /set-environment -t interpreter INTERPRETER_PORT 8765/u
    );
    assert.doesNotMatch(
      calls,
      /set-environment -t interpreter INTERPRETER_PORT 8766/u
    );
    assert.match(
      calls,
      /set-environment -t interpreter GEMMA4_MTP on/u
    );
    assert.doesNotMatch(
      calls,
      /set-environment -t interpreter GEMMA4_MTP off/u
    );
    assert.match(
      calls,
      /set-environment -t interpreter GEMMA4_INTERPRETER_DRAFT_TOKENS 8/u
    );
    assert.doesNotMatch(
      calls,
      /set-environment -t interpreter GEMMA4_INTERPRETER_DRAFT_TOKENS 4/u
    );
    assert.match(
      calls,
      /set-environment -t interpreter MH_INTERPRETER_AUTH_TOKEN test-interpreter-token/u
    );
    assert.match(
      calls,
      /set-environment -t interpreter MH_SUPERTONIC_VOICE F2/u
    );
    assert.doesNotMatch(
      calls,
      /set-environment -t interpreter MH_SUPERTONIC_VOICE M1/u
    );
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('one-shot interpreter --no-attach leaves the two-pane session in background', () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'mh-interpreter-detach-'));
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
        '  display-message) printf "%%1\\n" ;;',
        '  split-window) printf "%%2\\n" ;;',
        '  show-environment) exit 0 ;;',
        'esac',
        ''
      ].join('\n')
    );
    chmodSync(fakeTmux, 0o755);
    const result = runOnce(['--preset', 'light-cloud', '--no-attach'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      MH_TEST_TMUX_LOG: tmuxLog,
      TMUX: ''
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /attach skipped \(--no-attach\)/);
    assert.match(result.stdout, /tmux attach -t interpreter/);
    const calls = readFileSync(tmuxLog, 'utf8');
    assert.doesNotMatch(calls, /attach-session|switch-client/u);
    assert.match(
      calls,
      /set-option -w -t interpreter:stack @minimum_headroom_interpreter_stack_pane %2/u
    );
    assert.match(
      calls,
      /set-option -w -t interpreter:stack @minimum_headroom_runtime_stack_pane %2/u
    );
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('in-place restart retains a failed pane and gives old listeners time to exit', () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'mh-interpreter-tmux-'));
  try {
    const fakeTmux = path.join(fakeBin, 'tmux');
    const tmuxLog = path.join(fakeBin, 'tmux.log');
    writeFileSync(
      fakeTmux,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$MH_TEST_TMUX_LOG"',
        'case "$1" in',
        '  list-panes) printf "%%1\\n%%2\\n" ;;',
        '  show-option) printf "%%2\\n" ;;',
        '  show-environment) exit 0 ;;',
        'esac',
        ''
      ].join('\n')
    );
    chmodSync(fakeTmux, 0o755);
    const result = runRestart(
      [
        '--preset', 'gemma4-supertonic',
        '--host', '0.0.0.0',
        '--port', '8765',
        '--gemma-mtp', 'on',
        '--draft-tokens', '8',
        '--supertonic-voice', 'F2'
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH}`,
        MH_TEST_TMUX_LOG: tmuxLog,
        MH_INTERPRETER_PORT_RELEASE_WAIT_SECONDS: '7',
        MH_ENV_FILE: isolatedEnvFile
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(tmuxLog, 'utf8');
    assert.match(
      calls,
      /set-option -w -t interpreter:stack remain-on-exit on/u
    );
    assert.match(
      calls,
      /set-environment -t interpreter MH_INTERPRETER_PORT_RELEASE_WAIT_SECONDS 7/u
    );
    assert.match(
      calls,
      /set-environment -t interpreter INTERPRETER_HOST 0\.0\.0\.0/u
    );
    assert.match(
      calls,
      /set-environment -t interpreter INTERPRETER_PORT 8765/u
    );
    assert.match(
      calls,
      /set-environment -t interpreter GEMMA4_MTP on/u
    );
    assert.match(
      calls,
      /set-environment -t interpreter GEMMA4_INTERPRETER_DRAFT_TOKENS 8/u
    );
    assert.match(
      calls,
      /set-environment -t interpreter MH_SUPERTONIC_VOICE F2/u
    );
    assert.match(
      calls,
      /set-option -w -t interpreter:stack @minimum_headroom_interpreter_stack_pane %2/u
    );
    assert.match(
      calls,
      /respawn-pane -k -c \S+ -t %2 exec \.\/scripts\/run-interpreter-stack\.sh --preset gemma4-supertonic/u
    );
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('in-place restart safely supports a legacy one-pane interpreter session', () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'mh-interpreter-legacy-'));
  try {
    const fakeTmux = path.join(fakeBin, 'tmux');
    const tmuxLog = path.join(fakeBin, 'tmux.log');
    writeFileSync(
      fakeTmux,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$MH_TEST_TMUX_LOG"',
        'case "$1" in',
        '  list-panes) printf "%%9\\n" ;;',
        '  show-option) exit 0 ;;',
        '  show-environment) printf "INTERPRETER_PORT=8765\\nGEMMA4_MTP=on\\n" ;;',
        'esac',
        ''
      ].join('\n')
    );
    chmodSync(fakeTmux, 0o755);
    const result = runRestart(['--preset', 'light-cloud'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      MH_TEST_TMUX_LOG: tmuxLog
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(tmuxLog, 'utf8');
    assert.doesNotMatch(calls, /set-environment -u/u);
    assert.match(
      calls,
      /set-option -w -t interpreter:stack @minimum_headroom_interpreter_stack_pane %9/u
    );
    assert.match(
      calls,
      /respawn-pane -k -c \S+ -t %9 exec \.\/scripts\/run-interpreter-stack\.sh --preset light-cloud/u
    );
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test('aggregate setup maps light-cloud to local Nemotron, Gemma, and Supertonic', () => {
  const result = runSetup(['--preset', 'light-cloud', '--dry-run'], {
    AGY_BIN: path.join(repoRoot, '.test-missing-agy')
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /light-cloud is deprecated/u);
  assert.match(result.stdout, /selected=nemotron-asr,gemma4,supertonic/u);
  assert.match(result.stdout, /setup-nemotron-asr/);
  assert.match(result.stdout, /librosa==0\.11\.0/);
  assert.match(result.stdout, /setup-gemma4-interpreter/);
  assert.match(result.stdout, /setup-supertonic/);
  assert.doesNotMatch(result.stdout, /setup-qwen3-tts/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /agy is required|agy-gemini/u);
});

test('aggregate setup dry-runs keep Gemma TTS choices isolated', () => {
  const supertonic = runSetup([
    '--preset', 'gemma4-supertonic', '--dry-run'
  ]);
  assert.equal(supertonic.status, 0, supertonic.stderr);
  assert.match(supertonic.stdout, /selected=gemma4,supertonic/);
  assert.match(supertonic.stdout, /setup-supertonic/);
  assert.doesNotMatch(supertonic.stdout, /setup-qwen3-tts/);
  assert.doesNotMatch(supertonic.stdout, /setup-nemotron-asr/);

  const qwen = runSetup([
    '--preset', 'gemma4-qwen3', '--dry-run'
  ]);
  assert.equal(qwen.status, 0, qwen.stderr);
  assert.match(qwen.stdout, /selected=gemma4,qwen3/);
  assert.match(qwen.stdout, /setup-qwen3-tts/);
  assert.doesNotMatch(qwen.stdout, /setup-supertonic/);
  assert.doesNotMatch(qwen.stdout, /setup-nemotron-asr/);
});

test('aggregate setup selects both models and only Qwen for the Nemotron Qwen preset', () => {
  const result = runSetup([
    '--preset', 'nemotron-gemma4-qwen3', '--dry-run'
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /selected=nemotron-asr,gemma4,qwen3/u);
  assert.match(result.stdout, /setup-nemotron-asr/u);
  assert.match(result.stdout, /setup-gemma4-interpreter/u);
  assert.match(result.stdout, /setup-qwen3-tts/u);
  assert.doesNotMatch(result.stdout, /setup-supertonic/u);
});

test('smoke dry-run stays loopback-only and disables the Atom bridge', () => {
  const result = runSmoke([
    '--preset', 'light-cloud',
    '--fixture', 'test/fixtures/interpreter/es-hola.wav',
    '--expect-source', 'es',
    '--expect-target', 'en',
    '--dry-run'
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MH_INTERPRETER_START_ATOM_BRIDGE=0/);
  assert.match(result.stdout, /--host 127\.0\.0\.1/);
  assert.match(result.stdout, /interpreter=18766/);
  assert.match(result.stdout, /stop only the recorded/);
});

test('Atom replay smoke dry-run uses WebSocket frames and can disable TTS', () => {
  const result = runSmoke([
    '--preset', 'gemma4-supertonic',
    '--input', 'atom-replay',
    '--disable-tts',
    '--fixture', '/path/to/es-station.wav',
    '--expect-source', 'es',
    '--expect-target', 'en',
    '--dry-run'
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /input=atom-replay tts_enabled=0/);
  assert.match(result.stdout, /MH_INTERPRETER_TTS_ENABLED=0/);
  assert.match(result.stdout, /node scripts\/atom-interpreter-replay\.mjs/);
  assert.match(result.stdout, /ws:\/\/127\.0\.0\.1:18766\/ws/);
  assert.match(result.stdout, /endpoint=atom/);
  assert.doesNotMatch(result.stdout, /POST one WAV/);
});

test('MTP benchmark dry-run compares off with every requested draft count', () => {
  const result = runMtpBenchmark([
    '--preset', 'gemma4-supertonic',
    '--cases', '/path/to/interpreter-cases.json',
    '--draft-tokens', '1,2,4,8,16',
    '--dry-run'
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /modes=off,mtp:1,2,4,8,16/);
  assert.match(result.stdout, /GEMMA4_MTP=off/);
  assert.match(result.stdout, /GEMMA4_INTERPRETER_DRAFT_TOKENS=1/);
  assert.match(result.stdout, /GEMMA4_INTERPRETER_DRAFT_TOKENS=2/);
  assert.match(result.stdout, /GEMMA4_INTERPRETER_DRAFT_TOKENS=4/);
  assert.match(result.stdout, /GEMMA4_INTERPRETER_DRAFT_TOKENS=8/);
  assert.match(result.stdout, /GEMMA4_INTERPRETER_DRAFT_TOKENS=16/);
  assert.match(result.stdout, /recommended=false/);
});

test('corpus generator dry-run validates cases without loading a model', () => {
  const result = runCorpusGenerator(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /corpus=supertonic-multilingual-v1 cases=8/);
  assert.match(result.stdout, /case=en-station language=en pipeline_target=none/);
  assert.match(result.stdout, /no model load and no file writes/);
});

test('corpus benchmark dry-run keeps TTS and Atom disabled', () => {
  const result = runCorpusBenchmark([
    '--cases', '/path/to/generated-corpus/manifest.json',
    '--presets', 'nemotron-gemma4-supertonic,gemma4-supertonic',
    '--gemma-mtp', 'off,on',
    '--runs', '1',
    '--warmup', '1',
    '--dry-run'
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /config=nemotron-gemma4-supertonic-mtp-off/);
  assert.match(result.stdout, /config=nemotron-gemma4-supertonic-mtp-on-draft-8/);
  assert.match(result.stdout, /config=gemma4-supertonic-mtp-off/);
  assert.match(result.stdout, /config=gemma4-supertonic-mtp-on-draft-8/);
  assert.match(result.stdout, /MH_INTERPRETER_TTS_ENABLED=0/);
  assert.match(result.stdout, /MH_INTERPRETER_START_ATOM_BRIDGE=0/);
  assert.match(result.stdout, /bind 127\.0\.0\.1/);
});

test('doctor does not require agy and does not label failed GPU probes as successful', () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'mh-interpreter-doctor-'));
  try {
    const fakeAgy = path.join(fakeBin, 'agy');
    const fakeNvidiaSmi = path.join(fakeBin, 'nvidia-smi');
    const fakeFfmpeg = path.join(fakeBin, 'ffmpeg-no-mp3');
    writeFileSync(
      fakeAgy,
      '#!/usr/bin/env bash\nprintf "probe blocked\\n"\nexit 1\n'
    );
    writeFileSync(
      fakeNvidiaSmi,
      '#!/usr/bin/env bash\nprintf "NVIDIA-SMI probe failed\\n"\nexit 1\n'
    );
    writeFileSync(
      fakeFfmpeg,
      '#!/usr/bin/env bash\nprintf "Encoders:\\n"\nexit 0\n'
    );
    chmodSync(fakeAgy, 0o755);
    chmodSync(fakeNvidiaSmi, 0o755);
    chmodSync(fakeFfmpeg, 0o755);
    const result = runDoctor(['--preset', 'light-cloud'], {
      AGY_BIN: fakeAgy,
      PATH: `${fakeBin}:${process.env.PATH}`,
      MH_INTERPRETER_FFMPEG_COMMAND: fakeFfmpeg,
      NEMOTRON_ASR_VENV: path.join(fakeBin, 'missing-nemotron'),
      SUPERTONIC_VENV: path.join(fakeBin, 'missing-supertonic'),
      NEMOTRON_ASR_CACHE_DIR: path.join(fakeBin, 'missing-cache'),
      SUPERTONIC_CACHE_DIR: path.join(fakeBin, 'missing-assets')
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /unable to query agy models|agy model is/u
    );
    assert.match(result.stdout, /GPU telemetry is unavailable/);
    assert.doesNotMatch(result.stdout, /\[ok\] GPU/);
    assert.match(result.stdout, /browser TTS MP3 encoder lacks libmp3lame/);
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});
