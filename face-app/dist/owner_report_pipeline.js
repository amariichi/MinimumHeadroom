import { approvalActionMatches } from '../../scripts/agent-hook-events.mjs';

// All report producers use this path: durable inbox -> assignment -> announcement.
export function createOwnerReportPipeline({ store, assignmentStore, notify = async () => {}, log = console }) {
  let tail = Promise.resolve();
  function serialize(task) {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  }
  function pendingInputs({ agentId, sessionId }) {
    return store.listReports({}).filter(report => report.from_agent_id === agentId
      && report.source === 'mh_hook' && (sessionId === undefined || report.session_id === sessionId)
      && (report.kind === 'question' || report.kind === 'blocked'));
  }
  const remainingFor = agentId => store.listReports({}).filter(report =>
    report.from_agent_id === agentId && report.blocking).length;
  async function persistReport(input) {
    const knownReport = input.report_id && store.listReports({ stream_id: input.stream_id, include_resolved: true })
      .some(report => report.report_id === input.report_id);
    const sameScope = report => ['mission_id', 'from_agent_id', 'owner_agent_id'].every(field => report[field] === input[field]);
    if (!knownReport && input.source === 'stuck_detector' && input.kind === 'blocked' && input.observation_key && input.pane_id) {
      const native = store.listReports({ stream_id: input.stream_id }).filter(report => report.source === 'mh_hook'
        && report.kind === 'blocked' && sameScope(report) && approvalActionMatches(report, input));
      if (native.length === 1) return { result: { ok: true, transport_state: 'accepted', idempotent: true, report: native[0] }, announce: false };
    }
    const observed = !knownReport && input.source === 'mh_hook' && input.kind === 'blocked' && store.attachNativeInput
      ? store.listReports({ stream_id: input.stream_id }).filter(report => report.source === 'stuck_detector'
        && report.kind === 'blocked' && sameScope(report) && approvalActionMatches(input, report)) : [];
    // The pane can win the race with an asynchronous native hook. Enrich that
    // same durable report, so either arrival order has one inbox entry/notice.
    const result = observed.length === 1
      ? store.attachNativeInput({ ...input, report_id: observed[0].report_id }) : await store.submitReport(input);
    if (result?.transport_state !== 'accepted' || !result.report) return { result, announce: false };
    let applyReport = !result.idempotent;
    if (result.idempotent && assignmentStore?.getAssignment) {
      const report = result.report;
      const assignment = assignmentStore.getAssignment({ stream_id: report.stream_id, mission_id: report.mission_id });
      const current = store.listReports({ stream_id: report.stream_id, include_resolved: true })
        .find(other => other.report_id === assignment?.last_report_id);
      // Recover a failed bookkeeping write, without replaying an older report
      // over a newer report, resolution, or delivery of the mission.
      applyReport = assignment && assignment.last_report_id !== report.report_id
        && report.accepted_at >= Math.max(assignment.created_at || 0, assignment.last_sent_at || 0)
        && (current ? report.acceptance_order > current.acceptance_order : (assignment.last_report_at || 0) < report.accepted_at);
    }
    if (applyReport) assignmentStore?.noteReport(result.report);
    return { result, announce: !result.idempotent || Boolean(applyReport) };
  }
  async function submitReport(input) {
    const { result, announce } = await serialize(() => persistReport(input));
    if (!announce) return result;
    try {
      await notify(result.report);
    } catch (error) {
      // The report is already durable; a broken speaker must not lose it.
      log.warn?.(`[owner-report] notification failed: ${error.message}`);
    }
    return result;
  }

  function resolveInputs({ agentId, sessionId, requestId, toolName, fingerprint, cancelledTurn }) {
    const pending = () => {
      const waiting = pendingInputs({ agentId, sessionId });
      // If resolving the inbox succeeded but updating the assignment failed,
      // a redelivered answer must finish that bookkeeping rather than stick.
      const repair = store.listReports({ include_resolved: true }).filter(report =>
        report.from_agent_id === agentId && report.session_id === sessionId && report.source === 'mh_hook'
        && report.lifecycle_state === 'resolved'
        && assignmentStore?.getAssignment({ stream_id: report.stream_id, mission_id: report.mission_id })?.last_report_id === report.report_id);
      return [...waiting, ...repair];
    };
    if (!requestId && !fingerprint && !cancelledTurn) return { resolved: 0, remaining: remainingFor(agentId) };
    let matches = cancelledTurn && sessionId ? pending().filter(report => report.turn_id === cancelledTurn)
      : pending().filter(report => requestId && report.request_id === requestId && report.tool_name === toolName);
    if (!cancelledTurn && matches.length === 0 && fingerprint) {
      const candidates = pending().filter(report => !report.request_id && report.tool_name === toolName && report.tool_fingerprint === fingerprint);
      if (candidates.length === 1) matches = candidates;
    }
    return resolveReports(matches, agentId);
  }

  function resolveReports(matches, agentId) {
    for (const report of matches) {
      store.updateReportLifecycle({ stream_id: report.stream_id, report_id: report.report_id, action: 'resolved' });
      const assignment = assignmentStore?.getAssignment({ stream_id: report.stream_id, mission_id: report.mission_id });
      if (assignment?.last_report_id !== report.report_id) continue;
      const remaining = store.listReports({ stream_id: report.stream_id }).find(other =>
        other.mission_id === report.mission_id && other.from_agent_id === agentId && other.blocking);
      assignmentStore.noteReport(remaining ?? { ...report, kind: 'progress',
        report_id: `${report.report_id}:resolved`, accepted_at: Date.now() });
    }
    return { resolved: matches.length, remaining: remainingFor(agentId) };
  }

  function resolveObservedInput({ agentId, streamId, missionId, reportId }) {
    // A pane observer may resolve only the exact occurrence it previously saw.
    // Never sweep the helper, mission, or another producer's unrelated waits.
    const matches = store.listReports({ stream_id: streamId, include_resolved: true }).filter(report =>
      report.report_id === reportId && report.mission_id === missionId && report.from_agent_id === agentId
      && ['mh_hook', 'stuck_detector'].includes(report.source) && ['question', 'blocked'].includes(report.kind)
      && (report.lifecycle_state !== 'resolved'
        || assignmentStore?.getAssignment({ stream_id: streamId, mission_id: missionId })?.last_report_id === reportId));
    return resolveReports(matches, agentId);
  }

  return { submitReport,
    resolveInputs: input => serialize(() => resolveInputs(input)),
    resolveObservedInput: input => serialize(() => resolveObservedInput(input)) };
}
