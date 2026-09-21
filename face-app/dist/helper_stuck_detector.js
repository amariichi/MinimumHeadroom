const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TAIL_LINES = 40;
const DEFAULT_DETAIL_TAIL_LINES = 12;

export const DEFAULT_STUCK_PATTERNS = [
  {
    id: 'claude_approval',
    category: 'approval',
    // Matches the literal "Do you want to proceed?" phrase used by both
    // Claude Code's tool-approval modal and Antigravity's permission modal.
    regex: /Do you want to proceed\?/,
    summary: () => 'helper paused on approval prompt'
  },
  {
    id: 'codex_approval',
    category: 'approval',
    // Codex uses a different opening phrase for its shell-command approval
    // modal ("Would you like to run the following command?").
    regex: /Would you like to run the following command\?/,
    summary: () => 'helper paused on approval prompt'
  },
  {
    id: 'codex_mcp_approval',
    category: 'approval',
    // Codex's MCP tool-call approval modal is a separate path from the
    // shell-command modal and reaches the pane as
    // 'Allow the <server> MCP server to run tool "<name>"?'.
    regex: /Allow the .+ MCP server to run tool/,
    summary: () => 'helper paused on MCP tool approval prompt'
  },
  {
    id: 'agy_trust_folder',
    category: 'approval',
    // Antigravity's first-run trust prompt blocks before any mission is
    // injected. It cannot be matched by the generic approval phrases.
    regex: /Do you trust the contents of this project\?/,
    summary: () => 'helper paused on workspace trust prompt'
  },
  {
    id: 'codex_picker',
    category: 'picker',
    // The /model picker header line. The previous "Switch to <model>"
    // wording only appeared on a transient confirm screen and missed the
    // primary picker that operators actually see.
    regex: /Select Model and Effort/,
    summary: () => 'helper paused on model picker'
  },
  {
    id: 'codex_quota',
    category: 'quota',
    regex: /You've hit your usage limit/,
    summary: () => 'helper blocked by usage limit'
  },
  {
    id: 'agy_survey',
    category: 'survey',
    regex: /How's the CLI experience/,
    summary: () => 'helper paused on CLI feedback survey'
  },
  {
    id: 'generic_press_enter',
    category: 'other',
    regex: /Press enter to confirm/,
    summary: () => 'helper paused waiting for confirmation'
  }
];

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function pickLatestAssignment(assignmentStore, agentId) {
  if (!assignmentStore || typeof assignmentStore.listAssignments !== 'function') {
    return null;
  }
  let assignments;
  try {
    assignments = assignmentStore.listAssignments({ agent_id: agentId });
  } catch {
    return null;
  }
  if (!Array.isArray(assignments) || assignments.length === 0) {
    return null;
  }
  let best = null;
  let bestTs = -1;
  for (const candidate of assignments) {
    const ts = assignmentStartedAt(candidate);
    if (ts > bestTs) {
      bestTs = ts;
      best = candidate;
    }
  }
  return best;
}

function assignmentStartedAt(assignment) {
  // updated_at also changes on reports. Prefer delivery time once a mission is
  // sent; a newly assigned (unsent) revision instead starts at updated_at.
  return Number(assignment?.last_sent_at) > 0
    ? Math.max(Number(assignment.last_sent_at), Number(assignment.created_at) || 0)
    : Number(assignment?.updated_at ?? assignment?.created_at ?? 0);
}

function isFinalKind(kind) {
  return kind === 'done' || kind === 'review_findings';
}

function currentFinalReport(assignment) {
  return isFinalKind(assignment?.last_report_kind)
    && Number(assignment.last_report_at ?? 0) >= assignmentStartedAt(assignment);
}

function matches(regex, line) {
  regex.lastIndex = 0;
  return regex.test(line);
}

function latestRunningLine(lines) {
  // A live activity row below a former modal is evidence that the modal has
  // cleared. The same row ABOVE a real current approval must not hide it.
  return lines.findLastIndex((line) => /^\s*[•●✻✽✶✳⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣷]*\s*(?:Working|Thinking|Loading|Running)(?:\s|\(|\.{3}|…|$)/i.test(line));
}

function normalizeModalLine(line) {
  const text = line.trim().replace(/^[›>]\s*/, '');
  // Durations/times inside the command are arguments, not a changing clock.
  if (/^(?:\$\s|Bash:|Tool:|Requesting permission for:)/.test(text)) return text.replace(/\s+/g, ' ');
  // These rows describe the surrounding terminal, not the blocking choice.
  if (/^(?:\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?|.*\b(?:context left|tokens used)\b.*|gpt-[\w.-]+.*[·│].*)$/i.test(text)) return '';
  return text.replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\b/gi, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|m|h|seconds?|minutes?|hours?)\b/gi, '<duration>')
    .replace(/\s+/g, ' ');
}

