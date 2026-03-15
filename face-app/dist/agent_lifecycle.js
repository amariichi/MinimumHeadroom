import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function toLogger(log) {
  if (!log) {
    return { info: () => {}, warn: () => {}, error: () => {} };
  }
  return {
    info: typeof log.info === 'function' ? log.info.bind(log) : () => {},
    warn: typeof log.warn === 'function' ? log.warn.bind(log) : () => {},
    error: typeof log.error === 'function' ? log.error.bind(log) : () => {}
  };
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeRepoPath(value) {
  const candidate = asNonEmptyString(value);
  if (!candidate) {
    return null;
  }
  return path.resolve(candidate);
}

function deriveStableStreamId(rawStreamId, targetRepoRoot, fallbackRoot = '') {
  const explicit = asNonEmptyString(rawStreamId);
  if (explicit) {
    return explicit;
  }
  const resolvedRoot = normalizeRepoPath(targetRepoRoot) ?? normalizeRepoPath(fallbackRoot);
  return resolvedRoot ? `repo:${resolvedRoot}` : 'repo:default';
}

function parseInteger(value, fallback, minValue = Number.MIN_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed) || parsed < minValue) {
    return fallback;
  }
  return parsed;
}

function createLifecycleError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no') {
      return false;
    }
  }
  return fallback;
}

function sanitizeBranchSegment(value, fallback) {
  const source = asNonEmptyString(value) ?? fallback;
  return source.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+/, '').replace(/-+$/, '') || fallback;
}

function stripAnsi(value) {
  if (typeof value !== 'string' || value === '') {
    return '';
  }
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function timestampStamp(nowFn) {
  const value = Number.isFinite(nowFn?.()) ? Math.floor(nowFn()) : Date.now();
  return String(value);
}

function parseActionPath(pathname) {
  const match = pathname.match(/^\/api\/agents\/([^/]+)\/([a-z-]+)$/);
  if (!match) {
    return null;
  }
  let decodedAgentId = null;
  try {
    decodedAgentId = decodeURIComponent(match[1]);
  } catch (error) {
    throw createLifecycleError('invalid_request', 'agent id path segment is invalid', error);
  }
  return {
    agentId: decodedAgentId,
    action: match[2]
  };
}

function isPathInsideRoot(targetPath, rootPath) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootPath);
  if (resolvedTarget === resolvedRoot) {
    return true;
  }
  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function statusCodeFromError(error) {
  switch (error?.code) {
    case 'invalid_request':
    case 'invalid_json':
    case 'invalid_agent_id':
      return 400;
    case 'agent_not_found':
      return 404;
    case 'hard_cap_reached':
    case 'duplicate_agent':
    case 'invalid_state':
    case 'invalid_transition':
      return 409;
    case 'external_delete_forbidden':
    case 'external_worktree_forbidden':
      return 403;
    case 'command_timeout':
      return 504;
    case 'command_failed':
    case 'command_spawn_failed':
      return 502;
    default:
      return 500;
  }
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request, maxBodyBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(createLifecycleError('invalid_request', 'request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(createLifecycleError('invalid_json', 'request json body must be an object'));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(createLifecycleError('invalid_json', `invalid json body: ${error.message}`));
      }
    });

    request.on('error', (error) => {
      reject(createLifecycleError('invalid_request', error.message, error));
    });
  });
}

async function runProcess(command, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(200, Math.floor(options.timeoutMs)) : 30_000;
  const cwd = asNonEmptyString(options.cwd);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: cwd ?? undefined,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(createLifecycleError('command_timeout', `command timed out: ${command}`));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(createLifecycleError('command_spawn_failed', error.message, error));
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(
        createLifecycleError(
          'command_failed',
          `${command} exited with ${code}${stderr.trim() !== '' ? `: ${stderr.trim()}` : ''}`
        )
      );
    });
  });
}

const PERMISSION_PRESETS = new Set(['reviewer', 'implementer', 'full']);

export function inferAgentType(agentCmd) {
  if (!agentCmd || typeof agentCmd !== 'string') {
    return 'claude';
  }
  const lower = agentCmd.toLowerCase();
  if (/\bgemini\b/.test(lower)) {
    return 'gemini';
  }
  if (/\bcodex\b/.test(lower)) {
    return 'codex';
  }
  return 'claude';
}

export function buildPermissionConfig(agentType, preset) {
  if (!preset || !PERMISSION_PRESETS.has(preset)) {
    return { configPath: null, configContent: null, cmdSuffix: null };
  }

  if (agentType === 'claude') {
    const base = ['Read', 'Glob', 'Grep', 'mcp__minimum_headroom__agent_report'];
    const allow =
      preset === 'reviewer' ? base
        : preset === 'implementer' ? [...base, 'Edit', 'Write', 'Bash']
          : [...base, 'Edit', 'Write', 'Bash'];
    return {
      configPath: '.claude/settings.json',
      configContent: { permissions: { allow } },
      cmdSuffix: null
    };
  }

  if (agentType === 'gemini') {
    const readTools = ['read_file', 'search_files', 'list_files'];
    const editTools = [...readTools, 'edit_file', 'write_file', 'run_shell_command'];
    const coreTools = preset === 'reviewer' ? readTools : editTools;
    return {
      configPath: '.gemini/settings.json',
      configContent: { tools: { core: coreTools } },
      cmdSuffix: '--yolo'
    };
  }

  if (agentType === 'codex') {
    if (preset === 'reviewer') {
      return { configPath: null, configContent: null, cmdSuffix: '-a untrusted' };
    }
    return { configPath: null, configContent: null, cmdSuffix: '--full-auto' };
  }

  return { configPath: null, configContent: null, cmdSuffix: null };
}

