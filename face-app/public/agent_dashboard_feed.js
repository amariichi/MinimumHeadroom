function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
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

export function resolveAgentIdForPayload(payload, agents = []) {
  const list = Array.isArray(agents) ? agents : [];
  const explicit = asNonEmptyString(payload?.agent_id);
  if (explicit && list.some((agent) => agent?.id === explicit)) {
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
  return byId?.id ?? null;
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
  if (name === 'permission_required') {
    return 'approval required';
  }
  return truncateText(name.replaceAll('_', ' '), maxLength);
}

export function deriveAgentTransientUpdate(payload, options = {}) {
  const maxLength = Number.isFinite(options.maxLength) ? Math.max(12, Math.floor(options.maxLength)) : 84;
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
      speaking: true
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
    return {
      message
    };
  }

  if (payload.type === 'tts_state') {
    if (payload.phase === 'play_start') {
      return { speaking: true };
    }
    if (payload.phase === 'play_stop' || payload.phase === 'dropped' || payload.phase === 'error') {
      return { speaking: false };
    }
  }

  if (payload.type === 'operator_set_pane_result' && payload.ok === true) {
    return {
      message: 'focused in operator'
    };
  }

  return null;
}

