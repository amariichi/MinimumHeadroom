import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const DELIVERY_STATES = new Set(['pending', 'sent_to_tmux', 'acked', 'failed', 'timeout']);

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

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    const text = asNonEmptyString(item);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    normalized.push(text);
  }
  return normalized.length > 0 ? normalized : null;
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
    return path.resolve(repoRoot, '.agent/runtime/agent-assignment-state.json');
  }
  return path.resolve(process.cwd(), '.agent/runtime/agent-assignment-state.json');
}

function createEmptyState(now) {
  return {
    schema_version: SCHEMA_VERSION,
    updated_at: nowMs(now),
    assignments: []
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
    log.warn(`[agent-assignment] backed up corrupted state file to ${backupPath}`);
  } catch (error) {
    log.warn(`[agent-assignment] failed to backup corrupted state file: ${error.message}`);
  }
}

function normalizeDeliveryState(rawState, fallback = 'pending') {
  const normalized = asNonEmptyString(rawState)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  return DELIVERY_STATES.has(normalized) ? normalized : fallback;
}

function normalizeAssignment(rawAssignment, now) {
  const streamId = asNonEmptyString(rawAssignment?.stream_id);
  const missionId = asNonEmptyString(rawAssignment?.mission_id);
  const ownerAgentId = asNonEmptyString(rawAssignment?.owner_agent_id);
  const agentId = asNonEmptyString(rawAssignment?.agent_id);
  const goal = asNonEmptyString(rawAssignment?.goal);
  if (!streamId || !missionId || !ownerAgentId || !agentId || !goal) {
    return null;
  }
  const ts = nowMs(now);
  return {
    stream_id: streamId,
    mission_id: missionId,
    owner_agent_id: ownerAgentId,
    agent_id: agentId,
    role: asNonEmptyString(rawAssignment?.role),
    goal,
    constraints: asNonEmptyString(rawAssignment?.constraints),
    target_paths: normalizeStringList(rawAssignment?.target_paths),
    expected_output: asNonEmptyString(rawAssignment?.expected_output),
    completion_criteria: asNonEmptyString(rawAssignment?.completion_criteria),
    review_policy: asNonEmptyString(rawAssignment?.review_policy),
    timebox_minutes: asInteger(rawAssignment?.timebox_minutes, null, 1),
    max_findings: asInteger(rawAssignment?.max_findings, null, 1),
    detail: asNonEmptyString(rawAssignment?.detail),
    prompt_text: asNonEmptyString(rawAssignment?.prompt_text),
    assignment_revision: asInteger(rawAssignment?.assignment_revision, 1, 1) ?? 1,
    delivery_state: normalizeDeliveryState(rawAssignment?.delivery_state, 'pending'),
    delivery_attempts: asInteger(rawAssignment?.delivery_attempts, 0, 0) ?? 0,
    last_delivery_id: asNonEmptyString(rawAssignment?.last_delivery_id),
    last_sent_at: asInteger(rawAssignment?.last_sent_at, 0, 0) ?? 0,
    ack_deadline_at: asInteger(rawAssignment?.ack_deadline_at, 0, 0) ?? 0,
    acked_at: asInteger(rawAssignment?.acked_at, 0, 0) ?? 0,
    failed_at: asInteger(rawAssignment?.failed_at, 0, 0) ?? 0,
    timeout_at: asInteger(rawAssignment?.timeout_at, 0, 0) ?? 0,
    last_error: asNonEmptyString(rawAssignment?.last_error),
    last_report_id: asNonEmptyString(rawAssignment?.last_report_id),
    last_report_kind: asNonEmptyString(rawAssignment?.last_report_kind),
    last_report_at: asInteger(rawAssignment?.last_report_at, 0, 0) ?? 0,
    created_at: asInteger(rawAssignment?.created_at, ts, 0) ?? ts,
    updated_at: asInteger(rawAssignment?.updated_at, ts, 0) ?? ts
  };
}

function normalizeState(rawState, now) {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) {
    throw createStoreError('invalid_state', 'state root must be an object');
  }
  if (!Array.isArray(rawState.assignments)) {
    throw createStoreError('invalid_state', 'state.assignments must be an array');
  }
  const state = createEmptyState(now);
  state.updated_at = asInteger(rawState.updated_at, state.updated_at, 0) ?? state.updated_at;

  const seenKeys = new Set();
  for (const rawAssignment of rawState.assignments) {
    const normalized = normalizeAssignment(rawAssignment, now);
    if (!normalized) {
      continue;
    }
    const key = `${normalized.stream_id}:${normalized.mission_id}`;
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    state.assignments.push(normalized);
  }
  return state;
}

