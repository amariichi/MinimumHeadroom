import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const DEFAULT_CAP = 4;
const HARD_CAP = 7;
const TRACKED_STATUSES = new Set(['active', 'missing']);

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function resolveAgentTargetRepoRoot(rawAgent, fallbackRoot = '') {
  return normalizeRepoPath(rawAgent?.target_repo_root)
    ?? normalizeRepoPath(rawAgent?.source_repo_path)
    ?? normalizeRepoPath(fallbackRoot);
}

function resolveAgentStreamId(rawAgent, fallbackRoot = '') {
  return deriveStableStreamId(rawAgent?.stream_id, resolveAgentTargetRepoRoot(rawAgent, fallbackRoot), fallbackRoot);
}

function asInteger(value, fallback = null, minValue = Number.MIN_SAFE_INTEGER) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  if (parsed < minValue) {
    return fallback;
  }
  return parsed;
}

function createStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nowMs(now) {
  return Number.isFinite(now?.()) ? Math.floor(now()) : Date.now();
}

function createEmptyState(now, hardCap = HARD_CAP) {
  const ts = nowMs(now);
  return {
    schema_version: SCHEMA_VERSION,
    updated_at: ts,
    policy: {
      default_cap: DEFAULT_CAP,
      hard_cap: hardCap
    },
    agents: []
  };
}

function normalizeStatus(raw, fallback = 'active') {
  const normalized = asNonEmptyString(raw)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === 'removed') {
    return null;
  }
  if (TRACKED_STATUSES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeAgent(rawAgent, index, now, hardCap, fallbackRoot) {
  const ts = nowMs(now);
  const normalizedStatus = normalizeStatus(rawAgent?.status, 'active');
  if (!normalizedStatus) {
    return null;
  }
  const sourceRepoPath = normalizeRepoPath(rawAgent?.source_repo_path);
  const targetRepoRoot = resolveAgentTargetRepoRoot(rawAgent, fallbackRoot);
  const streamId = resolveAgentStreamId(rawAgent, targetRepoRoot ?? fallbackRoot);
  return {
    id: asNonEmptyString(rawAgent?.id) ?? `agent-${index + 1}`,
    session_id: asNonEmptyString(rawAgent?.session_id),
    status: normalizedStatus,
    slot: asInteger(rawAgent?.slot, index < hardCap ? index : null, 0),
    stream_id: streamId,
    source_repo_path: sourceRepoPath,
    target_repo_root: targetRepoRoot,
    worktree_path: asNonEmptyString(rawAgent?.worktree_path),
    branch: asNonEmptyString(rawAgent?.branch),
    pane_id: asNonEmptyString(rawAgent?.pane_id),
    last_message: asNonEmptyString(rawAgent?.last_message),
    message_source: asNonEmptyString(rawAgent?.message_source),
    created_at: asInteger(rawAgent?.created_at, ts, 0),
    updated_at: asInteger(rawAgent?.updated_at, ts, 0)
  };
}

function nextAvailableSlot(agents, streamId = null) {
  const used = new Set();
  for (const agent of agents) {
    if (streamId && resolveAgentStreamId(agent) !== streamId) {
      continue;
    }
    if (Number.isInteger(agent.slot) && agent.slot >= 0) {
      used.add(agent.slot);
    }
  }

  let slot = 0;
  while (used.has(slot)) {
    slot += 1;
  }
  return slot;
}

function normalizeState(rawState, now, hardCap, fallbackRoot) {
  if (!rawState || typeof rawState !== 'object') {
    throw createStoreError('invalid_state', 'state root must be an object');
  }
  if (!Array.isArray(rawState.agents)) {
    throw createStoreError('invalid_state', 'state.agents must be an array');
  }

  const state = {
    schema_version: SCHEMA_VERSION,
    updated_at: asInteger(rawState.updated_at, nowMs(now), 0),
    policy: {
      default_cap: DEFAULT_CAP,
      hard_cap: hardCap
    },
    agents: []
  };

  const seenIds = new Set();
  for (let index = 0; index < rawState.agents.length; index += 1) {
    const normalized = normalizeAgent(rawState.agents[index], index, now, hardCap, fallbackRoot);
    if (!normalized || seenIds.has(normalized.id)) {
      continue;
    }
    seenIds.add(normalized.id);
    state.agents.push(normalized);
  }

  const occupiedByStream = new Map();
  for (const agent of state.agents) {
    const streamId = resolveAgentStreamId(agent, fallbackRoot);
    let occupied = occupiedByStream.get(streamId);
    if (!occupied) {
      occupied = new Set();
      occupiedByStream.set(streamId, occupied);
    }
    if (!Number.isInteger(agent.slot) || agent.slot < 0 || occupied.has(agent.slot)) {
      agent.slot = nextAvailableSlot(state.agents, streamId);
    }
    occupied.add(agent.slot);
  }

  return state;
}

function writeStateFileAtomic(statePath, state) {
  const stateDir = path.dirname(statePath);
  fs.mkdirSync(stateDir, { recursive: true });
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  const content = `${JSON.stringify(state, null, 2)}\n`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, statePath);
}

