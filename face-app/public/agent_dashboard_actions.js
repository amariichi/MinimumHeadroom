export function listAgentLifecycleActions(agent = {}) {
  const status = typeof agent.status === 'string' ? agent.status.toLowerCase() : 'active';
  if (status === 'active' || status === 'missing') {
    return [{ label: 'Delete', action: 'delete' }];
  }
  return [];
}

export function shouldShowMobileAgentList(agents = [], options = {}) {
  const isMobileUi = options.isMobileUi === true;
  const operatorPanelEnabled = options.operatorPanelEnabled !== false;
  const pickerOpen = options.pickerOpen === true;
  if (!isMobileUi || !operatorPanelEnabled || !pickerOpen) {
    return false;
  }
  return Array.isArray(agents);
}