function findAssignment(state, streamId, missionId) {
  return state.assignments.find((item) => item.stream_id === streamId && item.mission_id === missionId) ?? null;
}

function compareAssignments(left, right) {
  const leftPending = left.delivery_state === 'sent_to_tmux' ? 0 : left.delivery_state === 'pending' ? 1 : 2;
  const rightPending = right.delivery_state === 'sent_to_tmux' ? 0 : right.delivery_state === 'pending' ? 1 : 2;
  if (leftPending !== rightPending) {
    return leftPending - rightPending;
  }
  const leftUpdated = asInteger(left.updated_at, 0, 0) ?? 0;
  const rightUpdated = asInteger(right.updated_at, 0, 0) ?? 0;
  if (leftUpdated !== rightUpdated) {
    return rightUpdated - leftUpdated;
  }
  return `${left.stream_id}:${left.mission_id}`.localeCompare(`${right.stream_id}:${right.mission_id}`);
}

function clearDeliveryState(assignment) {
  assignment.delivery_state = 'pending';
  assignment.delivery_attempts = 0;
  assignment.last_delivery_id = null;
  assignment.last_sent_at = 0;
  assignment.ack_deadline_at = 0;
  assignment.acked_at = 0;
  assignment.failed_at = 0;
  assignment.timeout_at = 0;
  assignment.last_error = null;
  assignment.last_report_id = null;
  assignment.last_report_kind = null;
  assignment.last_report_at = 0;
}

function buildSummary(assignments) {
  const summary = {
    count: assignments.length,
    by_delivery_state: {
      pending: 0,
      sent_to_tmux: 0,
      acked: 0,
      failed: 0,
      timeout: 0
    },
    by_agent_id: {}
  };
  for (const assignment of assignments) {
    summary.by_delivery_state[assignment.delivery_state] += 1;
    if (!summary.by_agent_id[assignment.agent_id]) {
      summary.by_agent_id[assignment.agent_id] = {
        count: 0,
        pending: 0,
        sent_to_tmux: 0,
        acked: 0,
        failed: 0,
        timeout: 0
      };
    }
    const bucket = summary.by_agent_id[assignment.agent_id];
    bucket.count += 1;
    bucket[assignment.delivery_state] += 1;
  }
  return summary;
}

