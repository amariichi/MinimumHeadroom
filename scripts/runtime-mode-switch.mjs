#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { access, constants as fsConstants } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  RUNTIME_TMUX_OPTIONS,
  isRuntimeMode,
  isRuntimeSelection
} from '../face-app/dist/runtime_mode_config.js';

const execFileAsync = promisify(execFileCallback);
const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), '..');
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const INITIAL_RESPONSE_GRACE_MS = 400;

function trimmed(value) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : null;
}

function boundedInt(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function envAssignment(name, value) {
  return `${name}=${shellQuote(value)}`;
}

export function buildRuntimeStackCommand({ mode, selection, context }) {
  if (!isRuntimeMode(mode) || !isRuntimeSelection(mode, selection)) {
    throw new Error('invalid_runtime_target');
  }
  const host = context.bindHost ?? '127.0.0.1';
  const port = context.bindPort ?? '8765';
  if (mode === 'operator') {
    const assignments = [
      envAssignment('MH_RUNTIME_ACTIVE_MODE', 'operator'),
      envAssignment('MH_RUNTIME_OPERATOR_PROFILE', selection),
      envAssignment('MH_SKIP_ATOMS3R_BRIDGE', '1'),
      envAssignment('FACE_WS_HOST', host),
      envAssignment('FACE_WS_PORT', port),
      envAssignment('MH_BRIDGE_TMUX_PANE', context.shellPane),
      envAssignment('MH_BRIDGE_RECOVERY_TMUX_PANE', context.shellPane),
      envAssignment('MH_OPERATOR_FACE_AGENT_ID', '__operator__'),
      envAssignment('MH_OPERATOR_FACE_AGENT_LABEL', 'Operator'),
      envAssignment(
        'MH_AGENT_SOURCE_REPO_DEFAULT',
        context.agentRepoRoot ?? repoRoot
      ),
      envAssignment(
        'MH_AGENT_STREAM_ID',
        `repo:${context.agentRepoRoot ?? repoRoot}`
      ),
      envAssignment(
        'MH_AGENT_WORKTREES_ROOT',
        path.join(context.agentRepoRoot ?? repoRoot, '.agent/worktrees')
      ),
      envAssignment('MH_AGENT_TMUX_SESSION', context.tmuxSession ?? 'agent')
    ];
    if (context.operatorUiMode) {
      assignments.push(
        envAssignment('FACE_UI_MODE', context.operatorUiMode)
      );
    }
    if (context.operatorAudioTarget) {
      assignments.push(
        envAssignment('FACE_AUDIO_TARGET', context.operatorAudioTarget)
      );
    }
    if (context.operatorAsrDevice) {
      assignments.push(
        envAssignment('MH_ASR_DEVICE', context.operatorAsrDevice)
      );
    }
    if (context.operatorKokoroVoice) {
      assignments.push(
        envAssignment('MH_KOKORO_VOICE', context.operatorKokoroVoice)
      );
    }
    return [
      'exec env',
      ...assignments,
      shellQuote(path.join(repoRoot, 'scripts/run-operator-profile.sh')),
      '--profile',
      shellQuote(selection)
    ].join(' ');
  }

  const assignments = [
    envAssignment('MH_RUNTIME_ACTIVE_MODE', 'interpreter'),
    envAssignment('INTERPRETER_PRESET', selection),
    envAssignment('INTERPRETER_HOST', host),
    envAssignment('INTERPRETER_PORT', port),
    envAssignment('MH_INTERPRETER_PORT_RELEASE_WAIT_SECONDS', '15'),
    envAssignment('GEMMA4_MTP', context.interpreterMtp ?? 'off'),
    envAssignment(
      'GEMMA4_INTERPRETER_DRAFT_TOKENS',
      context.interpreterDraftTokens ?? '8'
    )
  ];
  if (context.interpreterSupertonicVoice) {
    assignments.push(
      envAssignment(
        'MH_SUPERTONIC_VOICE',
        context.interpreterSupertonicVoice
      )
    );
  }
  return [
    'exec env',
    ...assignments,
    shellQuote(path.join(repoRoot, 'scripts/run-interpreter-stack.sh')),
    '--preset',
    shellQuote(selection)
  ].join(' ');
}

export async function executeRuntimeModeSwitch(input, adapter) {
  const {
    stackPane,
    targetMode,
    targetSelection,
    transitionId
  } = input;
  if (
    !stackPane?.startsWith('%')
    || !isRuntimeMode(targetMode)
    || !isRuntimeSelection(targetMode, targetSelection)
    || !trimmed(transitionId)
  ) {
    throw new Error('invalid_switch_arguments');
  }

  await adapter.sleep(INITIAL_RESPONSE_GRACE_MS);
  const context = await adapter.readContext(stackPane);
  if (
    context.stackPane !== stackPane
    || !context.shellPane?.startsWith('%')
    || context.shellPane === stackPane
    || !isRuntimeMode(context.activeMode)
  ) {
    await adapter.markTransition({
      state: 'failed',
      error: 'runtime_pane_markers_missing'
    });
    return { ok: false, state: 'failed', error: 'runtime_pane_markers_missing' };
  }
  if (context.transitionId !== transitionId) {
    return { ok: false, state: 'superseded', error: 'transition_superseded' };
  }

  const previousMode = context.activeMode;
  const previousSelection = previousMode === 'operator'
    ? context.operatorProfile
    : context.interpreterPreset;
  const target = { mode: targetMode, selection: targetSelection };
  const previous = { mode: previousMode, selection: previousSelection };

  try {
    await adapter.preflight(target);
    if (targetMode === 'interpreter') {
      await adapter.stopPersistentAtomBridge();
    }
    await adapter.respawnStack({
      stackPane,
      command: buildRuntimeStackCommand({
        mode: targetMode,
        selection: targetSelection,
        context
      })
    });
    const targetReady = await adapter.waitForHealth({
      mode: targetMode,
      selection: targetSelection,
      port: context.bindPort ?? '8765'
    });
    if (!targetReady) {
      throw new Error('target_not_ready');
    }
    if (targetMode === 'operator') {
      await adapter.ensurePersistentAtomBridge();
    }
    await adapter.markReady(target);
    return { ok: true, state: 'ready', ...target };
  } catch (error) {
    const targetError = trimmed(error?.message) ?? 'target_failed';
    try {
      if (previousMode === 'interpreter') {
        await adapter.stopPersistentAtomBridge();
      }
      await adapter.respawnStack({
        stackPane,
        command: buildRuntimeStackCommand({
          mode: previousMode,
          selection: previousSelection,
          context
        })
      });
      const rollbackReady = await adapter.waitForHealth({
        mode: previousMode,
        selection: previousSelection,
        port: context.bindPort ?? '8765'
      });
      if (!rollbackReady) {
        throw new Error('rollback_not_ready');
      }
      if (previousMode === 'operator') {
        await adapter.ensurePersistentAtomBridge();
      }
      await adapter.markTransition({
        state: 'rolled_back',
        error: targetError
      });
      return {
        ok: false,
        state: 'rolled_back',
        error: targetError,
        previous
      };
    } catch (rollbackError) {
      await adapter.markTransition({
        state: 'failed',
        error: 'rollback_failed'
      });
      return {
        ok: false,
        state: 'failed',
        error: 'rollback_failed',
        targetError,
        rollbackError: trimmed(rollbackError?.message) ?? 'rollback_failed'
      };
    }
  }
}

export function createTmuxRuntimeModeAdapter(options = {}) {
  const runExecFile = options.execFile ?? execFileAsync;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleepImpl = options.sleep ?? (
    (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  );
  const timeoutMs = boundedInt(
    options.timeoutMs ?? process.env.MH_RUNTIME_SWITCH_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1_000,
    600_000
  );
  const pollIntervalMs = boundedInt(
    options.pollIntervalMs ?? process.env.MH_RUNTIME_SWITCH_POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
    50,
    5_000
  );

  async function tmux(args, { allowFailure = false } = {}) {
    try {
      const result = await runExecFile('tmux', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 64 * 1024
      });
      return String(result?.stdout ?? '').trim();
    } catch (error) {
      if (allowFailure) {
        return '';
      }
      throw error;
    }
  }

  async function getOption(stackPane, name) {
    return tmux(
      ['show-options', '-wqv', '-t', stackPane, name],
      { allowFailure: true }
    );
  }

  async function setOption(stackPane, name, value) {
    await tmux([
      'set-option',
      '-w',
      '-t',
      stackPane,
      name,
      String(value ?? '')
    ]);
  }

  let activeStackPane = null;
  return {
    sleep: sleepImpl,
    async readContext(stackPane) {
      activeStackPane = stackPane;
      const entries = await Promise.all(
        Object.entries(RUNTIME_TMUX_OPTIONS).map(async ([key, option]) => [
          key,
          await getOption(stackPane, option)
        ])
      );
      const values = Object.fromEntries(entries);
      const actualPane = await tmux(
        ['display-message', '-p', '-t', stackPane, '#{pane_id}'],
        { allowFailure: true }
      );
      const tmuxSession = await tmux(
        ['display-message', '-p', '-t', stackPane, '#{session_name}'],
        { allowFailure: true }
      );
      return {
        stackPane: actualPane === stackPane ? values.stackPane : null,
        shellPane: values.shellPane,
        tmuxSession: trimmed(tmuxSession) ?? 'agent',
        activeMode: values.activeMode,
        operatorProfile: isRuntimeSelection('operator', values.operatorProfile)
          ? values.operatorProfile
          : 'default',
        interpreterPreset: isRuntimeSelection(
          'interpreter',
          values.interpreterPreset
        )
          ? values.interpreterPreset
          : 'gemma4-supertonic',
        bindHost: trimmed(values.bindHost) ?? '127.0.0.1',
        bindPort: /^\d{1,5}$/.test(values.bindPort)
          ? values.bindPort
          : '8765',
        operatorUiMode: trimmed(values.operatorUiMode),
        operatorAudioTarget: trimmed(values.operatorAudioTarget),
        operatorAsrDevice: trimmed(values.operatorAsrDevice),
        operatorKokoroVoice: trimmed(values.operatorKokoroVoice),
        agentRepoRoot: trimmed(values.agentRepoRoot),
        interpreterMtp: /^(off|on|auto)$/.test(values.interpreterMtp)
          ? values.interpreterMtp
          : 'off',
        interpreterDraftTokens: /^\d+$/.test(values.interpreterDraftTokens)
          ? values.interpreterDraftTokens
          : '8',
        interpreterSupertonicVoice: trimmed(
          values.interpreterSupertonicVoice
        ),
        transitionId: values.transitionId
      };
    },
    async preflight(target) {
      const script = target.mode === 'operator'
        ? path.join(repoRoot, 'scripts/run-operator-profile.sh')
        : path.join(repoRoot, 'scripts/run-interpreter-stack.sh');
      await access(script, fsConstants.X_OK);
    },
    async stopPersistentAtomBridge() {
      try {
        await runExecFile('tmux', ['has-session', '-t', 'atoms3r-bridge'], {
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 64 * 1024
        });
      } catch {
        return;
      }
      const owner = await tmux(
        [
          'show-options',
          '-qv',
          '-t',
          'atoms3r-bridge',
          '@minimum_headroom_atom_bridge_owner'
        ],
        { allowFailure: true }
      );
      if (owner !== 'operator') {
        throw new Error('unverified_atom_bridge_owner');
      }
      await tmux(['kill-session', '-t', 'atoms3r-bridge']);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await runExecFile(
            'pgrep',
            ['-f', 'atoms3r-http-bridge\\.mjs'],
            {
              cwd: repoRoot,
              encoding: 'utf8',
              timeout: 2_000,
              maxBuffer: 64 * 1024
            }
          );
        } catch {
          return;
        }
        await sleepImpl(100);
      }
      throw new Error('operator_atom_bridge_did_not_stop');
    },
    async ensurePersistentAtomBridge() {
      await runExecFile(
        path.join(repoRoot, 'scripts/ensure-atoms3r-bridge.sh'),
        [],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: 64 * 1024,
          env: {
            ...process.env,
            MH_SKIP_ATOMS3R_BRIDGE: '0',
            MH_ATOMS3R_BRIDGE_WAIT_UNMANAGED_SECONDS: '15'
          }
        }
      );
      const owner = await tmux(
        [
          'show-options',
          '-qv',
          '-t',
          'atoms3r-bridge',
          '@minimum_headroom_atom_bridge_owner'
        ],
        { allowFailure: true }
      );
      if (owner !== 'operator') {
        throw new Error('operator_atom_bridge_not_ready');
      }
    },
    async respawnStack({ stackPane, command }) {
      await tmux([
        'respawn-pane',
        '-k',
        '-c',
        repoRoot,
        '-t',
        stackPane,
        command
      ]);
    },
    async waitForHealth({ mode, selection, port }) {
      const deadline = Date.now() + timeoutMs;
      const url = `http://127.0.0.1:${port}/healthz`;
      while (Date.now() < deadline) {
        if (activeStackPane) {
          const paneState = await tmux(
            [
              'display-message',
              '-p',
              '-t',
              activeStackPane,
              '#{pane_id}:#{pane_dead}'
            ],
            { allowFailure: true }
          );
          if (paneState !== `${activeStackPane}:0`) {
            return false;
          }
        }
        try {
          const response = await fetchImpl(url, {
            method: 'GET',
            signal: AbortSignal.timeout(2_000),
            cache: 'no-store'
          });
          const payload = await response.json();
          const payloadSelection = mode === 'operator'
            ? payload.profile
            : payload.preset;
          if (
            response.ok
            && payload?.ok === true
            && payload?.service === mode
            && payloadSelection === selection
          ) {
            return true;
          }
        } catch {}
        await sleepImpl(pollIntervalMs);
      }
      return false;
    },
    async markReady(target) {
      await setOption(
        activeStackPane,
        RUNTIME_TMUX_OPTIONS.activeMode,
        target.mode
      );
      await setOption(
        activeStackPane,
        target.mode === 'operator'
          ? RUNTIME_TMUX_OPTIONS.operatorProfile
          : RUNTIME_TMUX_OPTIONS.interpreterPreset,
        target.selection
      );
      await setOption(
        activeStackPane,
        RUNTIME_TMUX_OPTIONS.transitionState,
        'ready'
      );
      await setOption(
        activeStackPane,
        RUNTIME_TMUX_OPTIONS.transitionError,
        ''
      );
    },
    async markTransition({ state, error }) {
      await setOption(
        activeStackPane,
        RUNTIME_TMUX_OPTIONS.transitionState,
        state
      );
      await setOption(
        activeStackPane,
        RUNTIME_TMUX_OPTIONS.transitionError,
        error ?? ''
      );
    }
  };
}

function parseCli(argv) {
  const result = {
    stackPane: null,
    targetMode: null,
    targetSelection: null,
    transitionId: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--stack-pane') {
      result.stackPane = value;
    } else if (arg === '--target-mode') {
      result.targetMode = value;
    } else if (arg === '--selection') {
      result.targetSelection = value;
    } else if (arg === '--transition-id') {
      result.transitionId = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
    index += 1;
  }
  return result;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === currentFile;
if (isMain) {
  try {
    const result = await executeRuntimeModeSwitch(
      parseCli(process.argv.slice(2)),
      createTmuxRuntimeModeAdapter()
    );
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`[runtime-mode-switch] ${error.message}`);
    process.exitCode = 1;
  }
}
