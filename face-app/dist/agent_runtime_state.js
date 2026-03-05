import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const DEFAULT_CAP = 4;
const HARD_CAP = 8;
const ACTIVE_STATUSES = new Set(['active', 'paused', 'parked', 'stopped']);
const KNOWN_STATUSES = new Set([...ACTIVE_STATUSES, 'removed']);

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
  if (!normalized || !KNOWN_STATUSES.has(normalized)) {
    return fallback;
  }
  return normalized;
}

function normalizeAgent(rawAgent, index, now, hardCap) {
  const ts = nowMs(now);
  const normalized = {
    id: asNonEmptyString(rawAgent?.id) ?? `agent-${index + 1}`,
    status: normalizeStatus(rawAgent?.status),
    slot: asInteger(rawAgent?.slot, null, 0),
    removed_slot: asInteger(rawAgent?.removed_slot, null, 0),
    status_before_remove: asNonEmptyString(rawAgent?.status_before_remove),
    source_repo_path: asNonEmptyString(rawAgent?.source_repo_path),
    worktree_path: asNonEmptyString(rawAgent?.worktree_path),
    branch: asNonEmptyString(rawAgent?.branch),
    pane_id: asNonEmptyString(rawAgent?.pane_id),
    last_message: asNonEmptyString(rawAgent?.last_message),
    message_source: asNonEmptyString(rawAgent?.message_source),
    created_at: asInteger(rawAgent?.created_at, ts, 0),
    updated_at: asInteger(rawAgent?.updated_at, ts, 0),
    paused_at: asInteger(rawAgent?.paused_at, null, 0),
    removed_at: asInteger(rawAgent?.removed_at, null, 0)
  };

  if (normalized.status === 'removed') {
    if (normalized.removed_slot === null && normalized.slot !== null) {
      normalized.removed_slot = normalized.slot;
    }
    normalized.slot = null;
    normalized.removed_at = normalized.removed_at ?? normalized.updated_at;
  } else {
    if (normalized.slot === null) {
      normalized.slot = index < hardCap ? index : null;
    }
    normalized.removed_slot = null;
    normalized.removed_at = null;
    if (normalized.status_before_remove && normalizeStatus(normalized.status_before_remove, '') === 'removed') {
      normalized.status_before_remove = null;
    }
  }

  if (normalized.status !== 'paused') {
    normalized.paused_at = null;
  } else {
    normalized.paused_at = normalized.paused_at ?? normalized.updated_at;
  }

  return normalized;
}

