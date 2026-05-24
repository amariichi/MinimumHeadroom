import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BUILTIN_TEMPLATES = {
  permission_required: {
    ja: ['承認をお願いします。', '確認お願いします。', 'もう一度承認お願いします。'],
    en: ['Approval needed.', 'One more approval, please.', 'Approval needed to continue.']
  },
  idle_after_response: {
    ja: ['作業が止まっているかもしれません。', '応答待ちかもしれません。'],
    en: ['I may be stuck waiting.', 'Turn ended; awaiting next step.']
  }
};

const HISTORY_LIMIT = 8;
const CJK_REGEX = /[ぁ-ゟァ-ヿ一-鿿]/;
const CANONICAL_EVENTS = new Set(['permission_required', 'idle_after_response']);
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
      name: event,
      severity,
      meta: { source: 'mh_hook', runtime: runtime ?? 'unknown', hook_event: event, ...(meta ?? {}) },
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
    const active = assignments.find(
      (a) => a && a.delivery_state !== 'failed' && a.delivery_state !== 'timeout'
    );
    return active ?? assignments[0];
  }

  async function maybePostInboxReport({ agentId, event, text, runtime, ownerInboxStore, assignmentStore }) {
    if (!ownerInboxStore || typeof ownerInboxStore.submitReport !== 'function') {
      return null;
    }
    if (!assignmentStore || typeof assignmentStore.listAssignments !== 'function') {
      return null;
    }
    let assignments;
    try {
      assignments = assignmentStore.listAssignments({ agent_id: agentId });
    } catch (error) {
      log.warn?.(`[hook-bridge] listAssignments failed for ${agentId}: ${error.message}`);
      return null;
    }
    const target = selectAssignment(assignments);
    if (!target || !target.owner_agent_id || !target.stream_id || !target.mission_id) {
      return null;
    }
    const kind = event === 'permission_required' ? 'progress' : 'done';
    try {
      const result = ownerInboxStore.submitReport({
        stream_id: target.stream_id,
        mission_id: target.mission_id,
        owner_agent_id: target.owner_agent_id,
        from_agent_id: agentId,
        kind,
        summary: text,
        detail: `source=mh_hook runtime=${runtime ?? 'unknown'} hook_event=${event}`,
        report_id: `hook-${event}-${randomUUID()}`
      });
      return result;
    } catch (error) {
      log.warn?.(`[hook-bridge] submitReport failed for ${agentId}: ${error.message}`);
      return null;
    }
  }

  async function handleHook({ payload, server, ttsController, ownerInboxStore, assignmentStore } = {}) {
    if (!payload || payload.type !== 'hook') {
      return { ok: false, reason: 'not_a_hook_payload' };
    }
    const event = asNonEmptyString(payload.event);
    const agentId = asNonEmptyString(payload.agent_id);
    const runtime = asNonEmptyString(payload.runtime);
    if (!event || !CANONICAL_EVENTS.has(event)) {
      return { ok: false, reason: 'unknown_event' };
    }
    if (!agentId) {
      return { ok: false, reason: 'missing_agent_id' };
    }

    const lang = detectLanguage(agentId);
    const text = pickLine(event, lang, agentId);
    if (!text) {
      return { ok: false, reason: 'no_template' };
    }

    const sessionId = asNonEmptyString(payload.session_id) ?? 'hook';
    const ts = Date.now();
    const eventPayload = buildEventPayload({ agentId, sessionId, event, ts, runtime, meta: payload.meta });
    const sayPayload = buildSayPayload({ agentId, sessionId, event, ts, text });

    if (server && typeof server.broadcast === 'function') {
      try { server.broadcast(eventPayload); } catch (error) { log.warn?.(`[hook-bridge] broadcast event failed: ${error.message}`); }
      try { server.broadcast(sayPayload); } catch (error) { log.warn?.(`[hook-bridge] broadcast say failed: ${error.message}`); }
    }

    if (ttsController && typeof ttsController.handleSayPayload === 'function') {
      try {
        await ttsController.handleSayPayload(sayPayload);
      } catch (error) {
        log.warn?.(`[hook-bridge] tts handleSay failed: ${error.message}`);
      }
    }

    recordSayHistory(agentId, text);

    const inboxResult = await maybePostInboxReport({ agentId, event, text, runtime, ownerInboxStore, assignmentStore });

    return {
      ok: true,
      lang,
      text,
      event,
      agent_id: agentId,
      runtime: runtime ?? 'unknown',
      message_id: sayPayload.message_id,
      inbox_posted: Boolean(inboxResult && inboxResult.transport_state === 'accepted')
    };
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
