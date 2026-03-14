import path from 'node:path';
import { randomUUID } from 'node:crypto';

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function createApiError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function parseInteger(value, fallback, minValue = Number.MIN_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed) || parsed < minValue) {
    return fallback;
  }
  return parsed;
}

function readJsonBody(request, maxBodyBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(createApiError('invalid_request', 'request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(createApiError('invalid_json', 'request json body must be an object'));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(createApiError('invalid_json', `invalid json body: ${error.message}`));
      }
    });

    request.on('error', (error) => {
      reject(createApiError('invalid_request', error.message, error));
    });
  });
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function statusCodeFromError(error) {
  switch (error?.code) {
    case 'invalid_request':
    case 'invalid_json':
      return 400;
    case 'assignment_not_found':
    case 'agent_not_found':
      return 404;
    case 'invalid_state':
      return 409;
    default:
      return 500;
  }
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no') {
      return false;
    }
  }
  return fallback;
}

function formatTargetPaths(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

function normalizeRole(value) {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'review' || normalized === 'reviewer') {
    return 'reviewer';
  }
  if (normalized === 'investigation' || normalized === 'investigator' || normalized === 'research') {
    return 'investigator';
  }
  if (normalized === 'implementation' || normalized === 'implementer' || normalized === 'builder') {
    return 'implementer';
  }
  if (normalized === 'docs' || normalized === 'docs-check' || normalized === 'docs_check' || normalized === 'documentation') {
    return 'docs-check';
  }
  return normalized;
}

function normalizeFollowupMode(value) {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized || normalized === 'assignment') {
    return 'assignment';
  }
  if (normalized === 'completion_rescue') {
    return 'completion_rescue';
  }
  if (normalized === 'blocker_summary') {
    return 'blocker_summary';
  }
  return 'assignment';
}

function deriveStreamRoot(streamId) {
  const normalized = asNonEmptyString(streamId);
  if (!normalized || !normalized.startsWith('repo:')) {
    return null;
  }
  const candidate = normalized.slice('repo:'.length).trim();
  if (candidate === '' || candidate === 'default') {
    return null;
  }
  return path.resolve(candidate);
}

function describeTargetPaths(targetPaths, streamRoot) {
  if (targetPaths.length === 0) {
    return '(none provided)';
  }
  if (!streamRoot) {
    return targetPaths.join(', ');
  }
  const absolutePaths = targetPaths.map((targetPath) => (
    path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.resolve(streamRoot, targetPath)
  ));
  return absolutePaths.join(', ');
}

function buildRoleShapingLines(role) {
  switch (role) {
    case 'reviewer':
      return [
        '- Reviewer role: stay read-only unless the owner explicitly asks for edits.',
        '- Prioritize one concrete correctness, regression, or documentation mismatch finding over a broad sweep.',
        '- If nothing qualifies within the scoped pass, return done with a concise no-findings summary.'
      ];
    case 'investigator':
      return [
        '- Investigator role: answer the bounded question with the minimum files and commands needed.',
        '- Prefer one concrete repro, root cause, or disproof quickly instead of broad repo exploration.',
        '- If the investigation branch is ambiguous, return question with the smallest missing fact.'
      ];
    case 'implementer':
      return [
        '- Implementer role: stay within the requested subsystem or target paths and prefer the smallest viable patch.',
        '- If the requested split would cause same-file conflicts or ownership ambiguity, return question before editing broadly.',
        '- Once the requested implementation change is ready, report done promptly instead of expanding scope.'
      ];
    case 'docs-check':
      return [
        '- Docs-check role: verify consistency across README, guides, examples, and exported diagram assets inside the stated scope.',
        '- Prefer the first concrete mismatch or stale statement with an exact path over broad commentary.',
        '- If the scoped docs are already aligned, return done with a concise no-findings summary.'
      ];
    default:
      return [];
  }
}