function backupCorruptedStateFile(statePath, log) {
  const backupPath = `${statePath}.bak`;
  try {
    fs.copyFileSync(statePath, backupPath);
    log.warn(`[agent-runtime] backed up corrupted state file to ${backupPath}`);
  } catch (error) {
    log.warn(`[agent-runtime] failed to backup corrupted state file: ${error.message}`);
  }
}

function countTrackedAgents(agents, streamId = null) {
  if (!Array.isArray(agents)) {
    return 0;
  }
  if (!streamId) {
    return agents.length;
  }
  return agents.filter((agent) => resolveAgentStreamId(agent) === streamId).length;
}

function normalizeStatePath(inputPath, repoRoot) {
  const customPath = asNonEmptyString(inputPath);
  if (customPath) {
    return path.resolve(customPath);
  }
  if (asNonEmptyString(repoRoot)) {
    return path.resolve(repoRoot, '.agent/runtime/agents-state.json');
  }
  return path.resolve(process.cwd(), '.agent/runtime/agents-state.json');
}

function normalizeAgentIdentity(input = {}) {
  return asNonEmptyString(input.id) ?? randomUUID();
}

function findAgentById(state, agentId) {
  return state.agents.find((agent) => agent.id === agentId) ?? null;
}

function normalizeMessageValue(value) {
  return asNonEmptyString(value);
}