function nextAvailableSlot(agents) {
  const used = new Set();
  for (const agent of agents) {
    if (agent.status === 'removed') {
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

function normalizeState(rawState, now, hardCap) {
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
    const normalized = normalizeAgent(rawState.agents[index], index, now, hardCap);
    if (seenIds.has(normalized.id)) {
      continue;
    }
    seenIds.add(normalized.id);
    state.agents.push(normalized);
  }

  const occupied = new Set();
  for (const agent of state.agents) {
    if (agent.status === 'removed') {
      continue;
    }
    if (!Number.isInteger(agent.slot) || agent.slot < 0 || occupied.has(agent.slot)) {
      agent.slot = nextAvailableSlot(state.agents);
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

function countActiveOrParkedAgents(agents) {
  let count = 0;
  for (const agent of agents) {
    if (agent.status !== 'removed') {
      count += 1;
    }
  }
  return count;
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

  let loaded = false;
  let state = createEmptyState(now, hardCap);

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
      state = normalizeState(parsed, now, hardCap);
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

  function getState() {
    ensureLoaded();
    return clone(state);
  }

  function listAgents(options = {}) {
    ensureLoaded();
    const includeRemoved = options.includeRemoved === true;
    const listed = state.agents
      .filter((agent) => includeRemoved || agent.status !== 'removed')
      .sort((left, right) => {
        const leftSlot = Number.isInteger(left.slot) ? left.slot : Number.MAX_SAFE_INTEGER;
        const rightSlot = Number.isInteger(right.slot) ? right.slot : Number.MAX_SAFE_INTEGER;
        return leftSlot - rightSlot;
      });
    return clone(listed);
  }

  function addAgent(input = {}) {
    ensureLoaded();
    if (countActiveOrParkedAgents(state.agents) >= hardCap) {
      throw createStoreError('hard_cap_reached', `agent hard cap reached (${hardCap})`);
    }

    const id = normalizeAgentIdentity(input);
    if (findAgentById(state, id)) {
      throw createStoreError('duplicate_agent', `agent already exists: ${id}`);
    }

    const ts = nowMs(now);
    const requestedSlot = asInteger(input.slot, null, 0);
    const slot = Number.isInteger(requestedSlot) ? requestedSlot : nextAvailableSlot(state.agents);
    const occupied = new Set(
      state.agents.filter((item) => item.status !== 'removed' && Number.isInteger(item.slot)).map((item) => item.slot)
    );
    const resolvedSlot = occupied.has(slot) ? nextAvailableSlot(state.agents) : slot;
    const status = normalizeStatus(input.status, 'active');
    const normalizedStatus = status === 'removed' ? 'active' : status;

    const agent = {
      id,
      status: normalizedStatus,
      slot: resolvedSlot,
      removed_slot: null,
      status_before_remove: null,
      source_repo_path: asNonEmptyString(input.source_repo_path),
      worktree_path: asNonEmptyString(input.worktree_path),
      branch: asNonEmptyString(input.branch),
      pane_id: asNonEmptyString(input.pane_id),
      last_message: normalizeMessageValue(input.last_message),
      message_source: asNonEmptyString(input.message_source),
      created_at: ts,
      updated_at: ts,
      paused_at: normalizedStatus === 'paused' ? ts : null,
      removed_at: null
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

  function pauseAgent(agentId) {
    return transitionAgent(agentId, 'pause', (agent) => {
      if (agent.status === 'removed') {
        throw createStoreError('invalid_state', 'cannot pause a removed agent');
      }
      if (agent.status === 'paused') {
        return { noop: true };
      }
      agent.status = 'paused';
      agent.paused_at = nowMs(now);
      return { noop: false };
    });
  }

  function resumeAgent(agentId) {
    return transitionAgent(agentId, 'resume', (agent) => {
      if (agent.status === 'removed') {
        throw createStoreError('invalid_state', 'cannot resume a removed agent');
      }
      if (agent.status === 'active') {
        return { noop: true };
      }
      if (agent.status !== 'paused') {
        throw createStoreError('invalid_transition', `cannot resume from status=${agent.status}`);
      }
      agent.status = 'active';
      agent.paused_at = null;
      return { noop: false };
    });
  }

  function parkAgent(agentId) {
    return transitionAgent(agentId, 'park', (agent) => {
      if (agent.status === 'removed') {
        throw createStoreError('invalid_state', 'cannot park a removed agent');
      }
      if (agent.status === 'parked') {
        return { noop: true };
      }
      agent.status = 'parked';
      agent.paused_at = null;
      return { noop: false };
    });
  }

  function stopAgent(agentId) {
    return transitionAgent(agentId, 'stop', (agent) => {
      if (agent.status === 'removed') {
        throw createStoreError('invalid_state', 'cannot stop a removed agent');
      }
      if (agent.status === 'stopped') {
        return { noop: true };
      }
      agent.status = 'stopped';
      agent.paused_at = null;
      return { noop: false };
    });
  }

  function removeAgent(agentId) {
    return transitionAgent(agentId, 'remove', (agent) => {
      if (agent.status === 'removed') {
        return { noop: true };
      }
      agent.status_before_remove = agent.status;
      agent.removed_slot = Number.isInteger(agent.slot) ? agent.slot : agent.removed_slot;
      agent.slot = null;
      agent.status = 'removed';
      agent.removed_at = nowMs(now);
      agent.paused_at = null;
      return { noop: false };
    });
  }

  function restoreAgent(agentId) {
    return transitionAgent(agentId, 'restore', (agent) => {
      if (agent.status !== 'removed') {
        return { noop: true };
      }

      let restoredStatus = normalizeStatus(agent.status_before_remove, 'active');
      if (restoredStatus === 'removed') {
        restoredStatus = 'active';
      }
      agent.status = restoredStatus;

      const requestedSlot = Number.isInteger(agent.removed_slot) ? agent.removed_slot : nextAvailableSlot(state.agents);
      const used = new Set(
        state.agents
          .filter((item) => item.id !== agent.id && item.status !== 'removed' && Number.isInteger(item.slot))
          .map((item) => item.slot)
      );
      agent.slot = used.has(requestedSlot) ? nextAvailableSlot(state.agents) : requestedSlot;
      agent.removed_slot = null;
      agent.status_before_remove = null;
      agent.removed_at = null;
      agent.paused_at = agent.status === 'paused' ? nowMs(now) : null;
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

  return {
    hardCap,
    statePath,
    load,
    getState,
    listAgents,
    addAgent,
    pauseAgent,
    resumeAgent,
    parkAgent,
    stopAgent,
    removeAgent,
    restoreAgent,
    setAgentMessage
  };
}