function buildFollowupPrompt(assignment, streamRoot, targetPathDescription, mode) {
  const role = normalizeRole(assignment.role);
  const lines = [
    `Owner follow-up for helper agent ${assignment.agent_id}.`,
    `Original goal: ${assignment.goal}`
  ];
  if (role) {
    lines.push(`Role: ${role}`);
  }
  if (streamRoot) {
    lines.push(`Stream root: ${streamRoot}`);
  }
  if (targetPathDescription && targetPathDescription !== '(none provided)') {
    lines.push(`Target paths (stream-root anchored): ${targetPathDescription}`);
  }
  if (assignment.completion_criteria) {
    lines.push(`Completion criteria: ${assignment.completion_criteria}`);
  }
  if (Number.isInteger(assignment.max_findings) && assignment.max_findings > 0) {
    lines.push(`Max findings this pass: ${assignment.max_findings}`);
  }
  if (Number.isInteger(assignment.timebox_minutes) && assignment.timebox_minutes > 0) {
    lines.push(`Timebox minutes: ${assignment.timebox_minutes}`);
  }
  lines.push('Follow-up protocol:');
  if (mode === 'blocker_summary') {
    lines.push('- Do not start another broad exploration pass.');
    lines.push('- Immediately send blocked or question with the single blocker or ambiguity that prevents completion right now.');
    lines.push('- Summarize the single blocking fact, missing input, or ambiguity that prevents completion right now.');
    lines.push('- If you are no longer blocked and already have a bounded answer, send done or review_findings now instead.');
  } else {
    lines.push('- Do not restart broad exploration or optional skill lookup.');
    lines.push('- Using the current scoped work, send done or review_findings now.');
    lines.push('- If this is a narrow review or docs pass, return the first qualifying finding now rather than hunting for more.');
    lines.push('- If no qualifying finding exists within the scoped pass, send done now with a concise no-findings summary.');
    lines.push('- If you are truly blocked, send blocked or question now with the shortest blocker summary that lets the owner unblock you.');
  }
  lines.push('- After the final report, stop and wait for the owner.');
  return lines.join('\n');
}

