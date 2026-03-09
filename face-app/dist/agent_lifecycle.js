import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
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

export function createAgentLifecycleRuntime(options = {}) {
  const stateStore = options.stateStore;
  if (!stateStore || typeof stateStore.getState !== 'function') {
    throw new Error('stateStore is required');
  }

  const log = toLogger(options.log ?? console);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const repoRoot = path.resolve(asNonEmptyString(options.repoRoot) ?? process.cwd());
  const worktreesRoot = path.resolve(asNonEmptyString(options.worktreesRoot) ?? path.join(repoRoot, '.agent/worktrees'));
  const tmuxSession = asNonEmptyString(options.tmuxSession) ?? 'agent';
  const defaultAgentCommand = asNonEmptyString(options.defaultAgentCommand) ?? 'codex';
  const commandRunner = typeof options.commandRunner === 'function' ? options.commandRunner : runProcess;
  const commandTimeoutMs = parseInteger(options.commandTimeoutMs, 30_000, 500);
  const tmuxEnabled = normalizeBoolean(options.tmuxEnabled, true);
  const worktreeEnabled = normalizeBoolean(options.worktreeEnabled, true);
  const allowExternalDelete = normalizeBoolean(options.allowExternalDelete, false);
  const allowExternalWorktreeAdd = normalizeBoolean(options.allowExternalWorktreeAdd, false);
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

  async function runTmux(args) {
    if (!tmuxEnabled) {
      throw createLifecycleError('invalid_state', 'tmux orchestration is disabled');
    }
    return runCommand('tmux', args);
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
    return path.resolve(asNonEmptyString(inputPath) ?? repoRoot);
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
    const worktreePath = resolveWorktreePath(input.worktree_path, agentId);
    const explicitWorktreePath = asNonEmptyString(input.worktree_path);
    const branch = resolveBranchName(agentId, input.branch);
    const slot = parseInteger(input.slot, null, 0);
    const createWorktree = normalizeBoolean(input.create_worktree, true);
    const createTmux = normalizeBoolean(input.create_tmux, true);
    const agentCommand = asNonEmptyString(input.agent_cmd) ?? defaultAgentCommand;
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
        source_repo_path: sourceRepoPath,
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

    const message = asNonEmptyString(input.message) ?? 'focused in operator';
    const patched = stateStore.setAgentMessage(agent.id, message, 'status');
    return {
      ...patched,
      action: 'focus',
      focus: {
        pane_id: paneId,
        session_id: sessionId
      }
    };
  }

  async function reconcileAgents(input = {}) {
    const recreateMissingPanes = normalizeBoolean(input.recreate_missing_panes, true);
    const agents = stateStore.listAgents();
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
    getState() {
      return stateStore.getState();
    },
    listAgents,
    addAgent,
    dispatchAgentAction,
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
            agents: runtime.listAgents()
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
            state: runtime.getState()
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