export function createAgentAssignmentStateStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const log = toLogger(options.log ?? console);
  const statePath = normalizeStatePath(options.statePath, options.repoRoot);

  let loaded = false;
  let state = createEmptyState(now);

  function commitState() {
    state.updated_at = nowMs(now);
    writeStateFileAtomic(statePath, state);
    return clone(state);
  }

  function ensureLoaded() {
    if (!loaded) {
      load();
    }
  }

  function refreshTimeouts() {
    const ts = nowMs(now);
    let changed = false;
    for (const assignment of state.assignments) {
      if (
        assignment.delivery_state === 'sent_to_tmux' &&
        assignment.ack_deadline_at > 0 &&
        assignment.ack_deadline_at <= ts
      ) {
        assignment.delivery_state = 'timeout';
        assignment.timeout_at = ts;
        assignment.updated_at = ts;
        changed = true;
      }
    }
    if (changed) {
      commitState();
    }
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
      state = normalizeState(JSON.parse(raw), now);
      loaded = true;
      commitState();
      return clone(state);
    } catch (error) {
      log.warn(`[agent-assignment] failed to load state (${error.message}); resetting state`);
      backupCorruptedStateFile(statePath, log);
      state = createEmptyState(now);
      loaded = true;
      commitState();
      return clone(state);
    }
  }

  function getAssignment(input = {}) {
    ensureLoaded();
    refreshTimeouts();
    const streamId = asNonEmptyString(input.stream_id);
    const missionId = asNonEmptyString(input.mission_id);
    if (!streamId || !missionId) {
      return null;
    }
    const assignment = findAssignment(state, streamId, missionId);
    if (!assignment) {
      return null;
    }
    if (input.agent_id) {
      const requestedAgentId = asNonEmptyString(input.agent_id);
      if (requestedAgentId && assignment.agent_id !== requestedAgentId) {
        return null;
      }
    }
    return clone(assignment);
  }

  function getAssignmentOrThrow(input = {}) {
    const assignment = getAssignment(input);
    if (!assignment) {
      throw createStoreError(
        'assignment_not_found',
        `assignment not found: ${input.stream_id ?? '-'}:${input.mission_id ?? '-'}`
      );
    }
    return assignment;
  }

  function listAssignments(filters = {}) {
    ensureLoaded();
    refreshTimeouts();
    const streamId = asNonEmptyString(filters.stream_id);
    const ownerAgentId = asNonEmptyString(filters.owner_agent_id);
    const agentId = asNonEmptyString(filters.agent_id);
    const missionId = asNonEmptyString(filters.mission_id);
    const listed = state.assignments
      .filter((assignment) => {
        if (streamId && assignment.stream_id !== streamId) {
          return false;
        }
        if (ownerAgentId && assignment.owner_agent_id !== ownerAgentId) {
          return false;
        }
        if (agentId && assignment.agent_id !== agentId) {
          return false;
        }
        if (missionId && assignment.mission_id !== missionId) {
          return false;
        }
        return true;
      })
      .sort(compareAssignments);
    return clone(listed);
  }

  function getAssignmentsView(filters = {}) {
    const assignments = listAssignments(filters);
    return {
      stream_id: asNonEmptyString(filters.stream_id),
      owner_agent_id: asNonEmptyString(filters.owner_agent_id),
      agent_id: asNonEmptyString(filters.agent_id),
      mission_id: asNonEmptyString(filters.mission_id),
      assignments,
      summary: buildSummary(assignments)
    };
  }

  function upsertAssignment(input = {}) {
    ensureLoaded();
    const streamId = asNonEmptyString(input.stream_id);
    const missionId = asNonEmptyString(input.mission_id);
    const ownerAgentId = asNonEmptyString(input.owner_agent_id);
    const agentId = asNonEmptyString(input.agent_id);
    const goal = asNonEmptyString(input.goal);
    if (!streamId || !missionId || !ownerAgentId || !agentId || !goal) {
      throw createStoreError(
        'invalid_request',
        'stream_id, mission_id, owner_agent_id, agent_id, and goal are required'
      );
    }

    const ts = nowMs(now);
    const existing = findAssignment(state, streamId, missionId);
    if (existing) {
      existing.owner_agent_id = ownerAgentId;
      existing.agent_id = agentId;
      existing.role = asNonEmptyString(input.role);
      existing.goal = goal;
      existing.constraints = asNonEmptyString(input.constraints);
      existing.target_paths = normalizeStringList(input.target_paths);
      existing.expected_output = asNonEmptyString(input.expected_output);
      existing.completion_criteria = asNonEmptyString(input.completion_criteria);
      existing.review_policy = asNonEmptyString(input.review_policy);
      existing.timebox_minutes = asInteger(input.timebox_minutes, null, 1);
      existing.max_findings = asInteger(input.max_findings, null, 1);
      existing.detail = asNonEmptyString(input.detail);
      existing.prompt_text = asNonEmptyString(input.prompt_text);
      existing.assignment_revision += 1;
      existing.updated_at = ts;
      clearDeliveryState(existing);
      commitState();
      return {
        ok: true,
        action: 'updated',
        assignment: clone(existing)
      };
    }

    const assignment = {
      stream_id: streamId,
      mission_id: missionId,
      owner_agent_id: ownerAgentId,
      agent_id: agentId,
      role: asNonEmptyString(input.role),
      goal,
      constraints: asNonEmptyString(input.constraints),
      target_paths: normalizeStringList(input.target_paths),
      expected_output: asNonEmptyString(input.expected_output),
      completion_criteria: asNonEmptyString(input.completion_criteria),
      review_policy: asNonEmptyString(input.review_policy),
      timebox_minutes: asInteger(input.timebox_minutes, null, 1),
      max_findings: asInteger(input.max_findings, null, 1),
      detail: asNonEmptyString(input.detail),
      prompt_text: asNonEmptyString(input.prompt_text),
      assignment_revision: 1,
      delivery_state: 'pending',
      delivery_attempts: 0,
      last_delivery_id: null,
      last_sent_at: 0,
      ack_deadline_at: 0,
      acked_at: 0,
      failed_at: 0,
      timeout_at: 0,
      last_error: null,
      last_report_id: null,
      last_report_kind: null,
      last_report_at: 0,
      created_at: ts,
      updated_at: ts
    };
    state.assignments.push(assignment);
    commitState();
    return {
      ok: true,
      action: 'created',
      assignment: clone(assignment)
    };
  }

  function markDeliverySent(input = {}) {
    ensureLoaded();
    refreshTimeouts();
    const streamId = asNonEmptyString(input.stream_id);
    const missionId = asNonEmptyString(input.mission_id);
    const assignment = findAssignment(state, streamId, missionId);
    if (!assignment) {
      throw createStoreError('assignment_not_found', `assignment not found: ${streamId ?? '-'}:${missionId ?? '-'}`);
    }
    const agentId = asNonEmptyString(input.agent_id);
    if (agentId && assignment.agent_id !== agentId) {
      throw createStoreError('invalid_request', `assignment target mismatch for ${streamId}:${missionId}`);
    }
    const ts = nowMs(now);
    const ackTimeoutMs = asInteger(input.ack_timeout_ms, 20_000, 1000) ?? 20_000;
    assignment.delivery_state = 'sent_to_tmux';
    assignment.delivery_attempts += 1;
    assignment.last_delivery_id = asNonEmptyString(input.delivery_id) ?? randomUUID();
    assignment.last_sent_at = ts;
    assignment.ack_deadline_at = ts + ackTimeoutMs;
    assignment.acked_at = 0;
    assignment.failed_at = 0;
    assignment.timeout_at = 0;
    assignment.last_error = null;
    assignment.updated_at = ts;
    commitState();
    return {
      ok: true,
      assignment: clone(assignment)
    };
  }

  function markDeliveryFailed(input = {}) {
    ensureLoaded();
    refreshTimeouts();
    const streamId = asNonEmptyString(input.stream_id);
    const missionId = asNonEmptyString(input.mission_id);
    const assignment = findAssignment(state, streamId, missionId);
    if (!assignment) {
      throw createStoreError('assignment_not_found', `assignment not found: ${streamId ?? '-'}:${missionId ?? '-'}`);
    }
    const ts = nowMs(now);
    assignment.delivery_state = 'failed';
    assignment.failed_at = ts;
    assignment.ack_deadline_at = 0;
    assignment.last_error = asNonEmptyString(input.error) ?? 'delivery_failed';
    assignment.updated_at = ts;
    commitState();
    return {
      ok: true,
      assignment: clone(assignment)
    };
  }

  function noteReport(input = {}) {
    ensureLoaded();
    refreshTimeouts();
    const streamId = asNonEmptyString(input.stream_id);
    const missionId = asNonEmptyString(input.mission_id);
    const fromAgentId = asNonEmptyString(input.from_agent_id);
    const reportId = asNonEmptyString(input.report_id);
    const kind = asNonEmptyString(input.kind);
    if (!streamId || !missionId || !fromAgentId || !reportId || !kind) {
      return {
        ok: true,
        noop: true,
        assignment: null
      };
    }
    const assignment = findAssignment(state, streamId, missionId);
    if (!assignment || assignment.agent_id !== fromAgentId) {
      return {
        ok: true,
        noop: true,
        assignment: null
      };
    }
    if (assignment.last_report_id === reportId && assignment.last_report_kind === kind) {
      return {
        ok: true,
        noop: true,
        assignment: clone(assignment)
      };
    }
    const ts = asInteger(input.accepted_at, asInteger(input.ts, nowMs(now), 0) ?? nowMs(now), 0) ?? nowMs(now);
    assignment.last_report_id = reportId;
    assignment.last_report_kind = kind;
    assignment.last_report_at = ts;
    assignment.last_error = null;
    assignment.delivery_state = 'acked';
    assignment.acked_at = ts;
    assignment.ack_deadline_at = 0;
    assignment.updated_at = ts;
    commitState();
    return {
      ok: true,
      noop: false,
      assignment: clone(assignment)
    };
  }

  return {
    statePath,
    load,
    getAssignment,
    getAssignmentOrThrow,
    listAssignments,
    getAssignmentsView,
    upsertAssignment,
    markDeliverySent,
    markDeliveryFailed,
    noteReport
  };
}
