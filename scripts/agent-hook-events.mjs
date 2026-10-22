// Canonical names below are Minimum Headroom events, not invented CLI hooks.
// Compatibility evidence and limits: doc/hook-bridge/README.md.
import { createHash } from 'node:crypto';
export const CANONICAL_HOOK_EVENTS = new Set([
  'permission_required', 'input_required', 'input_resolved', 'work_started',
  'idle_after_response', 'turn_failed', 'turn_interrupted', 'session_ended'
]);
const NATIVE_EVENTS = new Set(['PermissionRequest', 'Notification', 'PreToolUse', 'PostToolUse', 'PostToolBatch',
  'UserPromptSubmit', 'PreInvocation', 'Stop', 'StopFailure', 'Interrupt', 'SessionEnd']);
const string = value => typeof value === 'string' && value.trim() ? value.trim() : null;
function object(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function commandFingerprint(command) {
  return string(command) ? createHash('sha256').update(command.trim()).digest('hex') : null;
}

export function toolInputFingerprint(tool, input) {
  return string(tool) && input && typeof input === 'object' && !Array.isArray(input)
    ? createHash('sha256').update(JSON.stringify([tool, stable(input)])).digest('hex') : null;
}

export function approvalActionMatches(native, observed) {
  // Claude's MCP table exposes the complete flat input, rather than a shell
  // command. Match its exact canonical tool AND all input fields. Names or time
  // proximity alone cannot identify a request, especially concurrent calls.
  if (native.runtime === 'claude' && observed.action_format === 'claude_mcp_table'
      && native.tool_name === observed.tool_name && native.tool_fingerprint
      && native.tool_fingerprint === observed.tool_fingerprint) return true;
  if (!native.action_fingerprint) return false;
  if (native.action_fingerprint === observed.action_fingerprint) return true;
  // Only a proven single-line native command can consume display-wrap variants.
  // Never flatten shell newlines or normalize whitespace inside quoted arguments.
  return (native.runtime === 'codex' || (native.runtime === 'claude' && observed.action_format === 'claude_bash_box'))
    && native.action_format === 'single_line'
    && Array.isArray(observed.action_wrap_fingerprints)
    && observed.action_wrap_fingerprints.includes(native.action_fingerprint);
}

export function classifyAgentHook({ payload, explicitEvent, runtime } = {}) {
  const input = object(payload);
  const native = string(input.hook_event_name) ?? (NATIVE_EVENTS.has(explicitEvent) ? explicitEvent : null);
  const tool = string(input.tool_name) ?? string(input.toolCall?.name);
  const agy = runtime === 'antigravity';
  const requestId = agy
    ? (Number.isInteger(input.stepIdx) && input.stepIdx >= 0 ? `step:${input.stepIdx}` : null)
    : string(input.tool_use_id);
  let rawArgs = agy ? input.toolCall?.args : input.tool_input;
  if (typeof rawArgs === 'string') { try { rawArgs = JSON.parse(rawArgs); } catch { rawArgs = null; } }
  const args = object(rawArgs);
  const hasArgs = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs);
  // PermissionRequest need not expose tool_use_id. When both hooks expose the
  // same tool input, retain a derived fingerprint, never the raw arguments.
  // Codex adds a human-facing description only to Bash PermissionRequest.
  // It is not an execution parameter; retain every other argument in identity.
  const fingerprintArgs = tool === 'Bash' && typeof args.command === 'string'
    ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'description')) : args;
  const fingerprint = tool && hasArgs ? toolInputFingerprint(tool, fingerprintArgs) : null;
  const actionFingerprint = commandFingerprint(args.command ?? args.cmd ?? args.CommandLine);
  const questions = Array.isArray(args.questions) ? args.questions : [];
  const inputKind = questions.some(q => q?.multiSelect === true || q?.is_multi_select === true)
    ? 'choice_multi' : questions.some(q => Array.isArray(q?.options) && q.options.length) ? 'choice_single' : 'text';
  const meta = {
    ...(native ? { native_event: native } : {}),
    ...(string(input.turn_id) ? { turn_id: string(input.turn_id) } : {}),
    ...(tool ? { tool_name: tool } : {}),
    ...(fingerprint ? { tool_fingerprint: fingerprint } : {}),
    ...(actionFingerprint ? { action_fingerprint: actionFingerprint,
      action_format: /[\r\n]/.test(args.command ?? args.cmd ?? args.CommandLine) ? 'multiline' : 'single_line' } : {}),
    ...(requestId ? { request_id: requestId } : {})
  };
  const found = (event, extra = {}, source = 'hook_event_name') => ({ event, source, meta: { ...meta, ...extra } });
  const ignored = reason => ({ event: null, source: native ? 'hook_event_name' : 'none', reason });

  // Notification is a family of unrelated events. Even an old template's
  // --event permission_required must not turn idle/auth notifications into approval.
  if (native === 'Notification') {
    if (runtime && runtime !== 'claude') return ignored('unsupported_notification_runtime');
    const subtype = string(input.notification_type);
    // Claude emits this delayed reminder for both tool approvals and
    // AskUserQuestion. It has no request identity or matching resolution event,
    // and may arrive after an answer. Only the primary structured hooks (or a
    // concrete terminal observation) can own a permission/question lifecycle.
    if (subtype === 'permission_prompt') return ignored('uncorrelated_permission_reminder');
    if (subtype === 'elicitation_dialog' || subtype === 'elicitation_url_dialog') {
      return found('input_required', { notification_type: subtype, input_kind: 'text' });
    }
    if (subtype === 'idle_prompt') return found('idle_after_response', { notification_type: subtype });
    // Completion/resumption of a background agent or an elicitation without a
    // matching tool ID is not proof about the foreground task or pending question.
    return ignored(subtype ? `unhandled_notification_${subtype}` : 'missing_notification_type');
  }
  // AskUserQuestion's permission transport carries the answer dialog itself,
  // not an additional tool approval. PreToolUse owns the one question entry.
  if (native === 'PermissionRequest' && runtime === 'claude' && tool === 'AskUserQuestion') {
    return ignored('question_answer_transport');
  }
  if (native === 'PostToolBatch' && runtime === 'claude') {
    const completed = (Array.isArray(input.tool_calls) ? input.tool_calls : []).map(call =>
      classifyAgentHook({ runtime, payload: { ...call, hook_event_name: 'PostToolUse' } }))
      .filter(result => result.event === 'input_resolved').map(result => result.meta);
    // Includes tools denied before execution. Responses and raw inputs never
    // leave the adapter; only exact identities and derived hashes are sent.
    return completed.length ? found('input_resolved', { completed_inputs: completed }) : ignored('missing_tool_identity');
  }
  if (CANONICAL_HOOK_EVENTS.has(explicitEvent)) return found(explicitEvent, {}, 'argv');
  if (explicitEvent && !NATIVE_EVENTS.has(explicitEvent)) return ignored('unknown_event');
  if (native === 'PermissionRequest' && !agy) return found('permission_required');
  if (native === 'PreToolUse') {
    if ((runtime === 'codex' && tool === 'request_user_input')
      || ((!runtime || runtime === 'claude') && tool === 'AskUserQuestion')
      || (agy && tool === 'ask_question')) return found('input_required', { input_kind: inputKind });
    if ((runtime === 'claude' && tool === 'ExitPlanMode') || (agy && tool === 'ask_permission')) {
      return found('permission_required', { input_kind: 'key' });
    }
    return ignored('unhandled_tool');
  }
  if (native === 'PostToolUse') {
    if (input.error) return found('turn_failed');
    return (requestId || fingerprint) && tool ? found('input_resolved') : ignored('missing_tool_identity');
  }
  if (native === 'UserPromptSubmit' && !agy) return found('work_started', { user_submitted: true });
  if (native === 'PreInvocation' && agy) return found('work_started');
  if (native === 'StopFailure' && runtime === 'claude') return found('turn_failed');
  if (native === 'Interrupt' && runtime === 'codex') return found('turn_interrupted');
  if (native === 'SessionEnd' && runtime === 'codex') return found('session_ended');
  if (native === 'Stop') {
    return found(agy && ['error', 'max_steps_exceeded'].includes(input.terminationReason) ? 'turn_failed' : 'idle_after_response', {
      ...(typeof input.fullyIdle === 'boolean' ? { fully_idle: input.fullyIdle } : {}),
      ...(string(input.terminationReason) ? { termination_reason: input.terminationReason } : {}),
      ...(Array.isArray(input.background_tasks) ? { background_tasks_count: input.background_tasks.length } : {}),
      ...(Array.isArray(input.session_crons) ? { session_crons_count: input.session_crons.length } : {})
    });
  }
  const legacy = string(input.event) ?? string(input.type) ?? string(input.trigger) ?? string(input.name);
  if (!native && legacy === 'agent-turn-complete') return found('idle_after_response', {}, 'legacy_notify');
  return ignored(native ? `unhandled_${native}` : 'no_known_field');
}
