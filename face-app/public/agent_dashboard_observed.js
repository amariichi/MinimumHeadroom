function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asTimestamp(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

export function resolveObservedAgentUpdatedAt(payload, nowMs = Date.now()) {
  const payloadTimestamp = asTimestamp(payload?.ts, 0);
  if (payloadTimestamp > 0) {
    return payloadTimestamp;
  }
  return asTimestamp(nowMs, 0);
}

export function collectObservedDashboardAgentIdsToPrune(observedEntries, registeredAgents = [], options = {}) {
  const entries = Array.isArray(observedEntries) ? observedEntries : [];
  const registeredIds = new Set(
    (Array.isArray(registeredAgents) ? registeredAgents : [])
      .map((agent) => asNonEmptyString(agent?.id))
      .filter(Boolean)
  );
  const authoritativeUpdatedAt = asTimestamp(options.authoritativeUpdatedAt, 0);
  const nowMs = asTimestamp(options.nowMs, Date.now());
  const retentionMs = Number.isFinite(options.retentionMs) ? Math.max(1, Math.floor(options.retentionMs)) : 0;
  const ids = [];
  for (const [agentId, agent] of entries) {
    const normalizedAgentId = asNonEmptyString(agentId);
    if (!normalizedAgentId) {
      continue;
    }
    if (registeredIds.has(normalizedAgentId)) {
      ids.push(normalizedAgentId);
      continue;
    }
    const observedUpdatedAt = asTimestamp(agent?.updated_at, 0);
    if (observedUpdatedAt <= 0) {
      ids.push(normalizedAgentId);
      continue;
    }
    if (authoritativeUpdatedAt > 0 && observedUpdatedAt <= authoritativeUpdatedAt) {
      ids.push(normalizedAgentId);
      continue;
    }
    if (retentionMs > 0 && nowMs - observedUpdatedAt > retentionMs) {
      ids.push(normalizedAgentId);
    }
  }
  return ids;
}
