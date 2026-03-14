import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const STREAM_STATUSES = new Set(['active', 'closed', 'orphaned', 'archived']);
const MISSION_STATUSES = new Set(['active', 'canceled', 'closed', 'obsolete']);
const REPORT_KINDS = new Set(['progress', 'done', 'question', 'blocked', 'review_findings', 'error']);
const REPORT_LIFECYCLE_STATES = new Set([
  'submitted',
  'delivered_to_inbox',
  'seen_by_owner',
  'acted_on',
  'resolved',
  'superseded',
  'dismissed'
]);
const TERMINAL_REPORT_STATES = new Set(['resolved', 'superseded', 'dismissed']);
const RESOLVABLE_REPORT_STATES = new Set(['seen_by_owner', 'acted_on', 'resolved', 'dismissed']);

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
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed) || parsed < minValue) {
    return fallback;
  }
  return parsed;
}

function asTimestamp(value, fallback = 0) {
  return asInteger(value, fallback, 0) ?? fallback;
}

function asSeverity(value, fallback = null) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, number));
}

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  return fallback;
}

function nowMs(now) {
  return Number.isFinite(now?.()) ? Math.floor(now()) : Date.now();
}

function createStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeStatePath(inputPath, repoRoot) {
  const customPath = asNonEmptyString(inputPath);
  if (customPath) {
    return path.resolve(customPath);
  }
  if (asNonEmptyString(repoRoot)) {
    return path.resolve(repoRoot, '.agent/runtime/owner-inbox-state.json');
  }
  return path.resolve(process.cwd(), '.agent/runtime/owner-inbox-state.json');
}

function createEmptyState(now) {
  const ts = nowMs(now);
  return {
    schema_version: SCHEMA_VERSION,
    updated_at: ts,
    streams: [],
    missions: [],
    reports: []
  };
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
    log.warn(`[owner-inbox] backed up corrupted state file to ${backupPath}`);
  } catch (error) {
    log.warn(`[owner-inbox] failed to backup corrupted state file: ${error.message}`);
  }
}

