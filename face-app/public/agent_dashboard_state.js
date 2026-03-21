const KNOWN_AGENT_STATUSES = new Set(['active', 'missing']);
const KNOWN_ASSIGNMENT_DELIVERY_STATES = new Set(['pending', 'sent_to_tmux', 'acked', 'acked_late', 'failed', 'timeout']);
const FINAL_ASSIGNMENT_REPORT_KINDS = new Set(['done', 'review_findings']);

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

function normalizeAssignmentDeliveryState(value) {
  const normalized = asNonEmptyString(value)?.toLowerCase() ?? 'pending';
  if (!KNOWN_ASSIGNMENT_DELIVERY_STATES.has(normalized)) {
    return 'pending';
  }
  return normalized;
}

function normalizeAssignmentReportKind(value) {
  return asNonEmptyString(value)?.toLowerCase() ?? null;
}

export function normalizeDashboardAgent(rawAgent = {}, index = 0) {
  return {
    id: asNonEmptyString(rawAgent?.id) ?? `agent-${index + 1}`,
    label: asNonEmptyString(rawAgent?.label),
    status: normalizeAgentStatus(rawAgent?.status),
    slot: asInteger(rawAgent?.slot, null, 0),
    pane_id: asNonEmptyString(rawAgent?.pane_id),
    session_id: asNonEmptyString(rawAgent?.session_id),
    last_message: asNonEmptyString(rawAgent?.last_message),
    message_source: asNonEmptyString(rawAgent?.message_source),
    updated_at: asInteger(rawAgent?.updated_at, 0, 0),
    provisional: rawAgent?.provisional === true
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

export function deriveAssignmentToneOptions(assignment) {
  const deliveryState = normalizeAssignmentDeliveryState(assignment?.delivery_state);
  const reportKind = normalizeAssignmentReportKind(assignment?.last_report_kind);
  const finalReport = reportKind ? FINAL_ASSIGNMENT_REPORT_KINDS.has(reportKind) : false;
  const activeMission = (deliveryState === 'acked' || deliveryState === 'acked_late') && !finalReport;
  const needsAttention =
    deliveryState === 'failed' ||
    deliveryState === 'timeout' ||
    reportKind === 'blocked' ||
    reportKind === 'question';
  return {
    activeMission,
    needsAttention,
    suppressPromptIdle: deliveryState === 'sent_to_tmux' || activeMission
  };
}

export function deriveAgentOperationalState(agent, options = {}) {
  const agentStatus = normalizeAgentStatus(agent?.status);
  if (agentStatus !== 'active') {
    return 'missing';
  }
  if (options.error === true) {
    return 'error';
  }

  const assignment = options.assignment && typeof options.assignment === 'object' ? options.assignment : null;
  const assignmentTone = deriveAssignmentToneOptions(assignment);
  const reportKind = normalizeAssignmentReportKind(assignment?.last_report_kind);
  const deliveryState = normalizeAssignmentDeliveryState(assignment?.delivery_state);
  const inboxSummary = options.ownerInboxSummary && typeof options.ownerInboxSummary === 'object'
    ? options.ownerInboxSummary
    : null;
  const informationalCount = asInteger(inboxSummary?.informational_count, 0, 0) ?? 0;
  const nowMs = Number.isFinite(options.nowMs) ? Math.floor(options.nowMs) : Date.now();
  const assignmentReportAt = Number.isFinite(assignment?.last_report_at) ? Math.floor(assignment.last_report_at) : 0;
  const lastActivityAt = Math.max(
    Number.isFinite(options.lastActivityAt) ? Math.floor(options.lastActivityAt) : 0,
    assignmentReportAt
  );
  const recentActivityWindowMs = Number.isFinite(options.recentActivityWindowMs)
    ? Math.max(1_500, Math.floor(options.recentActivityWindowMs))
    : 10_000;
  const hasRecentActivity = lastActivityAt > 0 && nowMs - lastActivityAt < recentActivityWindowMs;
  const finalReport = reportKind ? FINAL_ASSIGNMENT_REPORT_KINDS.has(reportKind) : false;

  if (options.needsAttention === true || assignmentTone.needsAttention) {
    return 'needs_attention';
  }
  if (deliveryState === 'sent_to_tmux') {
    return 'awaiting_ack';
  }
  if (finalReport && informationalCount > 0) {
    return 'awaiting_review';
  }
  if (options.speaking === true || hasRecentActivity) {
    return 'working';
  }
  if (assignmentTone.activeMission) {
    return 'thinking';
  }
  if (options.promptIdle === true) {
    return 'idle';
  }
  return 'working';
}

export function summarizeAgentOperationalState(state) {
  switch (state) {
    case 'awaiting_ack':
      return 'awaiting_ack';
    case 'awaiting_review':
      return 'awaiting_review';
    case 'thinking':
      return 'thinking';
    case 'needs_attention':
      return 'attention';
    case 'error':
      return 'error';
    case 'missing':
      return 'missing';
    case 'idle':
      return 'idle';
    case 'working':
    default:
      return 'working';
  }
}

export function deriveOwnerInboxToneOptions(summary) {
  const blockingCount = asInteger(summary?.blocking_count, 0, 0) ?? 0;
  const errorCount = asInteger(summary?.error_count, 0, 0) ?? 0;
  return {
    needsAttention: blockingCount > 0,
    error: errorCount > 0
  };
}

export function summarizeOwnerInboxSummary(summary) {
  const explicit = asNonEmptyString(summary?.summary) ?? asNonEmptyString(summary?.top_report?.summary);
  if (explicit) {
    return explicit;
  }
  const unresolvedCount = asInteger(summary?.unresolved_count, 0, 0) ?? 0;
  if (unresolvedCount > 1) {
    return `${unresolvedCount} unresolved reports`;
  }
  if (unresolvedCount === 1) {
    return '1 unresolved report';
  }
  return null;
}

export function summarizeAgentTileMessage(agent, transientMessage = null, ownerInboxMessage = null, operationalState = null) {
  const transient = asNonEmptyString(transientMessage);
  if (transient) {
    return transient;
  }
  const inboxMessage = asNonEmptyString(ownerInboxMessage);
  if (inboxMessage) {
    return inboxMessage;
  }
  const persisted = asNonEmptyString(agent?.last_message);
  if (persisted) {
    return persisted;
  }
  switch (operationalState) {
    case 'awaiting_ack':
      return 'awaiting first report';
    case 'awaiting_review':
      return 'waiting for owner review';
    case 'thinking':
      return 'quiet, mission in progress';
    case 'needs_attention':
      return 'needs operator attention';
    case 'error':
      return 'error';
    case 'idle':
      return 'ready for next task';
    default:
      break;
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