export function renderAssignmentPrompt(assignment, options = {}) {
  if (!assignment || typeof assignment !== 'object') {
    throw new Error('assignment is required');
  }
  const followupMode = normalizeFollowupMode(options.followup_mode);
  const streamRoot = deriveStreamRoot(assignment.stream_id);
  const targetPaths = formatTargetPaths(assignment.target_paths);
  const targetPathDescription = describeTargetPaths(targetPaths, streamRoot);
  const role = normalizeRole(assignment.role);
  if (followupMode !== 'assignment') {
    return buildFollowupPrompt(assignment, streamRoot, targetPathDescription, followupMode);
  }
  const protocolLines = [
    `1. Before reading repo files, skills, or running broad exploration, call the agent.report MCP tool (shown in some clients as minimum_headroom.agent_report) with stream_id=${assignment.stream_id}, mission_id=${assignment.mission_id}, owner_agent_id=${assignment.owner_agent_id}, from_agent_id=${assignment.agent_id}, kind=progress, summary='Mission accepted'.`,
    '2. Wait until that first report call succeeds.',
    '3. If blocked or uncertain, send blocked or question to the owner instead of asking the user directly.',
    '4. Inspect the target paths before optional skill lookup, slash commands, or unrelated repo exploration unless blocked without them.',
    '5. Send done or review_findings as soon as the current completion criteria are satisfied.',
    '6. If this is a narrow review or investigation pass, return the first qualifying finding immediately instead of hunting for more.',
    '7. If no qualifying finding appears within the stated scope or timebox, send done with a short no-findings summary instead of lingering.',
    '8. After your final done/review_findings report, stop and wait for the owner.'
  ];
  const shapingLines = [
    `- Stream root: ${streamRoot ?? '(not available)'}.`,
    `- Target paths are stream-root anchored: ${targetPathDescription}.`,
    '- Read the exact target path under the stream root even if it sits outside your helper worktree.',
    `- Timebox: ${assignment.timebox_minutes ?? '(not specified)'} minute(s).`,
    `- Completion criteria: ${assignment.completion_criteria ?? '(not specified)'}.`,
    `- Max findings this pass: ${assignment.max_findings ?? '(not specified)'}.`,
    '- If max_findings is 1 or the completion criteria say "one finding or done", stop after the first qualifying result and report it immediately.',
    '- If the scope is still ambiguous after the first report, send question instead of broad repo exploration.'
  ];
  const roleShapingLines = buildRoleShapingLines(role);
  const explicitPrompt = asNonEmptyString(assignment.prompt_text);
  if (explicitPrompt) {
    const lines = [
      `Owner assignment for helper agent ${assignment.agent_id}.`,
      'Immediate protocol:',
      ...protocolLines,
      'Execution shaping:',
      ...shapingLines,
      ...roleShapingLines,
      'Mission body:',
      explicitPrompt
    ];
    return lines.join('\n');
  }
  const lines = [
    `Owner assignment for helper agent ${assignment.agent_id}.`,
    'Immediate protocol:',
    ...protocolLines
  ];
  if (streamRoot) {
    lines.push(`Stream root: ${streamRoot}`);
  }
  if (role) {
    lines.push(`Role: ${role}`);
  }
  lines.push(`Goal: ${assignment.goal}`);
  if (assignment.constraints) {
    lines.push(`Constraints: ${assignment.constraints}`);
  }
  if (targetPaths.length > 0) {
    lines.push(`Target paths (stream-root anchored): ${targetPathDescription}`);
  }
  if (assignment.expected_output) {
    lines.push(`Expected output: ${assignment.expected_output}`);
  }
  if (assignment.completion_criteria) {
    lines.push(`Completion criteria: ${assignment.completion_criteria}`);
  }
  if (assignment.review_policy) {
    lines.push(`Review policy: ${assignment.review_policy}`);
  }
  if (Number.isInteger(assignment.timebox_minutes) && assignment.timebox_minutes > 0) {
    lines.push(`Timebox minutes: ${assignment.timebox_minutes}`);
  }
  if (Number.isInteger(assignment.max_findings) && assignment.max_findings > 0) {
    lines.push(`Max findings this pass: ${assignment.max_findings}`);
  }
  if (assignment.detail) {
    lines.push(`Additional detail: ${assignment.detail}`);
  }
  lines.push('Scoping rules:');
  lines.push('- Start with the minimum files or commands needed to answer the goal.');
  lines.push('- If target paths are given, do not roam outside them without explaining why in your next report.');
  lines.push('- Prefer returning one concrete result quickly unless the owner explicitly asked for a broader sweep.');
  lines.push('- If max_findings is 1 or the completion criteria say "one finding or done", stop after the first qualifying result and report it immediately.');
  lines.push('- If no qualifying finding appears within the scoped pass, send done with a concise no-findings summary instead of waiting silently.');
  lines.push('- After your final done/review_findings report, stop and wait for the owner instead of continuing exploration on your own.');
  lines.push('- If the mission is ambiguous after the first report, send question instead of exploring broadly.');
  lines.push(...roleShapingLines);
  lines.push('Begin now.');
  return lines.join('\n');
}

