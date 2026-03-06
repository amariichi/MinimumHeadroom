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

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseActionPath(pathname) {
  const match = pathname.match(/^\/api\/agents\/([^/]+)\/([a-z-]+)$/);
  if (!match) {
    return null;
  }
  return {
    agentId: decodeURIComponent(match[1]),
    action: match[2]
  };
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
      return 403;
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

  async function addAgent(input = {}) {
    const agentId = asNonEmptyString(input.id) ?? randomUUID();
    const sourceRepoPath = resolveRepoPath(input.source_repo_path);
    const worktreePath = resolveWorktreePath(input.worktree_path, agentId);
    const branch = resolveBranchName(agentId, input.branch);
    const slot = parseInteger(input.slot, null, 0);
    const createWorktree = normalizeBoolean(input.create_worktree, true);
    const createTmux = normalizeBoolean(input.create_tmux, true);
    const agentCommand = asNonEmptyString(input.agent_cmd) ?? defaultAgentCommand;

    let worktreeCreated = false;
    let paneCreated = false;
    let paneId = asNonEmptyString(input.pane_id);

    if (createWorktree) {
      if (!worktreeEnabled) {
        throw createLifecycleError('invalid_state', 'worktree orchestration is disabled');
      }
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      await runGit(sourceRepoPath, ['worktree', 'add', '-b', branch, worktreePath]);
      worktreeCreated = true;
    }

    if (createTmux) {
      const pane = await startTmuxAgentPane({
        agentId,
        cwd: worktreePath,
        command: agentCommand
      });
      paneCreated = true;
      paneId = pane.paneId;
    }

    try {
      const result = stateStore.addAgent({
        id: agentId,
        status: 'active',
        slot,
        source_repo_path: sourceRepoPath,
        worktree_path: worktreePath,
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

  async function stopAgent(agentId, input = {}) {
    const agent = getAgentStateOrThrow(agentId);
    const killPane = normalizeBoolean(input.kill_pane, true);
    let paneKilled = false;

    if (killPane && tmuxEnabled && asNonEmptyString(agent.pane_id)) {
      try {
        await runTmux(['kill-pane', '-t', agent.pane_id]);
        paneKilled = true;
        stateStore.updateAgentMetadata(agent.id, {
          pane_id: null
        });
      } catch (error) {
        log.warn(`[agent-lifecycle] stop kill-pane failed (${agent.pane_id}): ${error.message}`);
      }
    }

    const result = stateStore.stopAgent(agent.id);
    return {
      ...result,
      orchestration: {
        pane_killed: paneKilled
      }
    };
  }

  async function deleteWorktree(agentId, input = {}) {
    const agent = getAgentStateOrThrow(agentId);
    const worktreePath = asNonEmptyString(agent.worktree_path);
    const sourceRepoPath = resolveRepoPath(agent.source_repo_path);

    if (!worktreePath) {
      return {
        ok: true,
        action: 'delete-worktree',
        noop: true,
        agent: jsonClone(agent),
        state: stateStore.getState()
      };
    }

    const resolved = path.resolve(worktreePath);
    const internalRoot = `${worktreesRoot}${path.sep}`;
    if (!allowExternalDelete && resolved !== worktreesRoot && !resolved.startsWith(internalRoot)) {
      throw createLifecycleError(
        'external_delete_forbidden',
        `worktree path outside managed root: ${resolved}`
      );
    }

    if (!fs.existsSync(resolved)) {
      const patched = stateStore.updateAgentMetadata(agent.id, {
        worktree_path: null
      });
      return {
        ...patched,
        action: 'delete-worktree',
        noop: true,
        deleted_path: resolved
      };
    }

    await runGit(sourceRepoPath, ['worktree', 'remove', '--force', resolved]);
    const patched = stateStore.updateAgentMetadata(agent.id, {
      worktree_path: null
    });
    return {
      ...patched,
      action: 'delete-worktree',
      noop: false,
      deleted_path: resolved
    };
  }

  async function dispatchAgentAction(agentId, action, input = {}) {
    switch (action) {
      case 'pause':
        return stateStore.pauseAgent(agentId);
      case 'resume':
        return stateStore.resumeAgent(agentId);
      case 'park':
        return stateStore.parkAgent(agentId);
      case 'stop':
        return stopAgent(agentId, input);
      case 'remove':
        return stateStore.removeAgent(agentId);
      case 'restore':
        return stateStore.restoreAgent(agentId);
      case 'delete-worktree':
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
    dispatchAgentAction
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