function normalizeStreamStatus(raw, fallback = 'active') {
  const normalized = asNonEmptyString(raw)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return STREAM_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeMissionStatus(raw, fallback = 'active') {
  const normalized = asNonEmptyString(raw)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return MISSION_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeReportKind(raw, fallback = 'progress') {
  const normalized = asNonEmptyString(raw)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return REPORT_KINDS.has(normalized) ? normalized : fallback;
}

function normalizeLifecycleState(raw, fallback = 'delivered_to_inbox') {
  const normalized = asNonEmptyString(raw)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return REPORT_LIFECYCLE_STATES.has(normalized) ? normalized : fallback;
}

function normalizeRequestedAction(raw) {
  return asNonEmptyString(raw) ?? 'none';
}

function deriveDefaultBlocking(kind) {
  return kind === 'question' || kind === 'blocked' || kind === 'error';
}

function isUnresolvedLifecycleState(lifecycleState) {
  return !TERMINAL_REPORT_STATES.has(lifecycleState);
}

function deriveAttentionClass(report) {
  if (!report || !isUnresolvedLifecycleState(report.lifecycle_state)) {
    return 'resolved';
  }
  if (report.kind === 'error') {
    return 'error';
  }
  return report.blocking ? 'blocking' : 'informational';
}

function derivePriorityRank(report) {
  if (!report || !isUnresolvedLifecycleState(report.lifecycle_state)) {
    return 999;
  }
  if (report.kind === 'question' && report.blocking) {
    return 0;
  }
  if (report.kind === 'error') {
    return 1;
  }
  if ((report.kind === 'blocked' || report.kind === 'review_findings') && report.blocking) {
    return 2;
  }
  if (report.kind === 'done') {
    return 3;
  }
  if (report.kind === 'review_findings') {
    return 4;
  }
  if (report.kind === 'progress') {
    return 5;
  }
  return report.blocking ? 2 : 6;
}

function compareReportsForPriority(left, right) {
  const leftRank = derivePriorityRank(left);
  const rightRank = derivePriorityRank(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  const leftSeverity = Number.isFinite(left?.severity) ? left.severity : -1;
  const rightSeverity = Number.isFinite(right?.severity) ? right.severity : -1;
  if (leftSeverity !== rightSeverity) {
    return rightSeverity - leftSeverity;
  }
  const leftOrder = asInteger(left?.acceptance_order, Number.MAX_SAFE_INTEGER, 0) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = asInteger(right?.acceptance_order, Number.MAX_SAFE_INTEGER, 0) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return String(left?.report_id ?? '').localeCompare(String(right?.report_id ?? ''));
}

function normalizeStream(rawStream, now) {
  const ts = nowMs(now);
  const streamId = asNonEmptyString(rawStream?.stream_id);
  const ownerAgentId = asNonEmptyString(rawStream?.owner_agent_id);
  if (!streamId || !ownerAgentId) {
    return null;
  }
  return {
    stream_id: streamId,
    owner_agent_id: ownerAgentId,
    status: normalizeStreamStatus(rawStream?.status),
    created_at: asTimestamp(rawStream?.created_at, ts),
    updated_at: asTimestamp(rawStream?.updated_at, ts),
    closed_at: asTimestamp(rawStream?.closed_at, 0),
    archived_at: asTimestamp(rawStream?.archived_at, 0),
    orphaned_at: asTimestamp(rawStream?.orphaned_at, 0)
  };
}

function normalizeMission(rawMission, now) {
  const ts = nowMs(now);
  const streamId = asNonEmptyString(rawMission?.stream_id);
  const missionId = asNonEmptyString(rawMission?.mission_id);
  const ownerAgentId = asNonEmptyString(rawMission?.owner_agent_id);
  const fromAgentId = asNonEmptyString(rawMission?.from_agent_id);
  if (!streamId || !missionId || !ownerAgentId || !fromAgentId) {
    return null;
  }
  return {
    stream_id: streamId,
    mission_id: missionId,
    owner_agent_id: ownerAgentId,
    from_agent_id: fromAgentId,
    status: normalizeMissionStatus(rawMission?.status),
    created_at: asTimestamp(rawMission?.created_at, ts),
    updated_at: asTimestamp(rawMission?.updated_at, ts),
    canceled_at: asTimestamp(rawMission?.canceled_at, 0),
    closed_at: asTimestamp(rawMission?.closed_at, 0)
  };
}

function normalizeReport(rawReport, now) {
  const ts = nowMs(now);
  const streamId = asNonEmptyString(rawReport?.stream_id);
  const missionId = asNonEmptyString(rawReport?.mission_id);
  const reportId = asNonEmptyString(rawReport?.report_id);
  const ownerAgentId = asNonEmptyString(rawReport?.owner_agent_id);
  const fromAgentId = asNonEmptyString(rawReport?.from_agent_id);
  const summary = asNonEmptyString(rawReport?.summary);
  if (!streamId || !missionId || !reportId || !ownerAgentId || !fromAgentId || !summary) {
    return null;
  }
  const kind = normalizeReportKind(rawReport?.kind);
  return {
    stream_id: streamId,
    mission_id: missionId,
    report_id: reportId,
    owner_agent_id: ownerAgentId,
    from_agent_id: fromAgentId,
    kind,
    summary,
    detail: asNonEmptyString(rawReport?.detail),
    requested_action: normalizeRequestedAction(rawReport?.requested_action),
    blocking: asBoolean(rawReport?.blocking, deriveDefaultBlocking(kind)),
    severity: asSeverity(rawReport?.severity, null),
    supersedes_report_id: asNonEmptyString(rawReport?.supersedes_report_id),
    ts: asTimestamp(rawReport?.ts, ts),
    accepted_at: asTimestamp(rawReport?.accepted_at, ts),
    acceptance_order: asInteger(rawReport?.acceptance_order, 0, 0) ?? 0,
    lifecycle_state: normalizeLifecycleState(rawReport?.lifecycle_state),
    seen_at: asTimestamp(rawReport?.seen_at, 0),
    acted_at: asTimestamp(rawReport?.acted_at, 0),
    resolved_at: asTimestamp(rawReport?.resolved_at, 0),
    superseded_at: asTimestamp(rawReport?.superseded_at, 0),
    dismissed_at: asTimestamp(rawReport?.dismissed_at, 0),
    stale_reason: asNonEmptyString(rawReport?.stale_reason)
  };
}

function normalizeState(rawState, now) {
  if (!rawState || typeof rawState !== 'object') {
    throw createStoreError('invalid_state', 'state root must be an object');
  }
  if (!Array.isArray(rawState.streams) || !Array.isArray(rawState.missions) || !Array.isArray(rawState.reports)) {
    throw createStoreError('invalid_state', 'owner inbox state arrays are malformed');
  }

  const state = createEmptyState(now);
  state.updated_at = asTimestamp(rawState.updated_at, nowMs(now));

  const streamIds = new Set();
  for (const rawStream of rawState.streams) {
    const stream = normalizeStream(rawStream, now);
    if (!stream || streamIds.has(stream.stream_id)) {
      continue;
    }
    streamIds.add(stream.stream_id);
    state.streams.push(stream);
  }

  const missionKeys = new Set();
  for (const rawMission of rawState.missions) {
    const mission = normalizeMission(rawMission, now);
    if (!mission) {
      continue;
    }
    const key = `${mission.stream_id}::${mission.mission_id}`;
    if (missionKeys.has(key)) {
      continue;
    }
    missionKeys.add(key);
    state.missions.push(mission);
  }

  const reportKeys = new Set();
  for (const rawReport of rawState.reports) {
    const report = normalizeReport(rawReport, now);
    if (!report) {
      continue;
    }
    const key = `${report.stream_id}::${report.report_id}`;
    if (reportKeys.has(key)) {
      continue;
    }
    reportKeys.add(key);
    state.reports.push(report);
  }

  return state;
}

function findStream(state, streamId) {
  return state.streams.find((stream) => stream.stream_id === streamId) ?? null;
}

function findMission(state, streamId, missionId) {
  return state.missions.find((mission) => mission.stream_id === streamId && mission.mission_id === missionId) ?? null;
}

function findReport(state, streamId, reportId) {
  return state.reports.find((report) => report.stream_id === streamId && report.report_id === reportId) ?? null;
}

function ensureStreamRecord(state, streamId, ownerAgentId, now) {
  let stream = findStream(state, streamId);
  const ts = nowMs(now);
  if (stream) {
    if (stream.owner_agent_id !== ownerAgentId) {
      throw createStoreError('not_authorized', `stream owner mismatch for ${streamId}`);
    }
    stream.updated_at = ts;
    return stream;
  }
  stream = {
    stream_id: streamId,
    owner_agent_id: ownerAgentId,
    status: 'active',
    created_at: ts,
    updated_at: ts,
    closed_at: 0,
    archived_at: 0,
    orphaned_at: 0
  };
  state.streams.push(stream);
  return stream;
}

function ensureMissionRecord(state, input, now) {
  let mission = findMission(state, input.stream_id, input.mission_id);
  const ts = nowMs(now);
  if (mission) {
    if (mission.owner_agent_id !== input.owner_agent_id || mission.from_agent_id !== input.from_agent_id) {
      throw createStoreError('not_authorized', `mission ownership mismatch for ${input.mission_id}`);
    }
    mission.updated_at = ts;
    return mission;
  }
  mission = {
    stream_id: input.stream_id,
    mission_id: input.mission_id,
    owner_agent_id: input.owner_agent_id,
    from_agent_id: input.from_agent_id,
    status: 'active',
    created_at: ts,
    updated_at: ts,
    canceled_at: 0,
    closed_at: 0
  };
  state.missions.push(mission);
  return mission;
}

function nextAcceptanceOrder(state, streamId) {
  let maxOrder = 0;
  for (const report of state.reports) {
    if (report.stream_id !== streamId) {
      continue;
    }
    const order = asInteger(report.acceptance_order, 0, 0) ?? 0;
    if (order > maxOrder) {
      maxOrder = order;
    }
  }
  return maxOrder + 1;
}

function buildSummaryForReports(reports, options = {}) {
  const unresolvedOnly = options.unresolvedOnly !== false;
  const filtered = (Array.isArray(reports) ? reports : []).filter((report) => {
    if (!unresolvedOnly) {
      return true;
    }
    return isUnresolvedLifecycleState(report.lifecycle_state);
  });
  const byAgentId = {};
  let unresolvedCount = 0;
  let blockingCount = 0;
  let informationalCount = 0;
  let errorCount = 0;
  let topReport = null;

  for (const report of filtered) {
    const attentionClass = deriveAttentionClass(report);
    if (attentionClass !== 'resolved') {
      unresolvedCount += 1;
      if (attentionClass === 'blocking') {
        blockingCount += 1;
      } else if (attentionClass === 'informational') {
        informationalCount += 1;
      } else if (attentionClass === 'error') {
        errorCount += 1;
      }
    }

    if (!topReport || compareReportsForPriority(report, topReport) < 0) {
      topReport = report;
    }

    const agentId = report.from_agent_id;
    if (!byAgentId[agentId]) {
      byAgentId[agentId] = {
        agent_id: agentId,
        unresolved_count: 0,
        blocking_count: 0,
        informational_count: 0,
        error_count: 0,
        top_report: null,
        summary: null
      };
    }
    const agentSummary = byAgentId[agentId];
    if (attentionClass !== 'resolved') {
      agentSummary.unresolved_count += 1;
      if (attentionClass === 'blocking') {
        agentSummary.blocking_count += 1;
      } else if (attentionClass === 'informational') {
        agentSummary.informational_count += 1;
      } else if (attentionClass === 'error') {
        agentSummary.error_count += 1;
      }
    }
    if (!agentSummary.top_report || compareReportsForPriority(report, agentSummary.top_report) < 0) {
      agentSummary.top_report = report;
      agentSummary.summary = report.summary;
    }
  }

  return {
    unresolved_count: unresolvedCount,
    blocking_count: blockingCount,
    informational_count: informationalCount,
    error_count: errorCount,
    top_report: topReport,
    summary: topReport?.summary ?? null,
    by_agent_id: byAgentId
  };
}

export function createOwnerInboxStateStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const log = toLogger(options.log ?? console);
  const statePath = normalizeStatePath(options.statePath, options.repoRoot);

  let loaded = false;
  let state = createEmptyState(now);

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
      state = createEmptyState(now);
      commitState();
      loaded = true;
      return clone(state);
    }

    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      state = normalizeState(parsed, now);
      loaded = true;
      commitState();
      return clone(state);
    } catch (error) {
      log.warn(`[owner-inbox] failed to load state (${error.message}); resetting state`);
      backupCorruptedStateFile(statePath, log);
      state = createEmptyState(now);
      loaded = true;
      commitState();
      return clone(state);
    }
  }

  function getState() {
    ensureLoaded();
    return clone(state);
  }

  function listReports(filters = {}) {
    ensureLoaded();
    const ownerAgentId = asNonEmptyString(filters.owner_agent_id);
    const streamId = asNonEmptyString(filters.stream_id);
    const includeResolved = asBoolean(filters.include_resolved, false);
    const reports = state.reports
      .filter((report) => {
        if (ownerAgentId && report.owner_agent_id !== ownerAgentId) {
          return false;
        }
        if (streamId && report.stream_id !== streamId) {
          return false;
        }
        if (!includeResolved && !isUnresolvedLifecycleState(report.lifecycle_state)) {
          return false;
        }
        return true;
      })
      .sort(compareReportsForPriority);
    return clone(reports);
  }

  function getInboxView(filters = {}) {
    ensureLoaded();
    const reports = listReports(filters);
    return {
      owner_agent_id: asNonEmptyString(filters.owner_agent_id),
      stream_id: asNonEmptyString(filters.stream_id),
      include_resolved: asBoolean(filters.include_resolved, false),
      reports,
      summary: buildSummaryForReports(reports, { unresolvedOnly: !asBoolean(filters.include_resolved, false) })
    };
  }

  function submitReport(input = {}) {
    ensureLoaded();
    const streamId = asNonEmptyString(input.stream_id);
    const missionId = asNonEmptyString(input.mission_id);
    const ownerAgentId = asNonEmptyString(input.owner_agent_id);
    const fromAgentId = asNonEmptyString(input.from_agent_id);
    const summary = asNonEmptyString(input.summary);
    if (!streamId || !missionId || !ownerAgentId || !fromAgentId || !summary) {
      throw createStoreError('invalid_request', 'stream_id, mission_id, owner_agent_id, from_agent_id, and summary are required');
    }

    const stream = findStream(state, streamId);
    if (stream && stream.status !== 'active') {
      return {
        ok: true,
        transport_state: 'rejected',
        reason: stream.status === 'closed' || stream.status === 'archived' ? 'closed_stream' : 'orphaned_stream',
        report: null,
        stream: clone(stream),
        mission: null,
        idempotent: false
      };
    }

    const reportId = asNonEmptyString(input.report_id) ?? randomUUID();
    const existing = findReport(state, streamId, reportId);
    if (existing) {
      return {
        ok: true,
        transport_state: 'accepted',
        reason: null,
        report: clone(existing),
        stream: clone(findStream(state, streamId)),
        mission: clone(findMission(state, streamId, missionId)),
        idempotent: true
      };
    }

    const nextStream = ensureStreamRecord(state, streamId, ownerAgentId, now);
    const nextMission = ensureMissionRecord(
      state,
      {
        stream_id: streamId,
        mission_id: missionId,
        owner_agent_id: ownerAgentId,
        from_agent_id: fromAgentId
      },
      now
    );

    const supersedesReportId = asNonEmptyString(input.supersedes_report_id);
    if (supersedesReportId) {
      const superseded = findReport(state, streamId, supersedesReportId);
      if (!superseded || superseded.from_agent_id !== fromAgentId) {
        throw createStoreError('invalid_request', `supersedes_report_id is invalid for ${streamId}:${supersedesReportId}`);
      }
      if (isUnresolvedLifecycleState(superseded.lifecycle_state)) {
        superseded.lifecycle_state = 'superseded';
        superseded.superseded_at = nowMs(now);
      }
    }

    const ts = asTimestamp(input.ts, nowMs(now));
    const kind = normalizeReportKind(input.kind);
    const report = {
      stream_id: streamId,
      mission_id: missionId,
      report_id: reportId,
      owner_agent_id: ownerAgentId,
      from_agent_id: fromAgentId,
      kind,
      summary,
      detail: asNonEmptyString(input.detail),
      requested_action: normalizeRequestedAction(input.requested_action),
      blocking: asBoolean(input.blocking, deriveDefaultBlocking(kind)),
      severity: asSeverity(input.severity, null),
      supersedes_report_id: supersedesReportId,
      ts,
      accepted_at: nowMs(now),
      acceptance_order: nextAcceptanceOrder(state, streamId),
      lifecycle_state: 'delivered_to_inbox',
      seen_at: 0,
      acted_at: 0,
      resolved_at: 0,
      superseded_at: 0,
      dismissed_at: 0,
      stale_reason: null
    };
    state.reports.push(report);
    nextStream.updated_at = report.accepted_at;
    nextMission.updated_at = report.accepted_at;
    commitState();
    return {
      ok: true,
      transport_state: 'accepted',
      reason: null,
      report: clone(report),
      stream: clone(nextStream),
      mission: clone(nextMission),
      idempotent: false
    };
  }

  function updateReportLifecycle(input = {}) {
    ensureLoaded();
    const streamId = asNonEmptyString(input.stream_id);
    const reportId = asNonEmptyString(input.report_id);
    const nextAction = normalizeLifecycleState(input.action, 'resolved');
    if (!streamId || !reportId) {
      throw createStoreError('invalid_request', 'stream_id and report_id are required');
    }
    if (!RESOLVABLE_REPORT_STATES.has(nextAction)) {
      throw createStoreError('invalid_request', `unsupported report action: ${nextAction}`);
    }
    const report = findReport(state, streamId, reportId);
    if (!report) {
      throw createStoreError('report_not_found', `report not found: ${streamId}:${reportId}`);
    }
    if (!isUnresolvedLifecycleState(report.lifecycle_state)) {
      return {
        ok: true,
        noop: true,
        report: clone(report)
      };
    }

    const ts = nowMs(now);
    report.lifecycle_state = nextAction;
    if (nextAction === 'seen_by_owner') {
      report.seen_at = ts;
    } else if (nextAction === 'acted_on') {
      report.acted_at = ts;
      if (!report.seen_at) {
        report.seen_at = ts;
      }
    } else if (nextAction === 'resolved') {
      report.resolved_at = ts;
      if (!report.seen_at) {
        report.seen_at = ts;
      }
      if (!report.acted_at) {
        report.acted_at = ts;
      }
    } else if (nextAction === 'dismissed') {
      report.dismissed_at = ts;
      if (!report.seen_at) {
        report.seen_at = ts;
      }
    }
    commitState();
    return {
      ok: true,
      noop: false,
      report: clone(report)
    };
  }

  function closeStream(input = {}) {
    ensureLoaded();
    const streamId = asNonEmptyString(input.stream_id);
    if (!streamId) {
      throw createStoreError('invalid_request', 'stream_id is required');
    }
    const stream = findStream(state, streamId);
    if (!stream) {
      throw createStoreError('stream_not_found', `stream not found: ${streamId}`);
    }
    const nextStatus = normalizeStreamStatus(input.status, 'closed');
    if (nextStatus === 'active') {
      throw createStoreError('invalid_request', 'closeStream cannot set status back to active');
    }
    if (stream.status === nextStatus) {
      return {
        ok: true,
        noop: true,
        stream: clone(stream)
      };
    }
    const ts = nowMs(now);
    stream.status = nextStatus;
    stream.updated_at = ts;
    if (nextStatus === 'closed') {
      stream.closed_at = ts;
    } else if (nextStatus === 'archived') {
      stream.archived_at = ts;
    } else if (nextStatus === 'orphaned') {
      stream.orphaned_at = ts;
    }
    commitState();
    return {
      ok: true,
      noop: false,
      stream: clone(stream)
    };
  }

  return {
    statePath,
    load,
    getState,
    listReports,
    getInboxView,
    submitReport,
    updateReportLifecycle,
    closeStream
  };
}

export function deriveOwnerInboxAttentionClass(report) {
  return deriveAttentionClass(report);
}

export function sortOwnerInboxReports(reports) {
  const list = Array.isArray(reports) ? [...reports] : [];
  list.sort(compareReportsForPriority);
  return list;
}
