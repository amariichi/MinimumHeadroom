function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function collectOperatorIdentityValues(options = {}) {
  const values = new Set();
  const operatorAgentId = asNonEmptyString(options.operatorAgentId);
  const operatorSessionId = asNonEmptyString(options.operatorSessionId);
  const operatorAliases = Array.isArray(options.operatorAliases) ? options.operatorAliases : [];
  if (operatorAgentId) {
    values.add(operatorAgentId);
  }
  if (operatorSessionId) {
    values.add(operatorSessionId);
  }
  for (const alias of operatorAliases) {
    const normalized = asNonEmptyString(alias);
    if (normalized) {
      values.add(normalized);
    }
  }
  return values;
}

export function matchesOperatorIdentity(value, options = {}) {
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    return false;
  }
  return collectOperatorIdentityValues(options).has(normalized);
}

function truncateText(value, maxLength = 84) {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function summarizeSpeechBubbleText(value, maxLength = 60) {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized === '') {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const sentences = normalized.match(/[^。．.!?！？]+[。．.!?！？]?/g) ?? [];
  if (sentences.length > 0) {
    let joined = '';
    for (const sentence of sentences) {
      const next = `${joined}${sentence}`.trim();
      if (next.length > maxLength) {
        if (joined === '' && sentence.trim().length <= maxLength + 12) {
          return sentence.trim();
        }
        break;
      }
      joined = next;
    }
    if (joined !== '') {
      return joined;
    }
  }

  const boundarySlice = normalized.slice(0, maxLength + 1);
  const boundaryMatches = [...boundarySlice.matchAll(/[、，,;；:\s]/g)];
  const lastBoundary = boundaryMatches.length > 0 ? boundaryMatches.at(-1)?.index ?? -1 : -1;
  if (lastBoundary >= Math.floor(maxLength * 0.55)) {
    return `${boundarySlice.slice(0, lastBoundary).trim()}…`;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

export function resolveAgentIdForPayload(payload, agents = [], options = {}) {
  const list = Array.isArray(agents) ? agents : [];
  const explicit = asNonEmptyString(payload?.agent_id);
  if (explicit) {
    if (matchesOperatorIdentity(explicit, options)) {
      return asNonEmptyString(options.operatorAgentId) ?? explicit;
    }
    return explicit;
  }

  const sessionId = asNonEmptyString(payload?.session_id);
  if (!sessionId || sessionId === '-') {
    return null;
  }
  const bySession = list.find((agent) => agent?.session_id === sessionId);
  if (bySession?.id) {
    return bySession.id;
  }
  const byId = list.find((agent) => agent?.id === sessionId);
  if (byId?.id) {
    return byId.id;
  }
  if (matchesOperatorIdentity(sessionId, options)) {
    return asNonEmptyString(options.operatorAgentId) ?? sessionId;
  }
  return null;
}

export function deriveObservedAgentFromPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const agentId = asNonEmptyString(payload?.agent_id);
  if (!agentId) {
    return null;
  }
  if (matchesOperatorIdentity(agentId, options)) {
    return null;
  }
  const sessionId = asNonEmptyString(payload?.session_id);
  const label = asNonEmptyString(payload?.agent_label) ?? agentId;
  const updatedAt = Number.isFinite(payload?.ts) ? Math.floor(payload.ts) : Date.now();
  return {
    id: agentId,
    label,
    status: 'active',
    slot: null,
    pane_id: null,
    session_id: sessionId,
    last_message: 'observed helper activity',
    message_source: 'speech',
    updated_at: updatedAt,
    provisional: true
  };
}

export function resolveAgentIdForPane(paneId, agents = [], options = {}) {
  const normalizedPaneId = asNonEmptyString(paneId);
  if (!normalizedPaneId) {
    return options.operatorAgentId ?? null;
  }
  const list = Array.isArray(agents) ? agents : [];
  const byPane = list.find((agent) => asNonEmptyString(agent?.pane_id) === normalizedPaneId);
  return byPane?.id ?? (options.operatorAgentId ?? null);
}

export function shouldCountPayloadAsAgentActivity(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  switch (payload.type) {
    case 'say':
    case 'event':
    case 'operator_prompt':
    case 'tts_state':
    case 'tts_mouth':
      return true;
    default:
      return false;
  }
}

export function summarizeAgentEventMessage(payload, options = {}) {
  const maxLength = Number.isFinite(options.maxLength) ? Math.max(12, Math.floor(options.maxLength)) : 84;
  const name = asNonEmptyString(payload?.name);
  if (!name) {
    return null;
  }
  if (name === 'cmd_started') {
    const action = truncateText(asNonEmptyString(payload?.meta?.action) ?? asNonEmptyString(payload?.meta?.task) ?? '', maxLength);
    return action ? `running: ${action}` : 'running command';
  }
  if (name === 'cmd_succeeded' || name === 'tests_passed') {
    return 'completed successfully';
  }
  if (name === 'cmd_failed' || name === 'tests_failed') {
    return 'task failed';
  }
  if (name === 'retrying') {
    return 'retrying task';
  }
  if (name === 'idle') {
    return 'idle';
  }
  if (name === 'prompt_idle') {
    return 'ready for next prompt';
  }
  if (name === 'permission_required') {
    return 'approval required';
  }
  if (name === 'needs_attention') {
    const detail = truncateText(
      asNonEmptyString(payload?.meta?.detail) ?? asNonEmptyString(payload?.meta?.action) ?? '',
      Math.max(12, maxLength - 11)
    );
    return detail ? `attention: ${detail}` : 'attention needed';
  }
  return truncateText(name.replaceAll('_', ' '), maxLength);
}

export function deriveAgentTransientUpdate(payload, options = {}) {
  const maxLength = Number.isFinite(options.maxLength) ? Math.max(12, Math.floor(options.maxLength)) : 84;
  const longAttentionTtlMs = 5 * 60 * 1000;
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (payload.type === 'say') {
    const text = truncateText(asNonEmptyString(payload.text) ?? '', maxLength);
    if (text === '') {
      return null;
    }
    return {
      message: text,
      speaking: true,
      needsAttention: false,
      promptIdle: false,
      speechBubble: summarizeSpeechBubbleText(payload.text, Math.min(maxLength, 60)),
      speechBubbleTtlMs: Number.isFinite(payload.ttl_ms)
        ? Math.max(1_200, Math.min(8_000, Math.floor(payload.ttl_ms)))
        : 5_000
    };
  }

  if (payload.type === 'say_result' && payload.spoken === false) {
    const reason = asNonEmptyString(payload.reason) ?? 'not spoken';
    return {
      message: truncateText(`speech skipped: ${reason}`, maxLength),
      speaking: false
    };
  }

  if (payload.type === 'event') {
    const message = summarizeAgentEventMessage(payload, { maxLength });
    if (!message) {
      return null;
    }
    if (payload.name === 'permission_required') {
      return {
        message,
        needsAttention: true,
        needsAttentionTtlMs: longAttentionTtlMs,
        promptIdle: false
      };
    }
    if (payload.name === 'needs_attention') {
      const ttlMs = Number.isFinite(payload?.ttl_ms) ? Math.max(10_000, Math.floor(payload.ttl_ms)) : longAttentionTtlMs;
      return {
        message,
        needsAttention: true,
        needsAttentionTtlMs: ttlMs,
        promptIdle: false
      };
    }
    if (payload.name === 'cmd_failed' || payload.name === 'tests_failed') {
      return {
        message,
        needsAttention: false,
        error: true,
        promptIdle: false
      };
    }
    if (payload.name === 'prompt_idle') {
      return {
        message,
        needsAttention: false,
        promptIdle: true,
        speaking: false
      };
    }
    if (
      payload.name === 'cmd_started' ||
      payload.name === 'retrying' ||
      payload.name === 'cmd_succeeded' ||
      payload.name === 'tests_passed'
    ) {
      return {
        message,
        needsAttention: false,
        promptIdle: false
      };
    }
    return {
      message
    };
  }

  if (payload.type === 'operator_prompt') {
    return {
      message: truncateText(payload.state === 'awaiting_approval' ? 'approval required' : 'attention needed', maxLength),
      needsAttention: true,
      needsAttentionTtlMs: longAttentionTtlMs,
      promptIdle: false
    };
  }

  if (payload.type === 'tts_state') {
    if (payload.phase === 'play_start') {
      return {
        speaking: true,
        needsAttention: false,
        promptIdle: false
      };
    }
    if (payload.phase === 'play_stop' || payload.phase === 'dropped' || payload.phase === 'error') {
      return {
        speaking: false,
        promptIdle: false,
        ...(payload.phase === 'error' ? { error: true } : {})
      };
    }
  }

  if (payload.type === 'operator_set_pane_result' && payload.ok === true) {
    return {
      message: 'focused in operator'
    };
  }

  return null;
}

export function filterAgentTransientUpdateForFallback(update, options = {}) {
  if (!update || typeof update !== 'object') {
    return null;
  }
  if (options.fallbackToOperator !== true) {
    return update;
  }
  const speechBubble = asNonEmptyString(update.speechBubble);
  if (!speechBubble) {
    return null;
  }
  const next = { speechBubble };
  if (Number.isFinite(update.speechBubbleTtlMs)) {
    next.speechBubbleTtlMs = Math.max(1_200, Math.min(8_000, Math.floor(update.speechBubbleTtlMs)));
  }
  return next;
}
