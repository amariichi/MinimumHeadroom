export function listAgentLifecycleActions(agent = {}) {
  const status = typeof agent.status === 'string' ? agent.status.toLowerCase() : 'active';
  const hasPane = typeof agent.pane_id === 'string' && agent.pane_id.trim() !== '';
  const actions = [];

  if (hasPane && status !== 'removed') {
    actions.push({ label: 'Focus', action: 'focus' });
  }

  if (status === 'active') {
    actions.push({ label: 'Pause', action: 'pause' });
    actions.push({ label: 'Stop', action: 'stop' });
    actions.push({ label: 'Remove', action: 'remove' });
    return actions;
  }
  if (status === 'paused') {
    actions.push({ label: 'Resume', action: 'resume' });
    actions.push({ label: 'Stop', action: 'stop' });
    actions.push({ label: 'Remove', action: 'remove' });
    return actions;
  }
  if (status === 'parked') {
    actions.push({ label: 'Stop', action: 'stop' });
    actions.push({ label: 'Remove', action: 'remove' });
    return actions;
  }
  if (status === 'stopped') {
    actions.push({ label: 'Remove', action: 'remove' });
    actions.push({ label: 'Delete WT', action: 'delete-worktree' });
    return actions;
  }
  if (status === 'removed') {
    actions.push({ label: 'Restore', action: 'restore' });
    actions.push({ label: 'Delete WT', action: 'delete-worktree' });
    return actions;
  }

  return actions;
}

export function shouldShowMobileAgentList(agents = [], options = {}) {
  const isMobileUi = options.isMobileUi === true;
  const operatorPanelEnabled = options.operatorPanelEnabled !== false;
  if (!isMobileUi || !operatorPanelEnabled) {
    return false;
  }
  const activeCount = Array.isArray(agents) ? agents.filter((agent) => agent?.status !== 'removed').length : 0;
  return activeCount > 1;
}