function modalFingerprint(lines, index) {
  // Include the requested action so a different command with the same generic
  // approval heading produces a new notice. Ignore clocks and terminal footer.
  const action = lines.slice(Math.max(0, index - 6), index)
    .filter((line) => /^\s*(?:Requesting permission for:|Bash:|Tool:|\$\s)/.test(line));
  return [...action, ...lines.slice(index)].map(normalizeModalLine).filter(Boolean).join('\n');
}

export function createHelperStuckDetector(options = {}) {
  const runtime = options.runtime;
  if (!runtime || typeof runtime.listAgents !== 'function' || typeof runtime.paneSnapshot !== 'function') {
    throw new Error('runtime with listAgents and paneSnapshot is required');
  }
  const inboxStore = options.inboxStore;
  if (!inboxStore || typeof inboxStore.submitReport !== 'function') {
    throw new Error('inboxStore with submitReport is required');
  }
  const assignmentStore = options.assignmentStore ?? null;
  const log = options.log ?? { info() {}, warn() {}, error() {} };
  const intervalMs = Number.isInteger(options.intervalMs) && options.intervalMs >= 250 ? options.intervalMs : DEFAULT_INTERVAL_MS;
  const tailLines = Number.isInteger(options.tailLines) && options.tailLines >= 4 ? options.tailLines : DEFAULT_TAIL_LINES;
  const detailTailLines = Number.isInteger(options.detailTailLines) && options.detailTailLines >= 1 ? options.detailTailLines : DEFAULT_DETAIL_TAIL_LINES;
  const patterns = Array.isArray(options.patterns) && options.patterns.length > 0 ? options.patterns : DEFAULT_STUCK_PATTERNS;
  const fallbackStreamId = asNonEmptyString(options.fallbackStreamId) ?? null;
  const fallbackOwnerAgentId = asNonEmptyString(options.fallbackOwnerAgentId) ?? '__operator__';
  const fallbackMissionId = asNonEmptyString(options.fallbackMissionId) ?? 'ambient';

  const dedupeMap = new Map();
  let timer = null;
  let ticking = false;

  function resolveStreamForAgent(agent) {
    return asNonEmptyString(agent?.stream_id) ?? fallbackStreamId ?? (runtime.activeStreamId ?? null);
  }

  function assignmentCompleted(assignment) {
    if (!assignment) return false;
    if (currentFinalReport(assignment)) return true;
    if (typeof inboxStore.listReports !== 'function') return false;
    try {
      // An old detector report can have overwritten last_report_kind. Search
      // final reports too, including ones the owner has already resolved.
      return inboxStore.listReports({ stream_id: assignment.stream_id,
        owner_agent_id: assignment.owner_agent_id, include_resolved: true }).some((report) =>
        report.stream_id === assignment.stream_id && report.mission_id === assignment.mission_id
        && report.from_agent_id === assignment.agent_id && report.owner_agent_id === assignment.owner_agent_id
        && isFinalKind(report.kind)
        && Number(report.accepted_at ?? report.ts ?? 0) >= assignmentStartedAt(assignment));
    } catch (error) {
      log.warn?.(`[helper-stuck-detector] completion lookup failed: ${error?.message ?? error}`);
      return false;
    }
  }

  async function inspectAgent(agent) {
    const agentId = asNonEmptyString(agent?.id);
    if (!agentId) {
      return { matched: false };
    }
    const paneId = asNonEmptyString(agent?.pane_id);
    if (!paneId) {
      dedupeMap.delete(agentId);
      return { matched: false };
    }
    if (agent?.status && agent.status !== 'active') {
      dedupeMap.delete(agentId);
      return { matched: false };
    }
    let snapshot;
    try {
      snapshot = await runtime.paneSnapshot(agentId, { tail_lines: tailLines });
    } catch (error) {
      log.warn?.(`[helper-stuck-detector] paneSnapshot failed for ${agentId}: ${error?.message ?? error}`);
      return { matched: false };
    }
    const lines = Array.isArray(snapshot?.lines) ? snapshot.lines : [];
    if (lines.length === 0) {
      dedupeMap.delete(agentId);
      return { matched: false };
    }
    // Resolve after the asynchronous snapshot, since the helper can submit its
    // final report (or receive a new mission) while that capture is in flight.
    const assignment = pickLatestAssignment(assignmentStore, agentId);
    if (assignmentCompleted(assignment)) {
      dedupeMap.delete(agentId);
      return { matched: false, completed: true };
    }
    const runningIndex = latestRunningLine(lines);
    const candidates = patterns.map((pattern) => ({ pattern,
      index: lines.findLastIndex((line, i) => i > runningIndex && matches(pattern.regex, line))
    })).filter(({ index }) => index !== -1);
    // A generic confirm footer belongs to the more specific modal above it.
    // Otherwise use the latest modal, not an older prompt in scrollback.
    candidates.sort((a, b) => Number(a.pattern.id === 'generic_press_enter')
      - Number(b.pattern.id === 'generic_press_enter') || b.index - a.index);
    for (const { pattern, index } of candidates) {
      const matchedLine = lines[index];
      const assignmentKey = [assignment?.stream_id, assignment?.mission_id, assignment?.assignment_revision,
        assignment?.last_delivery_id, assignment?.last_sent_at, assignment?.created_at].join(':');
      const dedupeKey = `${agentId}::${paneId}::${assignmentKey}::${pattern.id}::${modalFingerprint(lines, index)}`;
      if (dedupeMap.get(agentId) === dedupeKey) {
        return { matched: true, suppressed: true, dedupeKey };
      }
      const detailTail = lines.slice(-detailTailLines).join('\n');
      pattern.regex.lastIndex = 0;
      const matchResult = pattern.regex.exec(matchedLine);
      const summary = typeof pattern.summary === 'function'
        ? pattern.summary(matchResult ?? [matchedLine])
        : `helper paused (${pattern.id})`;
      const detail = `${matchedLine}\n---\n${detailTail}`;
      const streamId = asNonEmptyString(assignment?.stream_id) ?? resolveStreamForAgent(agent);
      const ownerAgentId = asNonEmptyString(assignment?.owner_agent_id) ?? fallbackOwnerAgentId;
      const missionId = asNonEmptyString(assignment?.mission_id) ?? fallbackMissionId;
      if (!streamId) {
        log.warn?.(`[helper-stuck-detector] no stream_id resolvable for ${agentId}; skipping report`);
        return { matched: true, posted: false, dedupeKey };
      }
      try {
        const report = inboxStore.submitReport({
          stream_id: streamId,
          mission_id: missionId,
          owner_agent_id: ownerAgentId,
          from_agent_id: agentId,
          kind: 'blocked',
          summary,
          detail,
          requested_action: 'check pane',
          blocking: false,
          source: 'stuck_detector'
        });
        if (report?.ok === false || (report?.transport_state && report.transport_state !== 'accepted')) {
          return { matched: true, posted: false, dedupeKey, report };
        }
        // A successful notice covers this continuous modal occurrence. There
        // is no expiry: changing clock/footer text cannot create a new event.
        dedupeMap.set(agentId, dedupeKey);
        return {
          matched: true,
          posted: true,
          dedupeKey,
          report,
          pattern_id: pattern.id,
          matched_line: matchedLine
        };
      } catch (error) {
        log.warn?.(`[helper-stuck-detector] submitReport failed for ${agentId}: ${error?.message ?? error}`);
        return { matched: true, posted: false, dedupeKey, error: error?.message ?? String(error) };
      }
    }
    dedupeMap.delete(agentId);
    return { matched: false };
  }

  async function tick() {
    if (ticking) {
      return { posted: 0, scanned: 0, busy: true };
    }
    ticking = true;
    let posted = 0;
    let scanned = 0;
    try {
      let agents = [];
      try {
        agents = runtime.listAgents({ scope: 'all' });
      } catch (error) {
        log.warn?.(`[helper-stuck-detector] listAgents failed: ${error?.message ?? error}`);
        return { posted: 0, scanned: 0 };
      }
      for (const agent of agents) {
        scanned += 1;
        const outcome = await inspectAgent(agent);
        if (outcome?.posted) {
          posted += 1;
        }
      }
      const presentIds = new Set(agents.map((agent) => agent.id));
      for (const agentId of dedupeMap.keys()) {
        if (!presentIds.has(agentId)) dedupeMap.delete(agentId);
      }
    } finally {
      ticking = false;
    }
    return { posted, scanned };
  }

  function start() {
    if (timer !== null) {
      return;
    }
    timer = setInterval(() => {
      tick().catch((error) => {
        log.error?.(`[helper-stuck-detector] tick error: ${error?.message ?? error}`);
      });
    }, intervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function resetDedupe() {
    dedupeMap.clear();
  }

  return {
    start,
    stop,
    tick,
    resetDedupe,
    get intervalMs() {
      return intervalMs;
    }
  };
}
