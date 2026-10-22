import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CANONICAL_HOOK_EVENTS as CANONICAL_EVENTS } from '../../scripts/agent-hook-events.mjs';
import { waitSpeechSubject, waitSpeechLine, reportSpeechKey } from './wait_speech.js';

const BUILTIN_TEMPLATES = {
  permission_required: {
    ja: ['承認をお願いします。', '確認お願いします。', 'もう一度承認お願いします。'],
    en: ['Approval needed.', 'One more approval, please.', 'Approval needed to continue.']
  },
  input_required: {
    ja: ['回答をお願いします。'],
    en: ['Your answer is needed.']
  },
  choice_required: {
    ja: ['選択をお願いします。'],
    en: ['Your choice is needed.']
  },
  idle_after_response: {
    ja: ['応答が終わりました。'],
    en: ['Response ended.']
  }
};

const HISTORY_LIMIT = 8;
const CJK_REGEX = /[ぁ-ゟァ-ヿ一-鿿]/;
const SUPPORTED_LANGS = ['ja', 'en'];

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function defaultTemplatesPath() {
  return join(homedir(), '.minimum-headroom', 'face-templates.json');
}

export function createHookBridge(options = {}) {
  const log = options.log ?? console;
  const templatesPath = options.templatesPath ?? defaultTemplatesPath();
  const sayHistory = new Map();
  const lastSpoken = new Map();
  const pendingInputs = new Map();
  let cachedTemplates = null;
  let cachedTemplatesMtime = 0;

  function recordSayHistory(agentId, text) {
    const id = asNonEmptyString(agentId);
    const value = asNonEmptyString(text);
    if (!id || !value) {
      return;
    }
    const arr = sayHistory.get(id) ?? [];
    arr.push(value);
    while (arr.length > HISTORY_LIMIT) {
      arr.shift();
    }
    sayHistory.set(id, arr);
  }

  function detectLanguage(agentId) {
    const arr = sayHistory.get(agentId) ?? [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (CJK_REGEX.test(arr[i])) {
        return 'ja';
      }
      if (/[A-Za-z]/.test(arr[i])) {
        return 'en';
      }
    }
    const env = asNonEmptyString(process.env.MH_FACE_LANG);
    if (env && SUPPORTED_LANGS.includes(env)) {
      return env;
    }
    return 'en';
  }

  function loadTemplates() {
    try {
      const text = readFileSync(templatesPath, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cachedTemplates = parsed;
        cachedTemplatesMtime = Date.now();
        return parsed;
      }
    } catch {
      // fall through to built-in
    }
    return BUILTIN_TEMPLATES;
  }

  function pickLine(event, lang, agentId) {
    const templates = loadTemplates();
    const eventGroup = templates?.[event] ?? BUILTIN_TEMPLATES[event] ?? null;
    if (!eventGroup) {
      return null;
    }
    let variants = Array.isArray(eventGroup[lang]) ? eventGroup[lang] : null;
    if (!variants || variants.length === 0) {
      variants = Array.isArray(eventGroup.en) ? eventGroup.en : null;
    }
    if (!variants || variants.length === 0) {
      const fallback = BUILTIN_TEMPLATES[event]?.[lang] ?? BUILTIN_TEMPLATES[event]?.en ?? [];
      variants = fallback;
    }
    if (!variants || variants.length === 0) {
      return null;
    }
    const key = `${agentId}|${event}`;
    const last = lastSpoken.get(key);
    let pick = variants.find((v) => v !== last) ?? variants[0];
    lastSpoken.set(key, pick);
    return pick;
  }

  function buildEventPayload({ agentId, sessionId, event, ts, runtime, meta }) {
    const severity = event === 'permission_required' ? 0.9 : 0.4;
    return {
      v: 1,
      type: 'event',
      session_id: sessionId,
      agent_id: agentId,
      ts,
      name: event === 'input_required' ? 'needs_attention' : event,
      severity,
      meta: { source: 'mh_hook', runtime: runtime ?? 'unknown', hook_event: event, ...(meta ?? {}),
        ...(['permission_required', 'input_required'].includes(event) ? {
          awaiting_input: true,
          attention_kind: event === 'permission_required' ? 'approval' : meta?.input_kind?.startsWith('choice_') ? 'choice' : 'question'
        } : {}) },
      ttl_ms: 30000
    };
  }

  function buildSayPayload({ agentId, sessionId, event, ts, text }) {
    const isIdleNotification = event === 'idle_after_response';
    return {
      v: 1,
      type: 'say',
      session_id: sessionId,
      agent_id: agentId,
      ts,
      utterance_id: `hook-${event}-${ts}-utt`,
      text,
      priority: isIdleNotification ? 1 : 3,
      policy: isIdleNotification ? 'replace' : 'interrupt',
      ttl_ms: isIdleNotification ? 8000 : 30000,
      ...(isIdleNotification ? { defer_until_idle: true } : {}),
      notification_event: event,
      dedupe_key: null,
      message_id: `hook-${event}-${ts}`,
      revision: ts
    };
  }

  function selectAssignment(assignments) {
    if (!Array.isArray(assignments) || assignments.length === 0) {
      return null;
    }
    // Delivery-state sorting can put an old sent mission ahead of a new one.
    const started = a => Math.max(Number(a.created_at) || 0, Number(a.last_sent_at) || Number(a.updated_at) || 0);
    return [...assignments].sort((a, b) => started(b) - started(a))[0];
  }

  async function maybePostInboxReport({ agentId, event, text, runtime, sessionId, meta, reportId, ownerInboxStore, assignmentStore, reportPipeline }) {
    // A response boundary is never a final mission report or a progress ack.
    if (event !== 'permission_required' && event !== 'input_required') return null;
    if (!ownerInboxStore?.submitReport || !assignmentStore?.listAssignments) return null;
    const target = selectAssignment(assignmentStore.listAssignments({ agent_id: agentId }));
    if (!target?.owner_agent_id || !target.stream_id || !target.mission_id) return { reason: 'no_assignment' };
    try {
      const submit = reportPipeline?.submitReport ?? (input => ownerInboxStore.submitReport(input));
      return await submit({
        stream_id: target.stream_id, mission_id: target.mission_id,
        owner_agent_id: target.owner_agent_id, from_agent_id: agentId,
        kind: event === 'permission_required' ? 'blocked' : 'question',
        summary: text, blocking: true, source: 'mh_hook', runtime, session_id: sessionId,
        request_id: meta?.request_id, tool_name: meta?.tool_name, tool_fingerprint: meta?.tool_fingerprint,
        action_fingerprint: meta?.action_fingerprint, action_format: meta?.action_format, turn_id: meta?.turn_id,
        attention_kind: event === 'permission_required' ? 'approval' : meta?.input_kind?.startsWith('choice_') ? 'choice' : 'question',
        input_kind: meta?.input_kind ?? (event === 'permission_required' ? 'key' : 'text'),
        detail: `source=mh_hook runtime=${runtime ?? 'unknown'} hook_event=${event}`,
        report_id: reportId
      });
    } catch (error) {
      log.warn?.(`[hook-bridge] submitReport failed for ${agentId}: ${error.message}`);
      return null;
    }
  }

  async function handleHook({ payload, server, ttsController, ownerInboxStore, assignmentStore, reportPipeline } = {}) {
    if (!payload || payload.type !== 'hook') return { ok: false, reason: 'not_a_hook_payload' };
    const event = asNonEmptyString(payload.event);
    const agentId = asNonEmptyString(payload.agent_id);
    const runtime = asNonEmptyString(payload.runtime);
    if (!CANONICAL_EVENTS.has(event)) return { ok: false, reason: 'unknown_event' };
    if (!agentId) return { ok: false, reason: 'missing_agent_id' };
    const sessionId = asNonEmptyString(payload.session_id) ?? 'hook';
    const meta = payload.meta ?? {};
    // Also reject reminders already classified by an older hook adapter.
    // Never merge them with, resolve, or recreate an independently owned wait.
    if (runtime === 'claude' && event === 'permission_required'
      && meta.native_event === 'Notification' && meta.notification_type === 'permission_prompt') {
      return { ok: true, reason: 'uncorrelated_permission_reminder' };
    }
    const scope = JSON.stringify([agentId, sessionId]);
    const pending = pendingInputs.get(scope) ?? new Map();
    // A terminal observer can resolve a native approval whose CLI emits no
    // matching completion hook. Reconcile the transient cache with durability.
    const history = ownerInboxStore?.listReports?.({ include_resolved: true }) ?? [];
    for (const waits of pendingInputs.values()) for (const [key, wait] of waits) {
      if (history.some(report => report.report_id === wait.report_id && report.lifecycle_state === 'resolved')) waits.delete(key);
    }
    const ts = Date.now();
    const broadcast = message => {
      try { server?.broadcast(message); } catch (error) { log.warn?.(`[hook-bridge] broadcast failed: ${error.message}`); }
    };
    const hasPendingInput = () => [...pendingInputs].some(([key, waits]) => JSON.parse(key)[0] === agentId && waits.size > 0)
      || (ownerInboxStore?.listReports?.({}) ?? []).some(report => report.from_agent_id === agentId && report.blocking);

    if (event === 'input_resolved' || event === 'work_started') {
      let matched = 0, result = { resolved: 0, remaining: 0 };
      // Work resumption alone never answers an outstanding input request.
      const completed = event === 'work_started' ? [{}] : Array.isArray(meta.completed_inputs) ? meta.completed_inputs : [meta];
      for (const identity of completed) {
        const requestId = asNonEmptyString(identity.request_id);
        let keys = [...pending].filter(([, wait]) =>
          requestId && wait.request_id === requestId && wait.tool_name === identity.tool_name).map(([key]) => key);
        if (keys.length === 0 && identity.tool_fingerprint) {
          const candidates = [...pending].filter(([, wait]) => !wait.request_id && wait.tool_name === identity.tool_name
            && wait.tool_fingerprint === identity.tool_fingerprint);
          if (candidates.length === 1) keys = [candidates[0][0]];
        }
        const resolved = await reportPipeline?.resolveInputs({ agentId, sessionId, requestId,
          toolName: identity.tool_name, fingerprint: identity.tool_fingerprint }) ?? { resolved: 0, remaining: 0 };
        result = { resolved: result.resolved + resolved.resolved, remaining: resolved.remaining };
        matched += keys.length;
        for (const key of keys) pending.delete(key);
      }
      if (pending.size === 0) pendingInputs.delete(scope);
      ttsController?.revalidateNotifications?.();
      if (event === 'input_resolved' && matched === 0 && result.resolved === 0) return { ok: true, reason: 'no_matching_input' };
      const otherPending = [...pendingInputs].some(([key, waits]) => JSON.parse(key)[0] === agentId && waits.size > 0);
      if (otherPending || result.remaining) return { ok: true, reason: 'input_still_pending' };
      broadcast(buildEventPayload({ agentId, sessionId, event: 'cmd_started', ts, runtime, meta: { ...meta, awaiting_input: false } }));
      return { ok: true, event, agent_id: agentId };
    }

    if (event === 'turn_failed' || event === 'turn_interrupted' || event === 'session_ended') {
      let resumed = {};
      // A failed tool result still proves that this exact input request ended.
      // Generic turn failures/StopFailure do not establish that any wait ended.
      if (event === 'turn_failed' && meta.native_event === 'PostToolUse'
          && asNonEmptyString(meta.tool_name) && (asNonEmptyString(meta.request_id) || meta.tool_fingerprint)) {
        const requestId = asNonEmptyString(meta.request_id);
        let keys = [...pending].filter(([, wait]) => requestId && wait.request_id === requestId
          && wait.tool_name === meta.tool_name).map(([key]) => key);
        if (keys.length === 0 && meta.tool_fingerprint) {
          const candidates = [...pending].filter(([, wait]) => !wait.request_id
            && wait.tool_name === meta.tool_name && wait.tool_fingerprint === meta.tool_fingerprint);
          if (candidates.length === 1) keys = [candidates[0][0]];
        }
        const result = await reportPipeline?.resolveInputs({ agentId, sessionId, requestId,
          toolName: meta.tool_name, fingerprint: meta.tool_fingerprint }) ?? { resolved: 0, remaining: 0 };
        for (const key of keys) pending.delete(key);
        if (pending.size === 0) pendingInputs.delete(scope);
        if ((keys.length || result.resolved) && !hasPendingInput() && !result.remaining) {
          resumed = { awaiting_input: false };
        }
      }
      if (event === 'turn_interrupted' && runtime === 'codex' && asNonEmptyString(meta.turn_id)) {
        const result = await reportPipeline?.resolveInputs({ agentId, sessionId, cancelledTurn: meta.turn_id });
        for (const [key, wait] of pending) if (wait.turn_id === meta.turn_id) pending.delete(key);
        const otherPending = [...pendingInputs].some(([key, waits]) => JSON.parse(key)[0] === agentId && waits.size > 0);
        if (!otherPending && !result?.remaining) resumed = { awaiting_input: false };
      }
      ttsController?.revalidateNotifications?.();
      broadcast(buildEventPayload({ agentId, sessionId, event: event === 'turn_failed' ? 'cmd_failed' : event, ts, runtime, meta: { ...meta, ...resumed } }));
      return { ok: true, event, agent_id: agentId };
    }
    let waitRecord = null;
    if (event === 'permission_required' || event === 'input_required') {
      const requestId = asNonEmptyString(meta.request_id);
      const inputKey = JSON.stringify([requestId ?? meta.tool_fingerprint, meta.tool_name, event]);
      const key = requestId ? inputKey : [...pending].find(([, wait]) =>
        wait.input_key === inputKey && wait.retryable === true)?.[0] ?? randomUUID();
      // Only native identities justify deduplication; missing identities do not
      // justify guessing that two independent approvals are the same request.
      const previous = pending.get(key);
      if (requestId && previous?.posted && previous.tool_name === meta.tool_name) return { ok: true, reason: 'input_already_pending' };
      const durable = requestId && ownerInboxStore?.listReports?.({}).find(report => report.source === 'mh_hook'
        && report.from_agent_id === agentId && report.session_id === sessionId && report.request_id === requestId
        && report.tool_name === meta.tool_name && report.kind === (event === 'permission_required' ? 'blocked' : 'question'));
      waitRecord = previous && previous.tool_name === meta.tool_name ? previous :
        { input_key: inputKey, tool_name: meta.tool_name, request_id: requestId, tool_fingerprint: meta.tool_fingerprint,
          turn_id: meta.turn_id,
          report_id: durable?.report_id ?? `hook-${event}-${randomUUID()}`, posted: false, retryable: false };
      waitRecord.retryable = false;
      pending.set(key, waitRecord);
      pendingInputs.set(scope, pending);
    }
    ttsController?.revalidateNotifications?.();
    const lang = detectLanguage(agentId);
    const choice = event === 'input_required' && meta.input_kind?.startsWith('choice_');
    const idleReminder = event === 'idle_after_response' && meta.native_event === 'Notification';
    const line = pickLine(choice ? 'choice_required' : event, lang, agentId);
    if (!line && !idleReminder) return { ok: false, reason: 'no_template' };
    const subject = waitSpeechSubject(agentId, runtime, lang);
    const text = idleReminder ? waitSpeechLine('unknown', subject, lang)
      : waitRecord ? `${subject}: ${line}` : line;
    if (!text) return { ok: false, reason: 'no_template' };
    const eventPayload = buildEventPayload({ agentId, sessionId, event, ts, runtime, meta });
    const sayPayload = buildSayPayload({ agentId, sessionId, event, ts, text });
    broadcast(eventPayload);
    // A turn boundary cannot speak over an unanswered native/observed wait.
    // Recheck on dequeue too, because a wait may arrive during synthesis.
    if (event === 'idle_after_response' && hasPendingInput()) return { ok: true, reason: 'input_still_pending' };
    const inboxResult = await maybePostInboxReport({ agentId, event, text, runtime, sessionId, meta,
      reportId: waitRecord?.report_id, ownerInboxStore, assignmentStore, reportPipeline });
    if (waitRecord) {
      if (inboxResult?.report?.report_id) waitRecord.report_id = inboxResult.report.report_id;
      waitRecord.posted ||= inboxResult?.transport_state === 'accepted' || inboxResult?.reason === 'no_assignment';
      waitRecord.retryable = !waitRecord.posted;
    }
    // Assigned helpers announce through their owner's inbox only. The direct
    // path remains for an Operator or an unassigned CLI, and on report failure.
    const routedToOwner = waitRecord && reportPipeline && inboxResult?.transport_state === 'accepted';
    if (!routedToOwner) {
      broadcast(sayPayload);
      const isCurrent = waitRecord
        ? () => [...pendingInputs.values()].some(waits => [...waits.values()].includes(waitRecord))
          && !(ownerInboxStore?.listReports?.({ include_resolved: true }) ?? []).some(report =>
            report.report_id === waitRecord.report_id && ['resolved', 'dismissed', 'superseded'].includes(report.lifecycle_state))
        : event === 'idle_after_response' ? () => !hasPendingInput() : null;
      const target = waitRecord && selectAssignment(assignmentStore?.listAssignments?.({ agent_id: agentId }));
      try { await ttsController?.handleSayPayload(sayPayload, {
        notificationKey: waitRecord ? reportSpeechKey({ ...target, source: 'mh_hook', from_agent_id: agentId,
          session_id: sessionId, request_id: waitRecord.request_id, tool_name: waitRecord.tool_name,
          kind: event === 'permission_required' ? 'blocked' : 'question', report_id: waitRecord.report_id })
          ?? JSON.stringify(['native-occurrence', agentId, sessionId, waitRecord.report_id]) : null,
        isCurrent
      }); }
      catch (error) { log.warn?.(`[hook-bridge] tts handleSay failed: ${error.message}`); }
    }
    recordSayHistory(agentId, text);
    return { ok: true, lang, text, event, agent_id: agentId, runtime: runtime ?? 'unknown',
      message_id: sayPayload.message_id, inbox_posted: inboxResult?.transport_state === 'accepted' };
  }

  function observePayload(payload) {
    if (!payload || payload.type !== 'say') {
      return;
    }
    recordSayHistory(payload.agent_id, payload.text);
  }

  return {
    handleHook,
    observePayload,
    _internal: {
      detectLanguage,
      loadTemplates,
      pickLine,
      recordSayHistory,
      sayHistory,
      BUILTIN_TEMPLATES
    }
  };
}

export const __test = { BUILTIN_TEMPLATES, CJK_REGEX, CANONICAL_EVENTS };
