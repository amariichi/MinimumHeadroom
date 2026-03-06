import { normalizeDashboardAgent, sortDashboardAgents } from './agent_dashboard_state.js';

export function applyAgentResultToAgents(agents, rawAgent) {
  const list = Array.isArray(agents) ? [...agents] : [];
  if (!rawAgent || typeof rawAgent !== 'object') {
    return list;
  }
  const normalized = normalizeDashboardAgent(rawAgent, list.length);
  const index = list.findIndex((agent) => agent?.id === normalized.id);
  if (index >= 0) {
    list[index] = {
      ...list[index],
      ...normalized
    };
  } else {
    list.push(normalized);
  }
  return sortDashboardAgents(list);
}
