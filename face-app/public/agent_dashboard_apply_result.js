import { normalizeDashboardAgent, sortDashboardAgents } from './agent_dashboard_state.js';

export function normalizeResultStateAgents(rawAgents) {
  if (!Array.isArray(rawAgents)) {
    return [];
  }
  const mapped = rawAgents.map((agent, index) => normalizeDashboardAgent(agent, index));
  return sortDashboardAgents(mapped);
}

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

export function resolveAgentsFromActionResult(agents, result) {
  const current = Array.isArray(agents) ? agents : [];
  if (Array.isArray(result?.state?.agents)) {
    return normalizeResultStateAgents(result.state.agents);
  }
  if (result?.agent && typeof result.agent === 'object') {
    return applyAgentResultToAgents(current, result.agent);
  }
  return current;
}
