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

export function deriveAgentTileTone(agent, options = {}) {
  if (options.speaking === true) {
    return 'speaking';
  }
  return normalizeAgentStatus(agent?.status) === 'active' ? 'working' : 'idle';
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