export function createAgentRuntimeStateStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const hardCap = asInteger(options.hardCap, HARD_CAP, 1) ?? HARD_CAP;
  const log = toLogger(options.log ?? console);
  const statePath = normalizeStatePath(options.statePath, options.repoRoot);
  const activeTargetRepoRoot = normalizeRepoPath(options.activeTargetRepoRoot) ?? normalizeRepoPath(options.repoRoot);
  const activeStreamId = deriveStableStreamId(options.activeStreamId, activeTargetRepoRoot, options.repoRoot);

  let loaded = false;
  let state = createEmptyState(now, hardCap);

  function resolveScopeStreamId(filters = {}) {
    const requested = asNonEmptyString(filters.stream_id);
    if (requested) {
      return requested;
    }
    const scope = asNonEmptyString(filters.scope)?.toLowerCase();
    if (scope === 'all') {
      return null;
    }
    return activeStreamId;
  }

  function listScopedAgents(filters = {}) {
    const streamId = resolveScopeStreamId(filters);
    const listed = [...state.agents]
      .filter((agent) => !streamId || resolveAgentStreamId(agent, activeTargetRepoRoot) === streamId)
      .sort((left, right) => {
        const leftSlot = Number.isInteger(left.slot) ? left.slot : Number.MAX_SAFE_INTEGER;
        const rightSlot = Number.isInteger(right.slot) ? right.slot : Number.MAX_SAFE_INTEGER;
        if (leftSlot !== rightSlot) {
          return leftSlot - rightSlot;
        }
        return String(left.id).localeCompare(String(right.id));
      });
    return clone(listed);
  }

  function ensureLoaded() {
    if (!loaded) {
      load();
    }
  }

  function commitState() {
    state.updated_at = nowMs(now);
    writeStateFileAtomic(statePath, state);
    return clone(state);
  }

  function load() {
    if (!fs.existsSync(statePath)) {
      state = createEmptyState(now, hardCap);
      commitState();
      loaded = true;
      return clone(state);
    }

    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      state = normalizeState(parsed, now, hardCap, activeTargetRepoRoot ?? options.repoRoot);
      loaded = true;
      commitState();
      return clone(state);
    } catch (error) {
      log.warn(`[agent-runtime] failed to load state (${error.message}); resetting state`);
      backupCorruptedStateFile(statePath, log);
      state = createEmptyState(now, hardCap);
      loaded = true;
      commitState();
      return clone(state);
    }
  }

  function getState(filters = {}) {
    ensureLoaded();
    const agents = listScopedAgents(filters);
    return {
      schema_version: state.schema_version,
      updated_at: state.updated_at,
      policy: clone(state.policy),
      active_stream_id: activeStreamId,
      active_target_repo_root: activeTargetRepoRoot,
      hidden_agent_count: Math.max(0, state.agents.length - agents.length),
      agents
    };
  }

  function listAgents(filters = {}) {
    ensureLoaded();
    return listScopedAgents(filters);
  }

  function getAgent(agentId) {
    ensureLoaded();
    const id = asNonEmptyString(agentId);
    if (!id) {
      return null;
    }
    const found = findAgentById(state, id);
    return found ? clone(found) : null;
  }

  function addAgent(input = {}) {
    ensureLoaded();
    const sourceRepoPath = normalizeRepoPath(input.source_repo_path) ?? activeTargetRepoRoot;
    const targetRepoRoot = normalizeRepoPath(input.target_repo_root) ?? sourceRepoPath ?? activeTargetRepoRoot;
    const streamId = deriveStableStreamId(input.stream_id, targetRepoRoot, activeTargetRepoRoot);

    if (countTrackedAgents(state.agents, streamId) >= hardCap) {
      throw createStoreError('hard_cap_reached', `agent hard cap reached (${hardCap})`);
    }

    const id = normalizeAgentIdentity(input);
    if (findAgentById(state, id)) {
      throw createStoreError('duplicate_agent', `agent already exists: ${id}`);
    }

    const ts = nowMs(now);
    const requestedSlot = asInteger(input.slot, null, 0);
    const slot = Number.isInteger(requestedSlot) ? requestedSlot : nextAvailableSlot(state.agents, streamId);
    const occupied = new Set(
      state.agents
        .filter((item) => resolveAgentStreamId(item, activeTargetRepoRoot) === streamId && Number.isInteger(item.slot))
        .map((item) => item.slot)
    );
    const resolvedSlot = occupied.has(slot) ? nextAvailableSlot(state.agents, streamId) : slot;
    const status = normalizeStatus(input.status, 'active') ?? 'active';

    const agent = {
      id,
      session_id: asNonEmptyString(input.session_id),
      status,
      slot: resolvedSlot,
      stream_id: streamId,
      source_repo_path: sourceRepoPath,
      target_repo_root: targetRepoRoot,
      worktree_path: asNonEmptyString(input.worktree_path),
      branch: asNonEmptyString(input.branch),
      pane_id: asNonEmptyString(input.pane_id),
      last_message: normalizeMessageValue(input.last_message),
      message_source: asNonEmptyString(input.message_source),
      created_at: ts,
      updated_at: ts
    };

    state.agents.push(agent);
    const nextState = commitState();
    return {
      ok: true,
      action: 'add',
      noop: false,
      agent: clone(agent),
      state: nextState
    };
  }

  function transitionAgent(agentId, action, applyTransition) {
    ensureLoaded();
    const id = asNonEmptyString(agentId);
    if (!id) {
      throw createStoreError('invalid_agent_id', 'agent id is empty');
    }
    const agent = findAgentById(state, id);
    if (!agent) {
      throw createStoreError('agent_not_found', `agent not found: ${id}`);
    }

    const result = applyTransition(agent);
    if (result?.noop) {
      return {
        ok: true,
        action,
        noop: true,
        agent: clone(agent),
        state: clone(state)
      };
    }

    if (Object.prototype.hasOwnProperty.call(result ?? {}, 'message')) {
      const nextMessage = normalizeMessageValue(result?.message);
      const nextSource = asNonEmptyString(result?.message_source) ?? 'status';
      if (agent.last_message !== nextMessage || agent.message_source !== nextSource) {
        agent.last_message = nextMessage;
        agent.message_source = nextSource;
      }
    }

    agent.updated_at = nowMs(now);
    const nextState = commitState();
    return {
      ok: true,
      action,
      noop: false,
      agent: clone(agent),
      state: nextState
    };
  }

  function setAgentStatus(agentId, status, options = {}) {
    const nextStatus = normalizeStatus(status, 'active');
    if (!nextStatus) {
      throw createStoreError('invalid_status', `unsupported status: ${status}`);
    }
    const message = Object.prototype.hasOwnProperty.call(options, 'message')
      ? normalizeMessageValue(options.message)
      : undefined;
    const messageSource = asNonEmptyString(options.message_source) ?? 'status';
    return transitionAgent(agentId, 'set_status', (agent) => {
      const sameStatus = agent.status === nextStatus;
      const sameMessage = message === undefined || agent.last_message === message;
      if (sameStatus && sameMessage) {
        return { noop: true };
      }
      agent.status = nextStatus;
      if (message !== undefined) {
        return {
          noop: false,
          message,
          message_source: messageSource
        };
      }
      return { noop: false };
    });
  }

  function setAgentMessage(agentId, message, source = 'status') {
    const normalizedSource = asNonEmptyString(source) ?? 'status';
    return transitionAgent(agentId, 'set_message', (agent) => {
      const nextMessage = normalizeMessageValue(message);
      if (agent.last_message === nextMessage && agent.message_source === normalizedSource) {
        return { noop: true };
      }
      agent.last_message = nextMessage;
      agent.message_source = normalizedSource;
      return { noop: false };
    });
  }

  function updateAgentMetadata(agentId, updates = {}) {
    const nextSourceRepoPath = Object.prototype.hasOwnProperty.call(updates, 'source_repo_path')
      ? normalizeRepoPath(updates.source_repo_path)
      : undefined;
    const nextTargetRepoRoot = Object.prototype.hasOwnProperty.call(updates, 'target_repo_root')
      ? normalizeRepoPath(updates.target_repo_root)
      : undefined;
    const nextWorktreePath = Object.prototype.hasOwnProperty.call(updates, 'worktree_path')
      ? asNonEmptyString(updates.worktree_path)
      : undefined;
    const nextBranch = Object.prototype.hasOwnProperty.call(updates, 'branch')
      ? asNonEmptyString(updates.branch)
      : undefined;
    const nextPaneId = Object.prototype.hasOwnProperty.call(updates, 'pane_id')
      ? asNonEmptyString(updates.pane_id)
      : undefined;
    const nextSessionId = Object.prototype.hasOwnProperty.call(updates, 'session_id')
      ? asNonEmptyString(updates.session_id)
      : undefined;
    const nextSlot = Object.prototype.hasOwnProperty.call(updates, 'slot')
      ? asInteger(updates.slot, null, 0)
      : undefined;
    const hasStreamIdUpdate = Object.prototype.hasOwnProperty.call(updates, 'stream_id');
    const rawNextStreamId = hasStreamIdUpdate ? updates.stream_id : undefined;

    return transitionAgent(agentId, 'update_metadata', (agent) => {
      let changed = false;
      const resolvedTargetRepoRoot =
        nextTargetRepoRoot !== undefined
          ? nextTargetRepoRoot
          : nextSourceRepoPath !== undefined
            ? nextSourceRepoPath
            : agent.target_repo_root ?? agent.source_repo_path ?? activeTargetRepoRoot;
      const resolvedStreamId =
        hasStreamIdUpdate || nextTargetRepoRoot !== undefined || nextSourceRepoPath !== undefined
          ? deriveStableStreamId(
              rawNextStreamId !== undefined ? rawNextStreamId : agent.stream_id,
              resolvedTargetRepoRoot,
              activeTargetRepoRoot
            )
          : undefined;

      if (nextSourceRepoPath !== undefined && nextSourceRepoPath !== agent.source_repo_path) {
        agent.source_repo_path = nextSourceRepoPath;
        changed = true;
      }
      if (nextTargetRepoRoot !== undefined && nextTargetRepoRoot !== agent.target_repo_root) {
        agent.target_repo_root = nextTargetRepoRoot;
        changed = true;
      }
      if (resolvedStreamId !== undefined && resolvedStreamId !== agent.stream_id) {
        agent.stream_id = resolvedStreamId;
        changed = true;
      }
      if (nextWorktreePath !== undefined && nextWorktreePath !== agent.worktree_path) {
        agent.worktree_path = nextWorktreePath;
        changed = true;
      }
      if (nextBranch !== undefined && nextBranch !== agent.branch) {
        agent.branch = nextBranch;
        changed = true;
      }
      if (nextPaneId !== undefined && nextPaneId !== agent.pane_id) {
        agent.pane_id = nextPaneId;
        changed = true;
      }
      if (nextSessionId !== undefined && nextSessionId !== agent.session_id) {
        agent.session_id = nextSessionId;
        changed = true;
      }
      if (nextSlot !== undefined && nextSlot !== agent.slot) {
        agent.slot = nextSlot;
        changed = true;
      }

      return { noop: !changed };
    });
  }

  function purgeAgent(agentId) {
    ensureLoaded();
    const id = asNonEmptyString(agentId);
    if (!id) {
      throw createStoreError('invalid_agent_id', 'agent id is empty');
    }
    const index = state.agents.findIndex((agent) => agent.id === id);
    if (index < 0) {
      throw createStoreError('agent_not_found', `agent not found: ${id}`);
    }
    const agent = state.agents[index];
    if (asNonEmptyString(agent.pane_id)) {
      throw createStoreError('invalid_state', 'purge requires pane to be detached first');
    }
    if (asNonEmptyString(agent.worktree_path)) {
      throw createStoreError('invalid_state', 'purge requires worktree to be absent first');
    }
    state.agents.splice(index, 1);
    const nextState = commitState();
    return {
      ok: true,
      action: 'purge',
      noop: false,
      agent: clone(agent),
      state: nextState
    };
  }

  return {
    hardCap,
    statePath,
    activeStreamId,
    activeTargetRepoRoot,
    load,
    getState,
    getAgent,
    listAgents,
    addAgent,
    setAgentStatus,
    setAgentMessage,
    updateAgentMetadata,
    purgeAgent
  };
}
