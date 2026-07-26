import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  INTERPRETER_PRESETS,
  OPERATOR_PROFILES,
  RUNTIME_TMUX_OPTIONS,
  isRuntimeMode,
  isRuntimeSelection
} from './runtime_mode_config.js';

const execFileAsync = promisify(execFileCallback);
const MAX_REQUEST_BYTES = 2_048;

function writeJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function contentTypeIsJson(value) {
  const contentType = Array.isArray(value) ? value[0] : value;
  return typeof contentType === 'string'
    && contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) {
      const error = new Error('payload_too_large');
      error.code = 'payload_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (length === 0) {
    const error = new Error('empty_body');
    error.code = 'invalid_json';
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    const error = new Error('invalid_json');
    error.code = 'invalid_json';
    throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function asTrimmedString(value) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : null;
}

export class RuntimeModeError extends Error {
  constructor(code, statusCode, message = code) {
    super(message);
    this.name = 'RuntimeModeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function defaultTransition() {
  return {
    id: null,
    state: 'idle',
    targetMode: null,
    targetSelection: null,
    error: null
  };
}

export function validateRuntimeSwitchBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RuntimeModeError('invalid_request', 400);
  }
  const keys = Object.keys(body).sort();
  if (
    keys.length !== 2
    || keys[0] !== 'mode'
    || keys[1] !== 'selection'
  ) {
    throw new RuntimeModeError('invalid_request_fields', 400);
  }
  const mode = asTrimmedString(body.mode);
  const selection = asTrimmedString(body.selection);
  if (!isRuntimeMode(mode)) {
    throw new RuntimeModeError('invalid_mode', 400);
  }
  if (!isRuntimeSelection(mode, selection)) {
    throw new RuntimeModeError('invalid_selection', 400);
  }
  return { mode, selection };
}

export function createTmuxRuntimeModeController(options = {}) {
  const paneId = asTrimmedString(options.paneId ?? process.env.TMUX_PANE);
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..'
  ));
  const runExecFile = options.execFile ?? execFileAsync;
  const tmuxCommand = options.tmuxCommand ?? 'tmux';
  const workerPath = path.join(repoRoot, 'scripts/runtime-mode-switch.mjs');
  const commandTimeoutMs = Number.isFinite(options.commandTimeoutMs)
    ? options.commandTimeoutMs
    : 5_000;

  async function tmux(args, { allowFailure = false } = {}) {
    try {
      const result = await runExecFile(tmuxCommand, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: commandTimeoutMs,
        maxBuffer: 64 * 1024
      });
      return String(result?.stdout ?? '').trim();
    } catch (error) {
      if (allowFailure) {
        return '';
      }
      throw new RuntimeModeError(
        'tmux_unavailable',
        503,
        asTrimmedString(error?.message) ?? 'tmux_unavailable'
      );
    }
  }

  async function getOption(name) {
    if (!paneId) {
      return '';
    }
    return tmux(
      ['show-options', '-wqv', '-t', paneId, name],
      { allowFailure: true }
    );
  }

  async function setOption(name, value) {
    await tmux(['set-option', '-w', '-t', paneId, name, String(value)]);
  }

  async function readContext() {
    if (!paneId) {
      return {
        available: false,
        reason: 'not_in_tmux',
        transition: defaultTransition()
      };
    }
    const [
      actualPane,
      shellPane,
      stackPane,
      activeMode,
      operatorProfile,
      interpreterPreset,
      transitionId,
      transitionState,
      transitionTargetMode,
      transitionTargetSelection,
      transitionError
    ] = await Promise.all([
      tmux(
        ['display-message', '-p', '-t', paneId, '#{pane_id}'],
        { allowFailure: true }
      ),
      getOption(RUNTIME_TMUX_OPTIONS.shellPane),
      getOption(RUNTIME_TMUX_OPTIONS.stackPane),
      getOption(RUNTIME_TMUX_OPTIONS.activeMode),
      getOption(RUNTIME_TMUX_OPTIONS.operatorProfile),
      getOption(RUNTIME_TMUX_OPTIONS.interpreterPreset),
      getOption(RUNTIME_TMUX_OPTIONS.transitionId),
      getOption(RUNTIME_TMUX_OPTIONS.transitionState),
      getOption(RUNTIME_TMUX_OPTIONS.transitionTargetMode),
      getOption(RUNTIME_TMUX_OPTIONS.transitionTargetSelection),
      getOption(RUNTIME_TMUX_OPTIONS.transitionError)
    ]);
    const available = actualPane === paneId
      && stackPane === paneId
      && shellPane.startsWith('%')
      && shellPane !== stackPane
      && isRuntimeMode(activeMode);
    return {
      available,
      reason: available ? null : 'runtime_pane_markers_missing',
      shellPane: available ? shellPane : null,
      stackPane: available ? stackPane : null,
      activeMode: isRuntimeMode(activeMode) ? activeMode : null,
      operatorProfile: isRuntimeSelection('operator', operatorProfile)
        ? operatorProfile
        : 'default',
      interpreterPreset: isRuntimeSelection('interpreter', interpreterPreset)
        ? interpreterPreset
        : 'gemma4-supertonic',
      transition: {
        id: asTrimmedString(transitionId),
        state: asTrimmedString(transitionState) ?? 'idle',
        targetMode: isRuntimeMode(transitionTargetMode)
          ? transitionTargetMode
          : null,
        targetSelection: isRuntimeSelection(
          transitionTargetMode,
          transitionTargetSelection
        )
          ? transitionTargetSelection
          : null,
        error: asTrimmedString(transitionError)
      }
    };
  }

  async function snapshot() {
    return readContext();
  }

  async function requestSwitch({ mode, selection, currentMode, currentSelection }) {
    const context = await readContext();
    if (!context.available) {
      throw new RuntimeModeError(
        context.reason ?? 'runtime_switch_unavailable',
        503
      );
    }
    if (context.transition.state === 'switching') {
      throw new RuntimeModeError('switch_in_progress', 409);
    }
    if (mode === currentMode && selection === currentSelection) {
      throw new RuntimeModeError('target_already_active', 409);
    }

    const transitionId = randomUUID();
    const lockName = `minimum-headroom-runtime-switch-${paneId.slice(1)}`;
    await tmux(['wait-for', '-L', lockName]);
    try {
      const lockedState = await getOption(RUNTIME_TMUX_OPTIONS.transitionState);
      if (lockedState === 'switching') {
        throw new RuntimeModeError('switch_in_progress', 409);
      }
      await setOption(RUNTIME_TMUX_OPTIONS.transitionId, transitionId);
      await setOption(RUNTIME_TMUX_OPTIONS.transitionState, 'switching');
      await setOption(RUNTIME_TMUX_OPTIONS.transitionTargetMode, mode);
      await setOption(RUNTIME_TMUX_OPTIONS.transitionTargetSelection, selection);
      await setOption(RUNTIME_TMUX_OPTIONS.transitionError, '');

      const workerCommand = [
        'exec',
        shellQuote(process.execPath),
        shellQuote(workerPath),
        '--stack-pane',
        shellQuote(paneId),
        '--target-mode',
        shellQuote(mode),
        '--selection',
        shellQuote(selection),
        '--transition-id',
        shellQuote(transitionId)
      ].join(' ');
      try {
        await tmux(['run-shell', '-b', '-t', paneId, workerCommand]);
      } catch (error) {
        await setOption(RUNTIME_TMUX_OPTIONS.transitionState, 'failed');
        await setOption(
          RUNTIME_TMUX_OPTIONS.transitionError,
          'switch_job_not_started'
        );
        throw error;
      }
    } finally {
      await tmux(['wait-for', '-U', lockName], { allowFailure: true });
    }
    return {
      transitionId,
      targetMode: mode,
      targetSelection: selection
    };
  }

  return {
    snapshot,
    requestSwitch
  };
}

