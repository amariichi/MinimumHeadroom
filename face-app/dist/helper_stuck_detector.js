import { commandFingerprint, toolInputFingerprint, approvalActionMatches } from '../../scripts/agent-hook-events.mjs';

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TAIL_LINES = 40;
const DEFAULT_DETAIL_TAIL_LINES = 12;

export const DEFAULT_STUCK_PATTERNS = [
  {
    id: 'agy_command_approval',
    category: 'approval',
    regex: /^\s*Run this command\?\s*$/,
    validate: (lines, index) => lines.slice(Math.max(0, index - 6), index).some(line => /^\s*Requesting permission for:/.test(line))
      && lines.slice(index + 1).some(line => /1\. Yes, run command/.test(line))
      && lines.slice(index + 1).some(line => /2\. No, cancel/.test(line)),
    summary: () => 'helper paused on command approval prompt'
  },
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
  return lines.findLastIndex((line) => /^\s*[•●◦✻✽✶✳⠁-⣿]*\s*(?:Working|Thinking|Loading|Running)(?:\s|\(|\.{3}|…|$)/i.test(line));
}

function latestReadyLine(lines) {
  const plain = lines.findLastIndex(line => /^\s*[›>❯]\s*$/.test(line));
  // Observed Codex 0.163.0 interruption frame keeps a placeholder in its
  // otherwise empty prompt. The placeholder alone is not proof of readiness.
  const interrupted = lines.findLastIndex(line => line.trim() === '■ Conversation interrupted - use /feedback if something went wrong');
  const prompt = lines.findLastIndex(line => line.trim() === '› Ask Codex to do anything');
  const newerModal = interrupted >= 0 && lines.slice(interrupted + 1, prompt).some(line =>
    /Would you like to run the following command\?|Allow the .+ MCP server to run tool/.test(line));
  return interrupted >= 0 && prompt > interrupted && !newerModal ? Math.max(plain, prompt) : plain;
}

function actionFingerprint(lines, index) {
  const marker = lines.findLastIndex((line, i) => i <= index && /^\s*Requesting permission for:/.test(line));
  if (marker >= Math.max(0, index - 6)) {
    const inline = lines[marker].replace(/^\s*Requesting permission for:\s*/, '');
    const command = inline || lines.slice(marker + 1, index).map(line => line.trim()).filter(Boolean).join('\n');
    return commandFingerprint(command);
  }
  const shell = lines.slice(Math.max(0, index - 4)).find(line => /^\s*\$\s+/.test(line));
  return shell ? commandFingerprint(shell.replace(/^\s*\$\s+/, '')) : null;
}

function claudeBashRows(lines, index) {
  if (lines[index]?.trim() !== 'Do you want to proceed?') return null;
  const heading = lines.findLastIndex((line, i) => i < index && line.trim() === 'Bash command');
  if (heading < Math.max(0, index - 20)) return null;
  const borders = lines.map((line, i) => i > heading && i < index && /^\s*╌{8,}\s*$/.test(line) ? i : -1).filter(i => i >= 0);
  if (borders.length !== 2 || borders[1] !== index - 1) return null;
  const rows = lines.slice(borders[0] + 1, borders[1]);
  if (!rows.length || rows.length > 8 || rows.some(line => !/^\s*│/.test(line))) return null;
  return rows.map(line => line.replace(/^\s*│/, ''));
}

function approvalObservation(lines, index, pattern) {
  if (pattern.id === 'claude_approval') {
    const mcp = claudeMcpObservation(lines, index);
    if (mcp) return mcp;
    const rows = claudeBashRows(lines, index);
    if (rows) {
      // The real Bash widget adds a gutter, optional padding and display
      // breaks. Only a unique native SINGLE-LINE digest can confirm one of
      // these bounded alternatives; never infer a shell newline from display.
      let variants = [''];
      for (let i = 0; i < rows.length; i++) {
        const parts = rows[i].startsWith(' ') ? [rows[i], rows[i].slice(1)] : [rows[i]];
        variants = [...new Set(variants.flatMap(prefix => parts.flatMap(part => i ? [prefix + part, prefix + ' ' + part] : [part])))];
        if (variants.length > 128) return {};
      }
      return { action_format: 'claude_bash_box', action_wrap_fingerprints: [...new Set(variants.map(commandFingerprint))] };
    }
  }
  if (pattern.id !== 'codex_approval') return { action_fingerprint: actionFingerprint(lines, index) };
  // Codex renders its command AFTER the modal heading. Include every command
  // row, but stop at the blank separator/options instead of consuming prose.
  const start = lines.findIndex((line, i) => i > index && /^\s*\$\s+/.test(line));
  const choice = lines.findIndex((line, i) => i > index && /^\s*[›>]?\s*\d+\.\s/.test(line));
  if (start < 0 || (choice >= 0 && start >= choice)) return {};
  const gutter = lines[start].match(/^(\s*)\$/)[1];
  const rows = [lines[start].replace(/^\s*\$\s+/, '')];
  for (let i = start + 1; i < (choice < 0 ? lines.length : choice) && lines[i].trim(); i++) {
    if (!lines[i].startsWith(gutter)) return {};
    rows.push(lines[i].slice(gutter.length));
  }
  const observation = { action_fingerprint: commandFingerprint(rows.join('\n')) };
  // tmux -J cannot join widget-rendered wraps. Try only exact zero/one-space
  // boundaries, with a strict size bound. A native hash must confirm a variant;
  // no raw command is persisted and no general whitespace collapse is used.
  if (rows.length > 1 && rows.length <= 8) {
    let variants = [rows[0]];
    for (const row of rows.slice(1)) variants = variants.flatMap(prefix => [prefix + row, prefix + ' ' + row]);
    observation.action_wrap_fingerprints = [...new Set(variants.map(commandFingerprint))];
  }
  return observation;
}

function claudeMcpObservation(lines, index) {
  if (lines[index]?.trim() !== 'Do you want to proceed?') return null;
  // This observed title maps to our own exact MCP tool, not an inferred
  // snake-case conversion of arbitrary human-facing tool titles.
  const heading = lines.findLastIndex((line, i) => i < index
    && line.trim() === 'minimum_headroom — Agent Report Tool: (MCP)');
  if (heading < Math.max(0, index - 40)) return null;
  const borders = lines.map((line, i) => i > heading && i < index && /^\s*╌{8,}\s*$/.test(line) ? i : -1).filter(i => i >= 0);
  if (borders.length !== 2 || !lines.slice(borders[1] + 1, index)
    .some(line => line.trim() === 'About the minimum_headroom — Agent Report Tool:')) return null;
  const input = Object.create(null), rows = lines.slice(borders[0] + 1, borders[1]);
  if (!rows.length || rows.length > 32) return null;
  for (const row of rows) {
    const field = /^\s*([A-Za-z_][A-Za-z0-9_]*): (.+?)\s*$/.exec(row);
    if (!field || Object.hasOwn(input, field[1])) return null;
    try {
      const value = JSON.parse(field[2]);
      // Wrapped, nested or truncated tables cannot prove complete input.
      if (value !== null && typeof value === 'object') return null;
      input[field[1]] = value;
    } catch { return null; }
  }
  if (!['stream_id', 'mission_id', 'owner_agent_id', 'from_agent_id', 'kind', 'summary']
    .every(field => typeof input[field] === 'string')) return null;
  const tool = 'mcp__minimum_headroom__agent_report';
  return { runtime: 'claude', tool_name: tool, tool_fingerprint: toolInputFingerprint(tool, input), action_format: 'claude_mcp_table' };
}

function normalizeModalLine(line) {
  const text = line.trim().replace(/^[❯›>]\s*/, '');
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
  const claudeRows = claudeBashRows(lines, index);
  if (claudeRows) return JSON.stringify([claudeRows, lines.slice(index).map(normalizeModalLine).filter(Boolean)]);
  const mcp = claudeMcpObservation(lines, index);
  if (mcp) return `${mcp.tool_name}:${mcp.tool_fingerprint}`;
  const marker = lines.findLastIndex((line, i) => i < index && /^\s*Requesting permission for:/.test(line));
  const action = marker >= Math.max(0, index - 6) ? lines.slice(marker, index).map(line => line.trim())
    : lines.slice(Math.max(0, index - 6), index)
      .filter(line => /^\s*(?:Bash:|Tool:|\$\s)/.test(line)).map(normalizeModalLine);
  return [...action, ...lines.slice(index).map(normalizeModalLine)].filter(Boolean).join('\n');
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
  const submitReport = options.submitReport ?? ((input) => inboxStore.submitReport(input));
  const resolveReport = options.resolveReport;
  const onResolved = options.onResolved ?? (() => {});
  const log = options.log ?? { info() {}, warn() {}, error() {} };
  const intervalMs = Number.isInteger(options.intervalMs) && options.intervalMs >= 250 ? options.intervalMs : DEFAULT_INTERVAL_MS;
  const tailLines = Number.isInteger(options.tailLines) && options.tailLines >= 4 ? options.tailLines : DEFAULT_TAIL_LINES;
  const detailTailLines = Number.isInteger(options.detailTailLines) && options.detailTailLines >= 1 ? options.detailTailLines : DEFAULT_DETAIL_TAIL_LINES;
  const patterns = Array.isArray(options.patterns) && options.patterns.length > 0 ? options.patterns : DEFAULT_STUCK_PATTERNS;
  const fallbackStreamId = asNonEmptyString(options.fallbackStreamId) ?? null;
  const fallbackOwnerAgentId = asNonEmptyString(options.fallbackOwnerAgentId) ?? '__operator__';
  const fallbackMissionId = asNonEmptyString(options.fallbackMissionId) ?? 'ambient';

  const dedupeMap = new Map();
  const observed = new Map();
  const knownOccurrences = new Map();
  const cleared = new Map();
  let timer = null;
  let ticking = false;

  function rememberOccurrence(agentId, key, reportId) {
    const recent = knownOccurrences.get(agentId) ?? new Map();
    recent.set(key, reportId);
    while (recent.size > 64) recent.delete(recent.keys().next().value);
    knownOccurrences.set(agentId, recent);
  }

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
    const readyIndex = latestReadyLine(lines);
    const boundary = Math.max(runningIndex, readyIndex);
    const assignmentKey = [assignment?.stream_id, assignment?.mission_id, assignment?.assignment_revision,
      assignment?.last_delivery_id, assignment?.last_sent_at, assignment?.created_at].join(':');
    const candidates = patterns.map((pattern) => ({ pattern,
      index: lines.findLastIndex((line, i) => i > boundary && matches(pattern.regex, line))
    })).filter(({ pattern, index }) => index !== -1 && (!pattern.validate || pattern.validate(lines, index)));
    // A generic confirm footer belongs to the more specific modal above it.
    // Otherwise use the latest modal, not an older prompt in scrollback.
    candidates.sort((a, b) => Number(a.pattern.id === 'generic_press_enter')
      - Number(b.pattern.id === 'generic_press_enter') || b.index - a.index);
    for (const { pattern, index } of candidates) {
      const matchedLine = lines[index];
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
        const action = pattern.category === 'approval' ? approvalObservation(lines, index, pattern) : {};
        const pending = inboxStore.listReports?.({ stream_id: streamId }) ?? [];
        const scoped = pending.filter(report => report.from_agent_id === agentId && report.mission_id === missionId);
        const previous = cleared.get(agentId) !== dedupeKey && scoped.find(report => report.source === 'stuck_detector' && report.observation_key === dedupeKey);
        const native = scoped.filter(report => report.source === 'mh_hook' && report.kind === 'blocked'
          && report.owner_agent_id === ownerAgentId && approvalActionMatches(report, action));
        // The same native approval and visible modal are two observations of
        // one wait. Ambiguous multiple native calls must never be guessed away.
        const existing = previous ?? (native.length === 1 ? native[0] : null);
        if (existing) {
          rememberOccurrence(agentId, dedupeKey, existing.report_id);
          dedupeMap.set(agentId, dedupeKey);
          observed.set(agentId, { reportId: existing.report_id, streamId, missionId, paneId, assignmentKey });
          return { matched: true, suppressed: true, dedupeKey };
        }
        const knownId = knownOccurrences.get(agentId)?.get(dedupeKey);
        const known = knownId && (inboxStore.listReports?.({ stream_id: streamId, include_resolved: true }) ?? [])
          .find(report => report.report_id === knownId);
        // An already observed, natively resolved MCP occurrence can arrive
        // again in a delayed snapshot while another request is displayed.
        // A fresh matching native request above wins; a ready boundary below
        // clears this memory so a genuinely new terminal occurrence can start.
        if (action.action_format === 'claude_mcp_table' && known?.source === 'mh_hook'
            && known.lifecycle_state === 'resolved') {
          return { matched: true, suppressed: true, stale: true, dedupeKey };
        }
        const report = await submitReport({
          stream_id: streamId,
          mission_id: missionId,
          owner_agent_id: ownerAgentId,
          from_agent_id: agentId,
          kind: 'blocked',
          summary,
          detail,
          requested_action: 'check pane',
          blocking: true,
          attention_kind: pattern.category === 'approval' ? 'approval' : pattern.category === 'picker' ? 'choice' : 'other',
          source: 'stuck_detector', ...action,
          observation_key: dedupeKey, pane_id: paneId, assignment_key: assignmentKey
        });
        if (report?.ok === false || (report?.transport_state && report.transport_state !== 'accepted')) {
          return { matched: true, posted: false, dedupeKey, report };
        }
        // A successful notice covers this continuous modal occurrence. There
        // is no expiry: changing clock/footer text cannot create a new event.
        dedupeMap.set(agentId, dedupeKey);
        const reportId = report?.report?.report_id;
        if (reportId) {
          rememberOccurrence(agentId, dedupeKey, reportId);
          observed.set(agentId, { reportId, streamId, missionId, paneId, assignmentKey });
        }
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
    let prior = observed.get(agentId);
    if (!prior) {
      const persisted = (inboxStore.listReports?.({}) ?? []).filter(report => report.source === 'stuck_detector'
        && report.from_agent_id === agentId && report.pane_id === paneId && report.assignment_key === assignmentKey);
      if (persisted.length === 1) {
        const report = persisted[0];
        prior = { reportId: report.report_id, streamId: report.stream_id, missionId: report.mission_id, paneId, assignmentKey };
      }
    }
    if (prior && prior.paneId === paneId && prior.assignmentKey === assignmentKey
        && boundary >= 0 && typeof resolveReport === 'function') {
      try {
        const result = await resolveReport({ agentId, ...prior });
        if (result?.resolved || result?.remaining === 0) {
          observed.delete(agentId);
          await onResolved({ agentId, ...prior, ...result, promptIdle: readyIndex >= 0 && runningIndex === -1 });
        }
      } catch (error) {
        log.warn?.(`[helper-stuck-detector] resolve failed for ${agentId}: ${error?.message ?? error}`);
        return { matched: false, resolution_failed: true };
      }
    }
    if (boundary >= 0 && dedupeMap.has(agentId)) cleared.set(agentId, dedupeMap.get(agentId));
    if (boundary >= 0) {
      dedupeMap.delete(agentId);
      knownOccurrences.delete(agentId);
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
    knownOccurrences.clear();
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
