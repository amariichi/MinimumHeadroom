function clampPriority(value) {
  const normalized = Number.isInteger(value) ? value : Number.parseInt(value ?? '0', 10);
  if (Number.isNaN(normalized)) {
    return 0;
  }
  return Math.max(0, Math.min(3, normalized));
}

function normalizeKey(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  return value === '' ? null : value;
}

function pruneRecent(values, nowMs, windowMs) {
  if (values.length === 0) {
    return values;
  }
  const minTime = nowMs - windowMs;
  let start = 0;
  while (start < values.length && values[start] < minTime) {
    start += 1;
  }
  return start === 0 ? values : values.slice(start);
}

export function createSayGate(config = {}) {
  const dedupeMsFallback = Number.isFinite(config.dedupeMs) ? Math.max(1, config.dedupeMs) : 3_000;
  const options = {
    minIntervalPriority1Ms: Number.isFinite(config.minIntervalPriority1Ms) ? Math.max(0, config.minIntervalPriority1Ms) : 8_000,
    globalWindowMs: Number.isFinite(config.globalWindowMs) ? Math.max(1, config.globalWindowMs) : 60_000,
    globalLimitLowPriority: Number.isFinite(config.globalLimitLowPriority) ? Math.max(1, config.globalLimitLowPriority) : 3,
    sessionWindowMs: Number.isFinite(config.sessionWindowMs) ? Math.max(1, config.sessionWindowMs) : 60_000,
    sessionLimitLowPriority: Number.isFinite(config.sessionLimitLowPriority) ? Math.max(1, config.sessionLimitLowPriority) : 1,
    dedupeMsLowPriority: Number.isFinite(config.dedupeMsLowPriority) ? Math.max(1, config.dedupeMsLowPriority) : dedupeMsFallback
  };

  let lastPriority1At = -Infinity;
  let globalLowPriorityAcceptedAt = [];
  const sessionLowPriorityAcceptedAt = new Map();
  const dedupeLastSeenAt = new Map();

  function check(payload, nowMs = Date.now()) {
    const priority = clampPriority(payload?.priority ?? 0);
    const sessionId = normalizeKey(payload?.session_id ?? null) ?? '-';
    const dedupeKey = normalizeKey(payload?.dedupe_key ?? null);

    // Dedupe is opt-in via dedupe_key and never applies to priority=3.
    if (dedupeKey && priority <= 2) {
      const seenAt = dedupeLastSeenAt.get(dedupeKey);
      if (Number.isFinite(seenAt) && nowMs - seenAt < options.dedupeMsLowPriority) {
        return { allow: false, reason: 'dedupe' };
      }
    }

    if (priority === 1 && nowMs - lastPriority1At < options.minIntervalPriority1Ms) {
      return { allow: false, reason: 'min_interval' };
    }

    if (priority <= 2) {
      globalLowPriorityAcceptedAt = pruneRecent(globalLowPriorityAcceptedAt, nowMs, options.globalWindowMs);
      if (globalLowPriorityAcceptedAt.length >= options.globalLimitLowPriority) {
        return { allow: false, reason: 'global_cap' };
      }

      const existingSession = sessionLowPriorityAcceptedAt.get(sessionId) ?? [];
      const prunedSession = pruneRecent(existingSession, nowMs, options.sessionWindowMs);
      if (prunedSession.length >= options.sessionLimitLowPriority) {
        sessionLowPriorityAcceptedAt.set(sessionId, prunedSession);
        return { allow: false, reason: 'session_cap' };
      }

      prunedSession.push(nowMs);
      sessionLowPriorityAcceptedAt.set(sessionId, prunedSession);
      globalLowPriorityAcceptedAt.push(nowMs);
    }

    if (priority === 1) {
      lastPriority1At = nowMs;
    }

    if (dedupeKey && priority <= 2) {
      dedupeLastSeenAt.set(dedupeKey, nowMs);
    }

    return { allow: true };
  }

  return {
    check,
    reset() {
      lastPriority1At = -Infinity;
      globalLowPriorityAcceptedAt = [];
      sessionLowPriorityAcceptedAt.clear();
      dedupeLastSeenAt.clear();
    }
  };
}
