function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function truncateText(value, maxLength = 96) {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeActionName(action) {
  const normalized = asNonEmptyString(action)?.replaceAll('_', '-');
  return normalized ?? 'action';
}

function extractErrorDetail(error) {
  const explicit = asNonEmptyString(error?.detail);
  if (explicit) {
    return explicit;
  }
  const message = asNonEmptyString(error?.message);
  if (!message) {
    return null;
  }
  const detailMatch = message.match(/\)\s*:\s*(.+)$/);
  if (detailMatch && asNonEmptyString(detailMatch[1])) {
    return detailMatch[1].trim();
  }
  return message;
}

export function summarizeAgentActionSuccess(agentId, action, payload, options = {}) {
  const statusMax = Number.isFinite(options.statusMaxLength) ? Math.max(24, Math.floor(options.statusMaxLength)) : 128;
  const tileMax = Number.isFinite(options.tileMaxLength) ? Math.max(20, Math.floor(options.tileMaxLength)) : 96;
  const id = asNonEmptyString(agentId) ?? '-';
  const actionName = normalizeActionName(action);
  const result = payload && typeof payload.result === 'object' ? payload.result : {};
  const noop = result?.noop === true;

  if (actionName === 'focus') {
    return {
      statusTone: 'ok',
      statusText: truncateText(`${id}: focus ok`, statusMax),
      tileMessage: 'focused in operator'
    };
  }

  if (
    actionName === 'stop' &&
    result?.orchestration?.pane_killed === false &&
    asNonEmptyString(result?.agent?.pane_id)
  ) {
    return {
      statusTone: 'warn',
      statusText: truncateText(`${id}: stop partial (pane alive)`, statusMax),
      tileMessage: truncateText('stopped; pane is still attached', tileMax)
    };
  }

  if (actionName === 'restore' && result?.restore?.pane_available === false) {
    return {
      statusTone: 'warn',
      statusText: truncateText(`${id}: restore partial (pane unavailable)`, statusMax),
      tileMessage: 'restored; pane unavailable'
    };
  }

  if (actionName === 'delete-worktree' && noop) {
    return {
      statusTone: 'ok',
      statusText: truncateText(`${id}: delete-worktree noop`, statusMax),
      tileMessage: 'worktree already absent'
    };
  }

  if (noop) {
    return {
      statusTone: 'ok',
      statusText: truncateText(`${id}: ${actionName} noop`, statusMax),
      tileMessage: truncateText(`${actionName} noop`, tileMax)
    };
  }

  const persisted = asNonEmptyString(result?.agent?.last_message);
  return {
    statusTone: 'ok',
    statusText: truncateText(`${id}: ${actionName} ok`, statusMax),
    tileMessage: persisted ? truncateText(persisted, tileMax) : truncateText(`${actionName} ok`, tileMax)
  };
}

export function summarizeAgentActionFailure(agentId, action, error, options = {}) {
  const statusMax = Number.isFinite(options.statusMaxLength) ? Math.max(24, Math.floor(options.statusMaxLength)) : 128;
  const tileMax = Number.isFinite(options.tileMaxLength) ? Math.max(20, Math.floor(options.tileMaxLength)) : 96;
  const id = asNonEmptyString(agentId) ?? '-';
  const actionName = normalizeActionName(action);
  const detail = extractErrorDetail(error);
  const statusSuffix = detail ? `: ${detail}` : '';
  const tileText = detail ? `${actionName} failed: ${detail}` : `${actionName} failed`;
  return {
    statusTone: 'warn',
    statusText: truncateText(`${id}: ${actionName} failed${statusSuffix}`, statusMax),
    tileMessage: truncateText(tileText, tileMax)
  };
}