export function createAgentLifecycleRuntime(options = {}) {
  const stateStore = options.stateStore;
  if (!stateStore || typeof stateStore.getState !== 'function') {
    throw new Error('stateStore is required');
  }

  const log = toLogger(options.log ?? console);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const repoRoot = path.resolve(asNonEmptyString(options.repoRoot) ?? process.cwd());
  const activeTargetRepoRoot = normalizeRepoPath(options.activeTargetRepoRoot)
    ?? normalizeRepoPath(options.defaultSourceRepoPath)
    ?? repoRoot;
  const activeStreamId = deriveStableStreamId(options.activeStreamId, activeTargetRepoRoot, repoRoot);
  const defaultSourceRepoPath = path.resolve(asNonEmptyString(options.defaultSourceRepoPath) ?? activeTargetRepoRoot);
  const worktreesRoot = path.resolve(asNonEmptyString(options.worktreesRoot) ?? path.join(repoRoot, '.agent/worktrees'));
  const tmuxSession = asNonEmptyString(options.tmuxSession) ?? 'agent';
  const defaultAgentCommand = asNonEmptyString(options.defaultAgentCommand) ?? 'codex';
  const commandRunner = typeof options.commandRunner === 'function' ? options.commandRunner : runProcess;
  const commandTimeoutMs = parseInteger(options.commandTimeoutMs, 30_000, 500);
  const tmuxEnabled = normalizeBoolean(options.tmuxEnabled, true);
  const worktreeEnabled = normalizeBoolean(options.worktreeEnabled, true);
  const allowExternalDelete = normalizeBoolean(options.allowExternalDelete, false);
  const allowExternalWorktreeAdd = normalizeBoolean(options.allowExternalWorktreeAdd, false);
  const helperInjectWaitForReady = normalizeBoolean(options.helperInjectWaitForReady, true);
  const helperInjectReadyTimeoutMs = parseInteger(options.helperInjectReadyTimeoutMs, 4000, 0);
  const helperInjectReadyPollMs = parseInteger(options.helperInjectReadyPollMs, 150, 20);
  const helperInjectReadyCaptureLines = parseInteger(options.helperInjectReadyCaptureLines, 80, 10);
  const helperInjectReadyStablePolls = parseInteger(options.helperInjectReadyStablePolls, 2, 1);
  const helperInjectProbeTimeoutMs = parseInteger(options.helperInjectProbeTimeoutMs, 1500, 100);
  const helperInjectProbePollMs = parseInteger(options.helperInjectProbePollMs, 75, 20);
  const helperInjectProbeCaptureLines = parseInteger(options.helperInjectProbeCaptureLines, helperInjectReadyCaptureLines, 10);
  const onFocus = typeof options.onFocus === 'function' ? options.onFocus : null;

  function listAgents(optionsInput = {}) {
    return stateStore.listAgents(optionsInput);
  }

  function getAgentStateOrThrow(agentId) {
    const id = asNonEmptyString(agentId);
    if (!id) {
      throw createLifecycleError('invalid_agent_id', 'agent id is empty');
    }
    const agent = stateStore.getAgent(id);
    if (!agent) {
      throw createLifecycleError('agent_not_found', `agent not found: ${id}`);
    }
    return agent;
  }

  async function runCommand(command, args, optionsInput = {}) {
    return commandRunner(command, args, {
      timeoutMs: commandTimeoutMs,
      ...optionsInput
    });
  }

  async function delayMs(ms) {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  async function runTmux(args) {
    if (!tmuxEnabled) {
      throw createLifecycleError('invalid_state', 'tmux orchestration is disabled');
    }
    return runCommand('tmux', args);
  }

  async function pasteTextToPane(paneId, text, submit) {
    const bufferName = `mh-inject-${randomUUID().slice(0, 8)}`;
    const tmpFile = path.join(os.tmpdir(), `${bufferName}.txt`);
    try {
      fs.writeFileSync(tmpFile, text);
      await runTmux(['load-buffer', '-b', bufferName, tmpFile]);
      await runTmux(['paste-buffer', '-b', bufferName, '-t', paneId, '-d', '-p']);
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
      try {
        await runTmux(['delete-buffer', '-b', bufferName]);
      } catch (_) {}
    }
    if (submit) {
      await delayMs(250);
      await runTmux(['send-keys', '-t', paneId, 'C-m']);
    }
  }

  async function runGit(repoPath, args) {
    return runCommand('git', ['-C', repoPath, ...args]);
  }

  async function pruneGitWorktrees(repoPath) {
    await runGit(repoPath, ['worktree', 'prune', '--expire', 'now']);
  }

  async function nextWindowName(baseName) {
    const result = await runTmux(['list-windows', '-t', `${tmuxSession}:`, '-F', '#{window_name}']);
    const existing = new Set(
      result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    );
    let candidate = baseName;
    let index = 1;
    while (existing.has(candidate)) {
      candidate = `${baseName}-${index}`;
      index += 1;
    }
    return candidate;
  }

  async function startTmuxAgentPane({ agentId, cwd, command }) {
    const baseName = `agent-${sanitizeBranchSegment(agentId.slice(0, 8), 'node')}`;
    const windowName = await nextWindowName(baseName);
    const created = await runTmux([
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-t',
      `${tmuxSession}:`,
      '-n',
      windowName,
      '-c',
      cwd
    ]);
    const paneId = asNonEmptyString(created.stdout);
    if (!paneId) {
      throw createLifecycleError('tmux_failed', 'failed to get new pane id from tmux');
    }
    if (command) {
      await runTmux(['send-keys', '-t', paneId, command, 'C-m']);
    }
    return { paneId, windowName };
  }

  function resolveDefaultWorktreePath(agentId) {
    return path.resolve(worktreesRoot, sanitizeBranchSegment(agentId, 'agent'));
  }

  function resolveBranchName(agentId, explicitBranch) {
    const requested = asNonEmptyString(explicitBranch);
    if (requested) {
      return requested;
    }
    const token = sanitizeBranchSegment(agentId, 'agent');
    return `agent/${token}/${timestampStamp(now)}`;
  }

  function resolveRepoPath(inputPath) {
    return path.resolve(asNonEmptyString(inputPath) ?? defaultSourceRepoPath);
  }

  function resolveWorktreePath(inputPath, agentId) {
    if (asNonEmptyString(inputPath)) {
      return path.resolve(inputPath);
    }
    return resolveDefaultWorktreePath(agentId);
  }

  function assertManagedWorktreePath(worktreePath, errorCode) {
    if (allowExternalWorktreeAdd) {
      return;
    }
    if (!isPathInsideRoot(worktreePath, worktreesRoot)) {
      throw createLifecycleError(
        errorCode,
        `worktree path outside managed root: ${path.resolve(worktreePath)}`
      );
    }
  }

  async function addAgent(input = {}) {
    const agentId = asNonEmptyString(input.id) ?? randomUUID();
    const sessionId = asNonEmptyString(input.session_id) ?? agentId;
    const sourceRepoPath = resolveRepoPath(input.source_repo_path);
    const targetRepoRoot = normalizeRepoPath(input.target_repo_root) ?? sourceRepoPath ?? activeTargetRepoRoot;
    const streamId = deriveStableStreamId(input.stream_id, targetRepoRoot, activeTargetRepoRoot);
    const worktreePath = resolveWorktreePath(input.worktree_path, agentId);
    const explicitWorktreePath = asNonEmptyString(input.worktree_path);
    const branch = resolveBranchName(agentId, input.branch);
    const slot = parseInteger(input.slot, null, 0);
    const createWorktree = normalizeBoolean(input.create_worktree, true);
    const createTmux = normalizeBoolean(input.create_tmux, true);
    let agentCommand = asNonEmptyString(input.agent_cmd) ?? defaultAgentCommand;
    const permissionPreset = PERMISSION_PRESETS.has(input.permission_preset) ? input.permission_preset : null;
    let runCwd = worktreePath;

    let worktreeCreated = false;
    let paneCreated = false;
    let paneId = asNonEmptyString(input.pane_id);

    if (createWorktree) {
      if (!worktreeEnabled) {
        throw createLifecycleError('invalid_state', 'worktree orchestration is disabled');
      }
      assertManagedWorktreePath(worktreePath, 'external_worktree_forbidden');
      if (!fs.existsSync(sourceRepoPath)) {
        throw createLifecycleError('invalid_request', `source repo path does not exist: ${sourceRepoPath}`);
      }
      await runGit(sourceRepoPath, ['rev-parse', '--is-inside-work-tree']);
      if (fs.existsSync(worktreePath)) {
        throw createLifecycleError('invalid_state', `worktree path already exists: ${worktreePath}`);
      }
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      await runGit(sourceRepoPath, ['worktree', 'add', '-b', branch, worktreePath]);
      worktreeCreated = true;
      runCwd = worktreePath;
    } else if (!fs.existsSync(worktreePath)) {
      if (asNonEmptyString(input.worktree_path)) {
        throw createLifecycleError('invalid_request', `worktree path does not exist: ${worktreePath}`);
      }
      runCwd = sourceRepoPath;
    }

    if (permissionPreset && worktreeCreated) {
      const agentType = inferAgentType(agentCommand);
      const permConfig = buildPermissionConfig(agentType, permissionPreset);
      if (permConfig.configContent && permConfig.configPath) {
        const fullConfigPath = path.join(worktreePath, permConfig.configPath);
        fs.mkdirSync(path.dirname(fullConfigPath), { recursive: true });
        fs.writeFileSync(fullConfigPath, JSON.stringify(permConfig.configContent, null, 2));
      }
      if (permConfig.cmdSuffix) {
        agentCommand = `${agentCommand} ${permConfig.cmdSuffix}`;
      }
    }

    if (createTmux) {
      const pane = await startTmuxAgentPane({
        agentId,
        cwd: runCwd,
        command: agentCommand
      });
      paneCreated = true;
      paneId = pane.paneId;
    }

    try {
      const result = stateStore.addAgent({
        id: agentId,
        session_id: sessionId,
        status: 'active',
        slot,
        stream_id: streamId,
        source_repo_path: sourceRepoPath,
        target_repo_root: targetRepoRoot,
        worktree_path: createWorktree ? worktreePath : explicitWorktreePath ? worktreePath : null,
        branch,
        pane_id: paneId,
        last_message: 'agent created',
        message_source: 'status'
      });
      return {
        ...result,
        orchestration: {
          worktree_created: worktreeCreated,
          pane_created: paneCreated
        }
      };
    } catch (error) {
      if (paneCreated && paneId) {
        try {
          await runTmux(['kill-pane', '-t', paneId]);
        } catch (cleanupError) {
          log.warn(`[agent-lifecycle] failed cleanup kill-pane ${paneId}: ${cleanupError.message}`);
        }
      }
      if (worktreeCreated) {
        try {
          await runGit(sourceRepoPath, ['worktree', 'remove', '--force', worktreePath]);
        } catch (cleanupError) {
          log.warn(`[agent-lifecycle] failed cleanup worktree ${worktreePath}: ${cleanupError.message}`);
        }
      }
      throw error;
    }
  }

  async function detachAgentPane(agentId, input = {}) {
    const agent = getAgentStateOrThrow(agentId);
    const killPane = normalizeBoolean(input.kill_pane, true);
    let paneKilled = false;
    let paneKillError = null;
    if (!asNonEmptyString(agent.pane_id)) {
      return {
        ok: true,
        action: 'detach',
        noop: true,
        agent,
        state: stateStore.getState(),
        orchestration: {
          pane_killed: false
        }
      };
    }

    if (killPane && tmuxEnabled && asNonEmptyString(agent.pane_id)) {
      try {
        await runTmux(['kill-pane', '-t', agent.pane_id]);
        paneKilled = true;
        const patched = stateStore.updateAgentMetadata(agent.id, {
          pane_id: null
        });
        return {
          ...patched,
          action: 'detach',
          noop: false,
          orchestration: {
            pane_killed: paneKilled
          }
        };
      } catch (error) {
        paneKillError = asNonEmptyString(error?.message);
        log.warn(`[agent-lifecycle] detach kill-pane failed (${agent.pane_id}): ${error.message}`);
        const patched = stateStore.setAgentMessage(agent.id, 'pane still attached', 'status');
        return {
          ...patched,
          action: 'detach',
          noop: false,
          orchestration: {
            pane_killed: false,
            pane_kill_error: paneKillError
          }
        };
      }
    }

    const patched = stateStore.updateAgentMetadata(agent.id, {
      pane_id: null
    });

    const response = {
      ...patched,
      action: 'detach',
      orchestration: {
        pane_killed: paneKilled
      }
    };
    if (paneKillError) {
      response.orchestration.pane_kill_error = paneKillError;
    }
    return response;
  }

  async function paneExists(paneId) {
    const targetPane = asNonEmptyString(paneId);
    if (!targetPane || !tmuxEnabled) {
      return false;
    }
    try {
      const result = await runTmux(['display-message', '-p', '-t', targetPane, '#{pane_id}']);
      const resolved = asNonEmptyString(result.stdout);
      return resolved === targetPane;
    } catch {
      return false;
    }
  }

  async function capturePaneTail(paneId, lineCount = helperInjectReadyCaptureLines) {
    const safeLineCount = parseInteger(lineCount, helperInjectReadyCaptureLines, 1);
    const result = await runTmux(['capture-pane', '-t', paneId, '-p', '-e', '-S', `-${safeLineCount}`]);
    const normalized = result.stdout.replace(/\r/g, '');
    return normalized
      .split('\n')
      .map((line) => stripAnsi(line))
      .filter((line, index, source) => !(index === source.length - 1 && line === ''));
  }

  function createProbeToken() {
    return `MHPRB${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  }

  async function waitForTokenVisibility(paneId, token, expectedVisible, input = {}) {
    const timeoutMs = parseInteger(input.probe_timeout_ms, helperInjectProbeTimeoutMs, 100);
    const pollMs = parseInteger(input.probe_poll_ms, helperInjectProbePollMs, 20);
    const lineCount = parseInteger(input.probe_capture_lines, helperInjectProbeCaptureLines, 10);
    const startedAt = now();
    const deadline = startedAt + timeoutMs;

    while (now() <= deadline) {
      const lines = await capturePaneTail(paneId, lineCount);
      const joined = lines.join('\n');
      const visible = joined.includes(token);
      if (visible === expectedVisible) {
        return {
          ok: true,
          visible,
          waited_ms: Math.max(0, now() - startedAt)
        };
      }
      await delayMs(pollMs);
    }

    return {
      ok: false,
      visible: !expectedVisible,
      waited_ms: Math.max(0, now() - startedAt)
    };
  }

  async function runInputProbe(paneId, input = {}) {
    const token = createProbeToken();
    await runTmux(['send-keys', '-t', paneId, '-l', '--', token]);

    const visibleResult = await waitForTokenVisibility(paneId, token, true, input);
    if (!visibleResult.ok) {
      return {
        enabled: true,
        ok: false,
        stage: 'probe_not_visible',
        token_length: token.length,
        probe_wait_ms: visibleResult.waited_ms,
        clear_wait_ms: 0,
        message: 'input probe did not appear in helper pane'
      };
    }

    const backspaces = Array.from({ length: token.length }, () => 'BSpace');
    await runTmux(['send-keys', '-t', paneId, ...backspaces]);
    const clearedResult = await waitForTokenVisibility(paneId, token, false, input);
    if (!clearedResult.ok) {
      return {
        enabled: true,
        ok: false,
        stage: 'probe_not_cleared',
        token_length: token.length,
        probe_wait_ms: visibleResult.waited_ms,
        clear_wait_ms: clearedResult.waited_ms,
        message: 'input probe could not be cleared from helper pane'
      };
    }

    return {
      enabled: true,
      ok: true,
      stage: 'cleared',
      token_length: token.length,
      probe_wait_ms: visibleResult.waited_ms,
      clear_wait_ms: clearedResult.waited_ms,
      message: null
    };
  }

  function buildBufferedTailNeedles(text) {
    const lines = String(text ?? '')
      .split('\n')
      .map((line) => stripAnsi(String(line)).trim())
      .filter((line) => line !== '');
    const exactNeedles = [];
    const markerNeedles = [];
    const seenExact = new Set();
    const seenMarkers = new Set();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const candidate = lines[index];
      if (seenExact.has(candidate)) {
        continue;
      }
      seenExact.add(candidate);
      exactNeedles.push(candidate);
      if (exactNeedles.length >= 3) {
        break;
      }
    }
    for (let index = lines.length - 1; index >= Math.max(0, lines.length - 12); index -= 1) {
      const candidate = lines[index];
      let marker = null;
      const colonIndex = candidate.indexOf(':');
      if (colonIndex >= 6) {
        marker = candidate.slice(0, colonIndex + 1).trim();
      } else if (/^\d+\./.test(candidate) || candidate.startsWith('- ')) {
        marker = candidate.slice(0, Math.min(candidate.length, 24)).trimEnd();
      }
      if (!marker || marker.length < 8 || seenMarkers.has(marker)) {
        continue;
      }
      seenMarkers.add(marker);
      markerNeedles.push(marker);
    }
    return [...exactNeedles, ...markerNeedles];
  }

  function paneContainsBufferedTail(lines, needles) {
    if (!Array.isArray(lines) || lines.length === 0 || !Array.isArray(needles) || needles.length === 0) {
      return false;
    }
    const normalizedLines = lines
      .map((line) => stripAnsi(String(line)).trimEnd())
      .filter((line) => line.trim() !== '');
    if (normalizedLines.length === 0) {
      return false;
    }
    const trailingWindow = normalizedLines.slice(-Math.max(8, needles.length * 4));
    return needles.some((needle) => trailingWindow.some((line) => line.includes(needle)));
  }

  async function maybeRescueBufferedSubmit(paneId, text, input = {}) {
    const enabled = normalizeBoolean(input.rescue_submit_if_buffered, text.includes('\n'));
    if (!enabled) {
      return {
        enabled: false,
        attempted: false,
        attempt_count: 0,
        rescued: false,
        matched_line: null,
        matched_lines: [],
        buffered_still_visible: false,
        wait_ms: 0
      };
    }

    const tailLines = buildBufferedTailNeedles(text);
    const tailLine = tailLines[0] ?? null;
    if (!tailLine) {
      return {
        enabled: true,
        attempted: false,
        attempt_count: 0,
        rescued: false,
        matched_line: null,
        matched_lines: [],
        buffered_still_visible: false,
        wait_ms: 0
      };
    }

    const waitMs = parseInteger(input.rescue_submit_delay_ms, 140, 20);
    const pollMs = parseInteger(input.rescue_submit_poll_ms, 60, 20);
    const timeoutMs = parseInteger(input.rescue_submit_timeout_ms, 520, waitMs);
    const maxAttempts = parseInteger(input.rescue_submit_max_attempts, 2, 1);
    const lineCount = parseInteger(input.rescue_submit_capture_lines, Math.max(helperInjectProbeCaptureLines, 16), 8);
    const startedAt = now();
    const deadline = startedAt + timeoutMs;
    let attemptCount = 0;

    await delayMs(waitMs);

    while (now() <= deadline) {
      const lines = await capturePaneTail(paneId, lineCount);
      const appearsBuffered = paneContainsBufferedTail(lines, tailLines);
      if (!appearsBuffered) {
        return {
          enabled: true,
          attempted: attemptCount > 0,
          attempt_count: attemptCount,
          rescued: attemptCount > 0,
          matched_line: tailLine,
          matched_lines: tailLines,
          buffered_still_visible: false,
          wait_ms: Math.max(0, now() - startedAt)
        };
      }
      if (attemptCount < maxAttempts) {
        await runTmux(['send-keys', '-t', paneId, 'C-m']);
        attemptCount += 1;
      }
      await delayMs(pollMs);
    }

    return {
      enabled: true,
      attempted: attemptCount > 0,
      attempt_count: attemptCount,
      rescued: false,
      matched_line: tailLine,
      matched_lines: tailLines,
      buffered_still_visible: true,
      wait_ms: Math.max(0, now() - startedAt)
    };
  }

  function detectStartupBlocker(cleanedLines) {
    const joined = cleanedLines.join('\n');
    if (/do you trust (this )?folder\?/i.test(joined) || /trust folder/i.test(joined)) {
      return {
        reason: 'trust_prompt',
        message: 'startup blocked: trust prompt'
      };
    }
    return null;
  }

  function analyzePaneReadiness(lines) {
    const cleanedLines = Array.isArray(lines)
      ? lines.map((line) => stripAnsi(line)).map((line) => line.trimEnd())
      : [];
    const nonEmptyLines = cleanedLines.filter((line) => line.trim() !== '');
    const joined = cleanedLines.join('\n');
    const blocker = detectStartupBlocker(cleanedLines);
    const hasCodexCommand = /\bcodex(?:\s|$)/i.test(joined);
    const hasCodexBanner = cleanedLines.some((line) => /OpenAI Codex/i.test(line));
    const hasCodexPrompt = cleanedLines.some((line) => line.trimStart().startsWith('›'));
    const hasCodexStatus = cleanedLines.some((line) => /gpt-[\w.-]+/i.test(line) && /left/i.test(line));
    const hasGeminiBanner = cleanedLines.some((line) => /Gemini CLI/i.test(line));
    const hasGeminiPrompt = cleanedLines.some((line) => /Type your message(?: or @path\/to\/file)?/i.test(line));
    const hasGenericPrompt = cleanedLines.some((line) => {
      const trimmed = line.trim();
      return trimmed === '>' || trimmed === '›';
    });
    const snapshotSignature = nonEmptyLines.join('\n');
    const observedAgent = hasCodexCommand || hasCodexBanner
      ? 'codex'
      : hasGeminiBanner || /logged in with google/i.test(joined)
        ? 'gemini'
        : 'generic';

    if (blocker) {
      return {
        observed_agent: observedAgent,
        ready: false,
        should_wait: false,
        blocked: true,
        blocked_reason: blocker.reason,
        blocked_message: blocker.message,
        ready_reason: null,
        snapshot_signature: snapshotSignature,
        has_meaningful_output: nonEmptyLines.length > 0
      };
    }

    if (hasCodexCommand || hasCodexBanner) {
      const ready = hasCodexBanner && hasCodexPrompt && hasCodexStatus;
      return {
        observed_agent: 'codex',
        ready,
        should_wait: !ready,
        blocked: false,
        blocked_reason: null,
        blocked_message: null,
        ready_reason: ready ? 'prompt_hint' : null,
        snapshot_signature: snapshotSignature,
        has_meaningful_output: nonEmptyLines.length > 0
      };
    }

    if (hasGeminiBanner && hasGeminiPrompt && hasGenericPrompt) {
      return {
        observed_agent: 'gemini',
        ready: true,
        should_wait: false,
        blocked: false,
        blocked_reason: null,
        blocked_message: null,
        ready_reason: 'prompt_hint',
        snapshot_signature: snapshotSignature,
        has_meaningful_output: nonEmptyLines.length > 0
      };
    }

    return {
      observed_agent: observedAgent,
      ready: false,
      should_wait: true,
      blocked: false,
      blocked_reason: null,
      blocked_message: null,
      ready_reason: null,
      snapshot_signature: snapshotSignature,
      has_meaningful_output: nonEmptyLines.length > 0
    };
  }

  async function waitForPaneReady(paneId, input = {}) {
    const timeoutMs = parseInteger(input.ready_timeout_ms, helperInjectReadyTimeoutMs, 0);
    const pollMs = parseInteger(input.ready_poll_ms, helperInjectReadyPollMs, 20);
    const lineCount = parseInteger(input.ready_capture_lines, helperInjectReadyCaptureLines, 10);
    const stablePollsRequired = parseInteger(input.ready_stable_polls, helperInjectReadyStablePolls, 1);
    if (timeoutMs <= 0) {
      return {
        waited_for_ready: false,
        observed_agent: 'generic',
        ready: false,
        timed_out: false,
        waited_ms: 0,
        ready_reason: null,
        blocked: false,
        blocked_reason: null,
        blocked_message: null
      };
    }

    const startedAt = now();
    const deadline = startedAt + timeoutMs;
    let lastAnalysis = {
      observed_agent: 'generic',
      ready: false,
      should_wait: true,
      blocked: false,
      blocked_reason: null,
      blocked_message: null,
      ready_reason: null,
      snapshot_signature: '',
      has_meaningful_output: false
    };
    let previousSignature = null;
    let stablePolls = 0;

    while (now() <= deadline) {
      const lines = await capturePaneTail(paneId, lineCount);
      lastAnalysis = analyzePaneReadiness(lines);
      if (lastAnalysis.blocked) {
        return {
          waited_for_ready: true,
          observed_agent: lastAnalysis.observed_agent,
          ready: false,
          timed_out: false,
          waited_ms: Math.max(0, now() - startedAt),
          ready_reason: null,
          blocked: true,
          blocked_reason: lastAnalysis.blocked_reason,
          blocked_message: lastAnalysis.blocked_message
        };
      }
      if (lastAnalysis.ready_reason === 'prompt_hint') {
        return {
          waited_for_ready: true,
          observed_agent: lastAnalysis.observed_agent,
          ready: true,
          timed_out: false,
          waited_ms: Math.max(0, now() - startedAt),
          ready_reason: 'prompt_hint',
          blocked: false,
          blocked_reason: null,
          blocked_message: null
        };
      }
      if (lastAnalysis.has_meaningful_output) {
        if (lastAnalysis.snapshot_signature !== '' && lastAnalysis.snapshot_signature === previousSignature) {
          stablePolls += 1;
        } else {
          previousSignature = lastAnalysis.snapshot_signature;
          stablePolls = 1;
        }
        if (stablePolls >= stablePollsRequired) {
          return {
            waited_for_ready: true,
            observed_agent: lastAnalysis.observed_agent,
            ready: true,
            timed_out: false,
            waited_ms: Math.max(0, now() - startedAt),
            ready_reason: 'startup_quiet',
            blocked: false,
            blocked_reason: null,
            blocked_message: null
          };
        }
      } else {
        previousSignature = null;
        stablePolls = 0;
      }
      if (!lastAnalysis.should_wait) {
        return {
          waited_for_ready: true,
          observed_agent: lastAnalysis.observed_agent,
          ready: lastAnalysis.ready,
          timed_out: false,
          waited_ms: Math.max(0, now() - startedAt),
          ready_reason: lastAnalysis.ready_reason,
          blocked: false,
          blocked_reason: null,
          blocked_message: null
        };
      }
      await delayMs(pollMs);
    }

    return {
      waited_for_ready: true,
      observed_agent: lastAnalysis.observed_agent,
      ready: false,
      timed_out: true,
      waited_ms: Math.max(0, now() - startedAt),
      ready_reason: null,
      blocked: false,
      blocked_reason: null,
      blocked_message: null
    };
  }

  function markAgentMissing(agentId, message, metadata = {}) {
    stateStore.updateAgentMetadata(agentId, metadata);
    return stateStore.setAgentStatus(agentId, 'missing', {
      message,
      message_source: 'status'
    });
  }

  async function focusAgent(agentId, input = {}) {
    const agent = getAgentStateOrThrow(agentId);
    const paneId = asNonEmptyString(agent.pane_id);
    if (!paneId) {
      markAgentMissing(agent.id, 'pane missing', {
        pane_id: null
      });
      throw createLifecycleError('invalid_state', 'focus requires pane_id');
    }
    const sessionId = asNonEmptyString(input.session_id) ?? 'default';
    const paneAvailable = await paneExists(paneId);
    if (!paneAvailable) {
      markAgentMissing(agent.id, 'pane missing', {
        pane_id: null
      });
      throw createLifecycleError('invalid_state', `focus target pane is unavailable: ${paneId}`);
    }

    if (onFocus) {
      await onFocus({
        agentId: agent.id,
        paneId,
        sessionId
      });
    }

    return {
      ok: true,
      noop: true,
      agent: getAgentStateOrThrow(agent.id),
      state: stateStore.getState(),
      action: 'focus',
      focus: {
        pane_id: paneId,
        session_id: sessionId
      }
    };
  }

  async function injectAgent(agentId, input = {}) {
    const agent = getAgentStateOrThrow(agentId);
    const paneId = asNonEmptyString(agent.pane_id);
    if (!paneId) {
      markAgentMissing(agent.id, 'pane missing', {
        pane_id: null
      });
      throw createLifecycleError('invalid_state', 'inject requires pane_id');
    }
    const paneAvailable = await paneExists(paneId);
    if (!paneAvailable) {
      markAgentMissing(agent.id, 'pane missing', {
        pane_id: null
      });
      throw createLifecycleError('invalid_state', `inject target pane is unavailable: ${paneId}`);
    }

    const text = asNonEmptyString(input.text);
    if (!text) {
      throw createLifecycleError('invalid_request', 'inject text is required');
    }
    const waitForReady = normalizeBoolean(input.wait_for_ready, helperInjectWaitForReady);
    const submit = normalizeBoolean(input.submit, true);
    const requestedReinforceSubmit = normalizeBoolean(input.reinforce_submit, false);
    const probeBeforeSend = normalizeBoolean(input.probe_before_send, false);
    const reinforceDelayMs = parseInteger(input.reinforce_delay_ms, 90, 20);
    let readiness = {
      waited_for_ready: false,
      observed_agent: 'generic',
      ready: false,
      timed_out: false,
      waited_ms: 0
    };
    let probe = {
      enabled: false,
      ok: false,
      stage: null,
      token_length: 0,
      probe_wait_ms: 0,
      clear_wait_ms: 0,
      message: null
    };

    if (waitForReady) {
      readiness = await waitForPaneReady(paneId, input);
      if (readiness.blocked) {
        stateStore.setAgentMessage(agent.id, readiness.blocked_message ?? 'startup blocked', 'status');
        throw createLifecycleError(
          'invalid_state',
          `helper startup blocked: ${readiness.blocked_reason ?? 'startup_blocked'}`
        );
      }
      if (readiness.timed_out) {
        log.warn(`[agent-lifecycle] helper ${agent.id} did not reach a ready prompt before inject timeout`);
      }
    }

    if (probeBeforeSend) {
      probe = await runInputProbe(paneId, input);
      if (!probe.ok) {
        stateStore.setAgentMessage(agent.id, probe.message ?? 'input probe failed', 'status');
        throw createLifecycleError(
          'invalid_state',
          `helper input probe failed: ${probe.stage ?? 'probe_failed'}`
        );
      }
    }

    const reinforceSubmit = requestedReinforceSubmit
      || (submit && readiness.observed_agent === 'codex' && text.includes('\n'));
    let rescueSubmit = {
      enabled: false,
      attempted: false,
      rescued: false,
      matched_line: null,
      wait_ms: 0
    };

    await pasteTextToPane(paneId, text, submit);
    if (submit) {
      if (reinforceSubmit) {
        await delayMs(reinforceDelayMs);
        await runTmux(['send-keys', '-t', paneId, 'C-m']);
      }
      rescueSubmit = await maybeRescueBufferedSubmit(paneId, text, input);
    }

    return {
      ok: true,
      noop: false,
      action: 'inject',
      agent: getAgentStateOrThrow(agent.id),
      state: stateStore.getState(),
      injection: {
        pane_id: paneId,
        text_length: text.length,
        submit,
        reinforce_submit: reinforceSubmit,
        rescue_submit: rescueSubmit,
        ready_wait: readiness,
        probe
      }
    };
  }

  async function reconcileAgents(input = {}) {
    const recreateMissingPanes = normalizeBoolean(input.recreate_missing_panes, true);
    const agents = stateStore.listAgents({
      scope: asNonEmptyString(input.scope) ?? 'active',
      stream_id: asNonEmptyString(input.stream_id)
    });
    const results = [];

    for (const listedAgent of agents) {
      const agentId = listedAgent.id;
      const worktreePath = asNonEmptyString(listedAgent.worktree_path);
      const paneId = asNonEmptyString(listedAgent.pane_id);
      const worktreeExists = worktreePath ? fs.existsSync(path.resolve(worktreePath)) : false;
      const paneAvailable = paneId ? await paneExists(paneId) : false;

      if (paneAvailable) {
        const result = listedAgent.status === 'active'
          ? {
              ok: true,
              action: 'reconcile',
              noop: true,
              agent: getAgentStateOrThrow(agentId)
            }
          : stateStore.setAgentStatus(agentId, 'active', {
              message: 'agent ready',
              message_source: 'status'
            });
        results.push({
          agent_id: agentId,
          disposition: 'kept',
          pane_id: paneId,
          result
        });
        continue;
      }

      if (paneId) {
        stateStore.updateAgentMetadata(agentId, {
          pane_id: null
        });
      }

      if (!worktreeExists) {
        const result = markAgentMissing(agentId, worktreePath ? 'worktree missing' : 'worktree unavailable', {
          pane_id: null
        });
        results.push({
          agent_id: agentId,
          disposition: 'missing',
          reason: worktreePath ? 'worktree_missing' : 'worktree_unavailable',
          result
        });
        continue;
      }

      if (!recreateMissingPanes || !tmuxEnabled) {
        const result = markAgentMissing(agentId, 'pane missing', {
          pane_id: null
        });
        results.push({
          agent_id: agentId,
          disposition: 'missing',
          reason: 'pane_missing',
          result
        });
        continue;
      }

      try {
        const pane = await startTmuxAgentPane({
          agentId,
          cwd: worktreePath,
          command: defaultAgentCommand
        });
        stateStore.updateAgentMetadata(agentId, {
          pane_id: pane.paneId
        });
        const result = stateStore.setAgentStatus(agentId, 'active', {
          message: 'agent restored after startup',
          message_source: 'status'
        });
        results.push({
          agent_id: agentId,
          disposition: 'recreated',
          pane_id: pane.paneId,
          result
        });
      } catch (error) {
        const result = markAgentMissing(agentId, `recreate failed: ${error.message}`, {
          pane_id: null
        });
        results.push({
          agent_id: agentId,
          disposition: 'missing',
          reason: 'recreate_failed',
          error: error.message,
          result
        });
      }
    }

    return {
      ok: true,
      action: 'reconcile',
      results,
      state: stateStore.getState()
    };
  }

  async function deleteAgent(agentId) {
    let agent = getAgentStateOrThrow(agentId);

    if (asNonEmptyString(agent.pane_id)) {
      const paneAvailable = await paneExists(agent.pane_id);
      if (paneAvailable) {
        const detached = await detachAgentPane(agent.id, { kill_pane: true });
        if (asNonEmptyString(detached?.agent?.pane_id)) {
          throw createLifecycleError('invalid_state', 'delete requires pane to be detached first');
        }
      } else {
        markAgentMissing(agent.id, 'stale pane detached', {
          pane_id: null
        });
      }
    }

    agent = getAgentStateOrThrow(agent.id);
    let deletedPath = null;
    if (asNonEmptyString(agent.worktree_path)) {
      const deleteResult = await deleteWorktree(agent.id);
      deletedPath = asNonEmptyString(deleteResult?.deleted_path);
    }

    agent = getAgentStateOrThrow(agent.id);
    const purged = stateStore.purgeAgent(agent.id);
    return {
      ...purged,
      action: 'delete',
      deleted_path: deletedPath
    };
  }

  async function deleteWorktree(agentId, input = {}) {
    const agent = getAgentStateOrThrow(agentId);
    const worktreePath = asNonEmptyString(agent.worktree_path);
    const sourceRepoPath = resolveRepoPath(agent.source_repo_path);
    if (asNonEmptyString(agent.pane_id)) {
      throw createLifecycleError('invalid_state', 'delete-worktree requires pane to be detached first');
    }

    if (!worktreePath) {
      const patched = stateStore.setAgentMessage(agent.id, 'worktree already absent', 'status');
      return {
        ...patched,
        ok: true,
        action: 'delete-worktree',
        noop: true,
        agent: patched.agent,
        state: patched.state
      };
    }

    const resolved = path.resolve(worktreePath);
    if (!allowExternalDelete && !isPathInsideRoot(resolved, worktreesRoot)) {
      throw createLifecycleError(
        'external_delete_forbidden',
        `worktree path outside managed root: ${resolved}`
      );
    }

    if (!fs.existsSync(resolved)) {
      await pruneGitWorktrees(sourceRepoPath);
      stateStore.updateAgentMetadata(agent.id, {
        worktree_path: null
      });
      const patched = stateStore.setAgentMessage(agent.id, 'worktree already absent', 'status');
      return {
        ...patched,
        action: 'delete-worktree',
        noop: true,
        deleted_path: resolved
      };
    }

    await runGit(sourceRepoPath, ['worktree', 'remove', '--force', resolved]);
    await pruneGitWorktrees(sourceRepoPath);
    stateStore.updateAgentMetadata(agent.id, {
      worktree_path: null
    });
    const patched = stateStore.setAgentMessage(agent.id, 'worktree deleted', 'status');
    return {
      ...patched,
      action: 'delete-worktree',
      noop: false,
      deleted_path: resolved
    };
  }

  async function dispatchAgentAction(agentId, action, input = {}) {
    switch (action) {
      case 'focus':
        return focusAgent(agentId, input);
      case 'delete':
        return deleteAgent(agentId);
      case 'delete-worktree':
      case 'delete_worktree':
        return deleteWorktree(agentId, input);
      default:
        throw createLifecycleError('invalid_request', `unsupported agent action: ${action}`);
    }
  }

  return {
    activeStreamId,
    activeTargetRepoRoot,
    getState(optionsInput = {}) {
      return stateStore.getState(optionsInput);
    },
    listAgents,
    addAgent,
    dispatchAgentAction,
    injectAgent,
    reconcileAgents
  };
}

export function createAgentLifecycleApi(options = {}) {
  const runtime = options.runtime;
  if (!runtime || typeof runtime.getState !== 'function') {
    throw new Error('runtime is required');
  }
  const maxBodyBytes = parseInteger(options.maxBodyBytes, 128 * 1024, 1024);

  return {
    async handleHttpRequest(request, response) {
      const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;
      if (!pathname.startsWith('/api/agents')) {
        return false;
      }

      try {
        if (pathname === '/api/agents') {
          if (request.method !== 'GET') {
            writeJson(response, 405, {
              ok: false,
              error: 'method_not_allowed'
            });
            return true;
          }
          writeJson(response, 200, {
            ok: true,
            active_stream_id: runtime.activeStreamId ?? null,
            active_target_repo_root: runtime.activeTargetRepoRoot ?? null,
            agents: runtime.listAgents({
              scope: parsedUrl.searchParams.get('scope'),
              stream_id: parsedUrl.searchParams.get('stream_id')
            })
          });
          return true;
        }

        if (pathname === '/api/agents/state') {
          if (request.method !== 'GET') {
            writeJson(response, 405, {
              ok: false,
              error: 'method_not_allowed'
            });
            return true;
          }
          writeJson(response, 200, {
            ok: true,
            state: runtime.getState({
              scope: parsedUrl.searchParams.get('scope'),
              stream_id: parsedUrl.searchParams.get('stream_id')
            })
          });
          return true;
        }

        if (pathname === '/api/agents/add') {
          if (request.method !== 'POST') {
            writeJson(response, 405, {
              ok: false,
              error: 'method_not_allowed'
            });
            return true;
          }
          const body = await readJsonBody(request, maxBodyBytes);
          const result = await runtime.addAgent(body);
          writeJson(response, 200, {
            ok: true,
            result
          });
          return true;
        }

        const matched = parseActionPath(pathname);
        if (!matched) {
          writeJson(response, 404, {
            ok: false,
            error: 'not_found'
          });
          return true;
        }

        if (request.method !== 'POST') {
          writeJson(response, 405, {
            ok: false,
            error: 'method_not_allowed'
          });
          return true;
        }
        const body = await readJsonBody(request, maxBodyBytes);
        const result = await runtime.dispatchAgentAction(matched.agentId, matched.action, body);
        writeJson(response, 200, {
          ok: true,
          result
        });
        return true;
      } catch (error) {
        writeJson(response, statusCodeFromError(error), {
          ok: false,
          error: error?.code ?? 'internal_error',
          detail: error?.message ?? 'unknown error'
        });
        return true;
      }
    }
  };
}