export function createRuntimeModeApi(options = {}) {
  const mode = options.mode;
  const selection = options.selection;
  if (!isRuntimeMode(mode) || !isRuntimeSelection(mode, selection)) {
    throw new Error('createRuntimeModeApi requires a valid mode and selection');
  }
  const controller = options.controller ?? createTmuxRuntimeModeController({
    paneId: options.paneId,
    repoRoot: options.repoRoot
  });

  return {
    async handleHttpRequest(request, response) {
      const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (parsedUrl.pathname === '/api/runtime/mode') {
        if (request.method !== 'GET') {
          writeJson(response, 405, {
            ok: false,
            error: 'method_not_allowed'
          });
          return true;
        }
        const snapshot = await controller.snapshot();
        writeJson(response, 200, {
          ok: true,
          mode,
          selection,
          available: snapshot.available === true,
          unavailableReason: snapshot.available === true
            ? null
            : snapshot.reason ?? 'runtime_switch_unavailable',
          operatorProfiles: [...OPERATOR_PROFILES],
          interpreterPresets: [...INTERPRETER_PRESETS],
          savedSelections: {
            operator: snapshot.operatorProfile ?? 'default',
            interpreter:
              snapshot.interpreterPreset ?? 'gemma4-supertonic'
          },
          transition: snapshot.transition ?? defaultTransition()
        });
        return true;
      }
      if (parsedUrl.pathname !== '/api/runtime/switch') {
        return false;
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, {
          ok: false,
          error: 'method_not_allowed'
        });
        return true;
      }
      if (!contentTypeIsJson(request.headers['content-type'])) {
        writeJson(response, 415, {
          ok: false,
          error: 'unsupported_media_type'
        });
        return true;
      }

      let target;
      try {
        target = validateRuntimeSwitchBody(await readJsonBody(request));
        const scheduled = await controller.requestSwitch({
          ...target,
          currentMode: mode,
          currentSelection: selection
        });
        writeJson(response, 202, {
          ok: true,
          transitionId: scheduled.transitionId,
          targetMode: scheduled.targetMode,
          targetSelection: scheduled.targetSelection
        });
      } catch (error) {
        const statusCode = error instanceof RuntimeModeError
          ? error.statusCode
          : error?.code === 'payload_too_large'
            ? 413
            : 400;
        writeJson(response, statusCode, {
          ok: false,
          error: error instanceof RuntimeModeError
            ? error.code
            : error?.code ?? 'invalid_json'
        });
      }
      return true;
    }
  };
}