export function createAgentAssignmentApi(options = {}) {
  const store = options.store;
  const lifecycleRuntime = options.lifecycleRuntime;
  if (!store || typeof store.getAssignmentsView !== 'function') {
    throw new Error('store is required');
  }
  if (!lifecycleRuntime || typeof lifecycleRuntime.injectAgent !== 'function') {
    throw new Error('lifecycleRuntime is required');
  }
  const maxBodyBytes = parseInteger(options.maxBodyBytes, 128 * 1024, 1024);

  return {
    async handleHttpRequest(request, response) {
      const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;
      if (!pathname.startsWith('/api/agent-assignments')) {
        return false;
      }

      try {
        if (pathname === '/api/agent-assignments/list') {
          if (request.method !== 'GET') {
            writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
            return true;
          }
          const view = store.getAssignmentsView({
            stream_id: parsedUrl.searchParams.get('stream_id'),
            owner_agent_id: parsedUrl.searchParams.get('owner_agent_id'),
            agent_id: parsedUrl.searchParams.get('agent_id'),
            mission_id: parsedUrl.searchParams.get('mission_id')
          });
          writeJson(response, 200, {
            ok: true,
            state: view
          });
          return true;
        }

        if (pathname === '/api/agent-assignments/assign') {
          if (request.method !== 'POST') {
            writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
            return true;
          }
          const body = await readJsonBody(request, maxBodyBytes);
          const result = store.upsertAssignment(body);
          writeJson(response, 200, {
            ok: true,
            result
          });
          return true;
        }

        if (pathname === '/api/agent-assignments/inject') {
          if (request.method !== 'POST') {
            writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
            return true;
          }
          const body = await readJsonBody(request, maxBodyBytes);
          const missionId = asNonEmptyString(body.mission_id);
          const streamId = asNonEmptyString(body.stream_id);
          const agentId = asNonEmptyString(body.agent_id);
          if (!missionId || !agentId) {
            throw createApiError('invalid_request', 'mission_id and agent_id are required');
          }

          const assignment = store.getAssignmentOrThrow({
            stream_id: streamId ?? lifecycleRuntime.activeStreamId,
            mission_id: missionId,
            agent_id: agentId
          });
          const followupMode = normalizeFollowupMode(body.followup_mode);
          const text = renderAssignmentPrompt(assignment, {
            followup_mode: followupMode
          });
          const ackTimeoutMs = parseInteger(body.ack_timeout_ms, 20_000, 1000);
          const submit = normalizeBoolean(body.submit, true);
          const reinforceSubmit = normalizeBoolean(body.reinforce_submit, false);
          const probeBeforeSend = normalizeBoolean(body.probe_before_send, false);
          const rescueSubmitIfBuffered = normalizeBoolean(body.rescue_submit_if_buffered, false);
          const deliveryId = asNonEmptyString(body.delivery_id) ?? randomUUID();

          try {
            const injectResult = await lifecycleRuntime.injectAgent(agentId, {
              text,
              submit,
              reinforce_submit: reinforceSubmit,
              probe_before_send: probeBeforeSend,
              probe_timeout_ms: body.probe_timeout_ms,
              probe_poll_ms: body.probe_poll_ms,
              rescue_submit_if_buffered: rescueSubmitIfBuffered,
              rescue_submit_delay_ms: body.rescue_submit_delay_ms
            });
            const delivery = store.markDeliverySent({
              stream_id: assignment.stream_id,
              mission_id: assignment.mission_id,
              agent_id: assignment.agent_id,
              delivery_id: deliveryId,
              ack_timeout_ms: ackTimeoutMs
            });
            writeJson(response, 200, {
              ok: true,
              result: {
                assignment: delivery.assignment,
                injected_text: text,
                injection: injectResult
              }
            });
            return true;
          } catch (error) {
            try {
              store.markDeliveryFailed({
                stream_id: assignment.stream_id,
                mission_id: assignment.mission_id,
                error: error?.message ?? 'inject_failed'
              });
            } catch {
              // Preserve original error if failure bookkeeping also fails.
            }
            throw error;
          }
        }

        writeJson(response, 404, {
          ok: false,
          error: 'not_found'
        });
        return true;
      } catch (error) {
        writeJson(response, statusCodeFromError(error), {
          ok: false,
          error: error?.code ?? 'internal_error',
          detail: error?.message ?? 'unknown error'
        });
        return true;
      }
    }
  };
}
