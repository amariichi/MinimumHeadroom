const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TAIL_LINES = 40;
const DEFAULT_DEDUPE_MULTIPLIER = 6;
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
    id: 'codex_picker',
    category: 'picker',
    regex: /Switch to (gpt|claude|gemini)-/,
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
    const ts = Number(candidate?.last_sent_at ?? candidate?.updated_at ?? candidate?.created_at ?? 0);
    if (ts > bestTs) {
      bestTs = ts;
      best = candidate;
    }
  }
  return best;
}

function firstMatchingLine(lines, regex) {
  for (const line of lines) {
    if (regex.test(line)) {
      return line;
    }
  }
  return null;
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
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const intervalMs = Number.isInteger(options.intervalMs) && options.intervalMs >= 250 ? options.intervalMs : DEFAULT_INTERVAL_MS;
  const tailLines = Number.isInteger(options.tailLines) && options.tailLines >= 4 ? options.tailLines : DEFAULT_TAIL_LINES;
  const detailTailLines = Number.isInteger(options.detailTailLines) && options.detailTailLines >= 1 ? options.detailTailLines : DEFAULT_DETAIL_TAIL_LINES;
  const dedupeWindowMs = Number.isInteger(options.dedupeWindowMs) && options.dedupeWindowMs >= 0 ? options.dedupeWindowMs : intervalMs * DEFAULT_DEDUPE_MULTIPLIER;
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

  async function inspectAgent(agent) {
    const agentId = asNonEmptyString(agent?.id);
    if (!agentId) {
      return { matched: false };
    }
    const paneId = asNonEmptyString(agent?.pane_id);
    if (!paneId) {
      return { matched: false };
    }
    if (agent?.status && agent.status !== 'active') {
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
      return { matched: false };
    }
    for (const pattern of patterns) {
      const matchedLine = firstMatchingLine(lines, pattern.regex);
      if (!matchedLine) {
        continue;
      }
      const dedupeKey = `${agentId}::${pattern.id}::${matchedLine.trim()}`;
      const now = clock();
      const prev = dedupeMap.get(dedupeKey);
      if (typeof prev === 'number' && now - prev < dedupeWindowMs) {
        return { matched: true, suppressed: true, dedupeKey };
      }
      dedupeMap.set(dedupeKey, now);
      const detailTail = lines.slice(-detailTailLines).join('\n');
      const matchResult = pattern.regex.exec(matchedLine);
      const summary = typeof pattern.summary === 'function'
        ? pattern.summary(matchResult ?? [matchedLine])
        : `helper paused (${pattern.id})`;
      const detail = `${matchedLine}\n---\n${detailTail}`;
      const assignment = pickLatestAssignment(assignmentStore, agentId);
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
