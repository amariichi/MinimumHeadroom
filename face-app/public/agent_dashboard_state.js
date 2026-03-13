const KNOWN_AGENT_STATUSES = new Set(['active', 'missing']);

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asInteger(value, fallback = null, minValue = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed) || parsed < minValue) {
    return fallback;
  }
  return parsed;
}

export function normalizeAgentStatus(value) {
  const normalized = asNonEmptyString(value)?.toLowerCase() ?? 'active';
  if (!KNOWN_AGENT_STATUSES.has(normalized)) {
    return 'active';
  }
  return normalized;
}

export function normalizeDashboardAgent(rawAgent = {}, index = 0) {
  return {
    id: asNonEmptyString(rawAgent?.id) ?? `agent-${index + 1}`,
    status: normalizeAgentStatus(rawAgent?.status),
    slot: asInteger(rawAgent?.slot, null, 0),
    pane_id: asNonEmptyString(rawAgent?.pane_id),
    session_id: asNonEmptyString(rawAgent?.session_id),
    last_message: asNonEmptyString(rawAgent?.last_message),
    message_source: asNonEmptyString(rawAgent?.message_source),
    updated_at: asInteger(rawAgent?.updated_at, 0, 0)
  };
}

export function sortDashboardAgents(agents) {
  const list = Array.isArray(agents) ? [...agents] : [];
  list.sort((left, right) => {
    const leftSlot = Number.isInteger(left.slot) ? left.slot : Number.MAX_SAFE_INTEGER;
    const rightSlot = Number.isInteger(right.slot) ? right.slot : Number.MAX_SAFE_INTEGER;
    if (leftSlot !== rightSlot) {
      return leftSlot - rightSlot;
    }

    return String(left.id).localeCompare(String(right.id));
  });
  return list;
}

export function deriveDashboardMode(agents, options = {}) {
  if (options.isMobileUi === true) {
    return 'single';
  }
  const additionalActiveCount = Number.isFinite(options.additionalActiveCount)
    ? Math.max(0, Math.floor(options.additionalActiveCount))
    : 0;
  const activeCount = (Array.isArray(agents) ? agents : []).length + additionalActiveCount;
  return activeCount > 1 ? 'multi' : 'single';
}

export function shouldRefreshAgentActivityFromState(previousAgent, nextAgent) {
  if (!nextAgent || typeof nextAgent !== 'object') {
    return false;
  }
  if (!previousAgent || typeof previousAgent !== 'object') {
    return true;
  }
  if ((Number.isFinite(nextAgent.updated_at) ? nextAgent.updated_at : 0) > (Number.isFinite(previousAgent.updated_at) ? previousAgent.updated_at : 0)) {
    return true;
  }
  return (
    normalizeAgentStatus(previousAgent.status) !== normalizeAgentStatus(nextAgent.status) ||
    asNonEmptyString(previousAgent.last_message) !== asNonEmptyString(nextAgent.last_message) ||
    asNonEmptyString(previousAgent.message_source) !== asNonEmptyString(nextAgent.message_source) ||
    asNonEmptyString(previousAgent.pane_id) !== asNonEmptyString(nextAgent.pane_id) ||
    asNonEmptyString(previousAgent.session_id) !== asNonEmptyString(nextAgent.session_id)
  );
}

export function shouldUseAgentQuietPromptIdle(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const lastActivityAt = Number.isFinite(options.lastActivityAt)
    ? Math.floor(options.lastActivityAt)
    : 0;
  const quietMs = Number.isFinite(options.quietMs) ? Math.max(500, Math.floor(options.quietMs)) : 8_000;
  if (lastActivityAt <= 0) {
    return false;
  }
  if (options.speaking === true || options.needsAttention === true || options.promptNeedsAttention === true || options.error === true) {
    return false;
  }
  if (normalizeAgentStatus(options.agentStatus) !== 'active') {
    return false;
  }
  return nowMs - lastActivityAt >= quietMs;
}

export function resolveAgentQuietActivityAt(agent, transient = null) {
  const persistedActivityAt = Number.isFinite(agent?.updated_at) ? Math.floor(agent.updated_at) : 0;
  const transientActivityAt = transient
    ? Math.max(
        Number.isFinite(transient.lastActivityAt) ? Math.floor(transient.lastActivityAt) : 0,
        Number.isFinite(transient.lastMirrorActivityAt) ? Math.floor(transient.lastMirrorActivityAt) : 0
      )
    : 0;
  return Math.max(0, persistedActivityAt, transientActivityAt);
}

export function deriveAgentTileTone(agent, options = {}) {
  if (options.error === true) {
    return 'error';
  }
  if (options.needsAttention === true || options.attention === true) {
    return 'needs_attention';
  }
  if (options.promptIdle === true) {
    return normalizeAgentStatus(agent?.status) === 'active' ? 'prompt_idle' : 'missing';
  }
  return normalizeAgentStatus(agent?.status) === 'active' ? 'active' : 'missing';
}

export function summarizeAgentTileMessage(agent, transientMessage = null) {
  const transient = asNonEmptyString(transientMessage);
  if (transient) {
    return transient;
  }
  const persisted = asNonEmptyString(agent?.last_message);
  if (persisted) {
    return persisted;
  }
  switch (normalizeAgentStatus(agent?.status)) {
    case 'active':
      return 'working';
    case 'missing':
      return 'missing';
    default:
      return 'idle';
  }
}
