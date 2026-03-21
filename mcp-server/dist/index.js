#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createFramedMessageParser, writeMessage } from './mcp_stdio.js';

const SERVER_NAME = 'minimum-headroom';
const SERVER_VERSION = '1.2.2';
const PROTOCOL_VERSION = '2024-11-05';
const FACE_WS_URL = process.env.FACE_WS_URL ?? 'ws://127.0.0.1:8765/ws';
const FACE_HTTP_BASE_URL = (() => {
  const explicit = process.env.FACE_HTTP_BASE_URL;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return explicit.trim().replace(/\/+$/, '');
  }
  try {
    const url = new URL(FACE_WS_URL);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return 'http://127.0.0.1:8765';
  }
})();
const TOOL_NAME_STYLE = (process.env.MCP_TOOL_NAME_STYLE ?? 'dot').toLowerCase() === 'underscore' ? 'underscore' : 'dot';
const DEFAULT_SAY_TTL_MS = (() => {
  const raw = process.env.FACE_SAY_DEFAULT_TTL_MS;
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 60_000;
  }
  return parsed;
})();
const DEFAULT_FACE_AGENT_ID = (() => {
  const raw = process.env.MH_FACE_AGENT_ID;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
})();
const DEFAULT_FACE_AGENT_LABEL = (() => {
  const raw = process.env.MH_FACE_AGENT_LABEL;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
})();

const EVENT_NAMES = new Set([
  'cmd_started',
  'cmd_failed',
  'cmd_succeeded',
  'tests_failed',
  'tests_passed',
  'permission_required',
  'retrying',
  'idle'
]);

const BASE_TOOL_DEFINITIONS = [
  {
    name: 'face.event',
    description: 'Forward an event payload to the Face App over WebSocket.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['session_id', 'name'],
      properties: {
        session_id: { type: 'string', minLength: 1 },
        agent_id: { type: ['string', 'null'] },
        agent_label: { type: ['string', 'null'] },
        name: { type: 'string', enum: [...EVENT_NAMES] },
        severity: { type: 'number', minimum: 0, maximum: 1 },
        meta: { type: 'object' },
        ttl_ms: { type: 'integer', minimum: 1 }
      }
    }
  },
  {
    name: 'face.say',
    description: 'Forward a speech proposal payload to the Face App over WebSocket.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['session_id', 'text'],
      properties: {
        session_id: { type: 'string', minLength: 1 },
        agent_id: { type: ['string', 'null'] },
        agent_label: { type: ['string', 'null'] },
        text: { type: 'string', minLength: 1 },
        priority: { type: 'integer', minimum: 0, maximum: 3 },
        policy: { type: 'string', enum: ['replace', 'interrupt'] },
        ttl_ms: { type: 'integer', minimum: 1 },
        dedupe_key: { type: ['string', 'null'] },
        utterance_id: { type: ['string', 'null'] },
        message_id: { type: ['string', 'null'] },
        revision: { type: ['integer', 'null'] }
      }
    }
  },
  {
    name: 'face.ping',
    description: 'Check Face App connectivity and forward an optional ping message.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['session_id'],
      properties: {
        session_id: { type: 'string', minLength: 1 }
      }
    }
  },
  {
    name: 'agent.list',
    description: 'List managed helper agents visible to the current or requested stream.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        scope: { type: ['string', 'null'], enum: ['active', 'stream', 'all', null] },
        stream_id: { type: ['string', 'null'] }
      }
    }
  },
  {
    name: 'agent.spawn',
    description: 'Create a managed helper agent and optionally its worktree/tmux pane.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        id: { type: ['string', 'null'] },
        agent_id: { type: ['string', 'null'] },
        session_id: { type: ['string', 'null'] },
        source_repo_path: { type: ['string', 'null'] },
        target_repo_root: { type: ['string', 'null'] },
        worktree_path: { type: ['string', 'null'] },
        branch: { type: ['string', 'null'] },
        slot: { type: ['integer', 'null'] },
        create_worktree: { type: ['boolean', 'null'] },
        create_tmux: { type: ['boolean', 'null'] },
        agent_cmd: { type: ['string', 'null'] },
        stream_id: { type: ['string', 'null'] },
        permission_preset: { type: ['string', 'null'], enum: ['reviewer', 'implementer', 'full', null] }
      }
    }
  },
  {
    name: 'agent.focus',
    description: 'Switch the operator mirror/focus to one managed helper agent.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', minLength: 1 },
        session_id: { type: ['string', 'null'] }
      }
    }
  },
  {
    name: 'agent.delete',
    description: 'Delete one managed helper agent, including its pane/worktree when configured.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', minLength: 1 }
      }
    }
  },
  {
    name: 'agent.assign',
    description: 'Create or update one structured mission for a managed helper agent.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['stream_id', 'mission_id', 'owner_agent_id', 'agent_id', 'goal'],
      properties: {
        stream_id: { type: 'string', minLength: 1 },
        mission_id: { type: 'string', minLength: 1 },
        owner_agent_id: { type: 'string', minLength: 1 },
        agent_id: { type: 'string', minLength: 1 },
        role: { type: ['string', 'null'] },
        goal: { type: 'string', minLength: 1 },
        constraints: { type: ['string', 'null'] },
        target_paths: {
          type: ['array', 'null'],
          items: { type: 'string', minLength: 1 }
        },
        expected_output: { type: ['string', 'null'] },
        completion_criteria: { type: ['string', 'null'] },
        review_policy: { type: ['string', 'null'] },
        timebox_minutes: { type: ['integer', 'null'], minimum: 1 },
        max_findings: { type: ['integer', 'null'], minimum: 1 },
        detail: { type: ['string', 'null'] },
        prompt_text: { type: ['string', 'null'] }
      }
    }
  },
  {
    name: 'agent.inject',
    description: 'Inject the stored mission prompt into one helper pane through tmux.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['agent_id', 'mission_id'],
      properties: {
        agent_id: { type: 'string', minLength: 1 },
        mission_id: { type: 'string', minLength: 1 },
        stream_id: { type: ['string', 'null'] },
        ack_timeout_ms: { type: ['integer', 'null'], minimum: 1000 },
        wait_for_ready: { type: ['boolean', 'null'] },
        ready_timeout_ms: { type: ['integer', 'null'], minimum: 0 },
        ready_poll_ms: { type: ['integer', 'null'], minimum: 20 },
        probe_before_send: { type: ['boolean', 'null'] },
        probe_timeout_ms: { type: ['integer', 'null'], minimum: 100 },
        probe_poll_ms: { type: ['integer', 'null'], minimum: 20 },
        rescue_submit_if_buffered: { type: ['boolean', 'null'] },
        rescue_submit_delay_ms: { type: ['integer', 'null'], minimum: 20 },
        followup_mode: {
          type: ['string', 'null'],
          enum: ['completion_rescue', 'blocker_summary', null]
        },
        submit: { type: ['boolean', 'null'] },
        reinforce_submit: { type: ['boolean', 'null'] },
        delivery_id: { type: ['string', 'null'] }
      }
    }
  },
  {
    name: 'agent.assignment.list',
    description: 'List helper mission assignments and their current delivery states.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        stream_id: { type: ['string', 'null'] },
        owner_agent_id: { type: ['string', 'null'] },
        agent_id: { type: ['string', 'null'] },
        mission_id: { type: ['string', 'null'] }
      }
    }
  },
  {
    name: 'agent.report',
    description: 'Submit a structured helper report into the owner inbox.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['stream_id', 'mission_id', 'owner_agent_id', 'from_agent_id', 'kind', 'summary'],
      properties: {
        stream_id: { type: 'string', minLength: 1 },
        mission_id: { type: 'string', minLength: 1 },
        owner_agent_id: { type: 'string', minLength: 1 },
        from_agent_id: { type: 'string', minLength: 1 },
        kind: { type: 'string', enum: ['progress', 'done', 'question', 'blocked', 'review_findings', 'error'] },
        summary: { type: 'string', minLength: 1 },
        detail: { type: ['string', 'null'] },
        requested_action: { type: ['string', 'null'] },
        blocking: { type: ['boolean', 'null'] },
        severity: { type: ['number', 'null'] },
        supersedes_report_id: { type: ['string', 'null'] },
        report_id: { type: ['string', 'null'] },
        ts: { type: ['integer', 'null'] }
      }
    }
  },
  {
    name: 'owner.inbox.list',
    description: 'List owner inbox reports and summaries for one owner or stream.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['owner_agent_id'],
      properties: {
        owner_agent_id: { type: 'string', minLength: 1 },
        stream_id: { type: ['string', 'null'] },
        include_resolved: { type: ['boolean', 'null'] }
      }
    }
  },
  {
    name: 'owner.inbox.resolve',
    description: 'Advance a report lifecycle state in the owner inbox.',
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: ['stream_id', 'report_id'],
      properties: {
        stream_id: { type: 'string', minLength: 1 },
        report_id: { type: 'string', minLength: 1 },
        action: { type: ['string', 'null'], enum: ['seen_by_owner', 'acted_on', 'resolved', 'dismissed', null] }
      }
    }
  }
];

function toDisplayToolName(canonicalName) {
  if (TOOL_NAME_STYLE === 'underscore') {
    return canonicalName.replaceAll('.', '_');
  }
  return canonicalName;
}

function canonicalizeToolName(toolName) {
  if (toolName === 'face_event') {
    return 'face.event';
  }
  if (toolName === 'face_say') {
    return 'face.say';
  }
  if (toolName === 'face_ping') {
    return 'face.ping';
  }
  if (toolName === 'agent_list') {
    return 'agent.list';
  }
  if (toolName === 'agent_spawn') {
    return 'agent.spawn';
  }
  if (toolName === 'agent_focus') {
    return 'agent.focus';
  }
  if (toolName === 'agent_delete') {
    return 'agent.delete';
  }
  if (toolName === 'agent_assign') {
    return 'agent.assign';
  }
  if (toolName === 'agent_inject') {
    return 'agent.inject';
  }
  if (toolName === 'agent_assignment_list') {
    return 'agent.assignment.list';
  }
  if (toolName === 'agent_report') {
    return 'agent.report';
  }
  if (toolName === 'owner_inbox_list') {
    return 'owner.inbox.list';
  }
  if (toolName === 'owner_inbox_resolve') {
    return 'owner.inbox.resolve';
  }
  return toolName;
}

const TOOL_DEFINITIONS = BASE_TOOL_DEFINITIONS.map((definition) => ({
  ...definition,
  name: toDisplayToolName(definition.name)
}));

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value, fieldName) {
  if (!isObject(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value;
}

function requireString(source, key) {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(source, key, fallback = null) {
  const value = source[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string when provided`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function optionalNumber(source, key, fallback) {
  const value = source[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`${key} must be a number when provided`);
  }
  return value;
}

function optionalInteger(source, key, fallback) {
  const value = source[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer when provided`);
  }
  return value;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toolTextResult(text, extra = {}) {
  return {
    content: [{ type: 'text', text }],
    ...extra
  };
}

async function callFaceHttp(pathname, options = {}) {
  const url = new URL(pathname, `${FACE_HTTP_BASE_URL}/`);
  const method = options.method ?? 'GET';
  const body = options.body ?? null;
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json; charset=utf-8' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => null);
  return { response, payload, url: url.toString() };
}

async function forwardToFace(payload, options = {}) {
  if (typeof WebSocket !== 'function') {
    throw new Error('Global WebSocket is unavailable in this Node runtime');
  }

  const awaitSayResult =
    options.awaitSayResult === true &&
    payload?.type === 'say' &&
    typeof payload.message_id === 'string' &&
    payload.message_id.trim() !== '';

  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(FACE_WS_URL);
    let settled = false;

    const settle = (error, response = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    };

    const timeout = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Ignore close errors during timeout path.
      }
      if (awaitSayResult) {
        // Keep backwards compatibility with phase1 receivers that do not emit say_result.
        settle(null, null);
        return;
      }
      settle(new Error(`WebSocket timeout for ${FACE_WS_URL}`));
    }, awaitSayResult ? 500 : 1_500);

    const onOpen = () => {
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        settle(new Error(`WebSocket send failed: ${error.message}`));
        return;
      }

      if (awaitSayResult) {
        return;
      }

      setTimeout(() => {
        try {
          socket.close();
        } catch {
          // Ignore close errors during normal path.
        }
        settle(null, null);
      }, 10);
    };

    const onError = () => {
      settle(new Error(`WebSocket connection failed for ${FACE_WS_URL}`));
    };

    const onClose = () => {
      settle(null, null);
    };

    const onMessage = (event) => {
      if (!awaitSayResult) {
        return;
      }

      const raw = typeof event.data === 'string' ? event.data : null;
      if (!raw) {
        return;
      }

      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      if (!message || message.type !== 'say_result') {
        return;
      }

      if (message.message_id !== payload.message_id) {
        return;
      }

      try {
        socket.close();
      } catch {
        // Ignore close errors after successful ack.
      }
      settle(null, message);
    };

    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
  });
}

function normalizeEventPayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  const sessionId = requireString(args, 'session_id');
  const agentId = optionalString(args, 'agent_id', DEFAULT_FACE_AGENT_ID);
  const agentLabel = optionalString(args, 'agent_label', DEFAULT_FACE_AGENT_LABEL);
  const name = requireString(args, 'name');
  if (!EVENT_NAMES.has(name)) {
    throw new Error(`name must be one of: ${[...EVENT_NAMES].join(', ')}`);
  }

  const severity = clamp(optionalNumber(args, 'severity', 0.5), 0, 1);
  const meta = args.meta === undefined ? {} : args.meta;
  if (!isObject(meta)) {
    throw new Error('meta must be an object when provided');
  }
  const ttlMs = optionalInteger(args, 'ttl_ms', 30000);
  if (ttlMs <= 0) {
    throw new Error('ttl_ms must be greater than zero');
  }

  return {
    v: 1,
    type: 'event',
    session_id: sessionId,
    ...(agentId ? { agent_id: agentId } : {}),
    ...(agentLabel ? { agent_label: agentLabel } : {}),
    ts: Date.now(),
    name,
    severity,
    meta,
    ttl_ms: ttlMs
  };
}

function normalizeSayPayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  const sessionId = requireString(args, 'session_id');
  const agentId = optionalString(args, 'agent_id', DEFAULT_FACE_AGENT_ID);
  const agentLabel = optionalString(args, 'agent_label', DEFAULT_FACE_AGENT_LABEL);
  const text = requireString(args, 'text');
  const priority = clamp(optionalInteger(args, 'priority', 0), 0, 3);
  const ttlMs = optionalInteger(args, 'ttl_ms', DEFAULT_SAY_TTL_MS);
  if (ttlMs <= 0) {
    throw new Error('ttl_ms must be greater than zero');
  }

  const policy = args.policy ?? 'replace';
  if (policy !== 'replace' && policy !== 'interrupt') {
    throw new Error('policy must be "replace" or "interrupt"');
  }

  const dedupeKey = args.dedupe_key ?? null;
  if (dedupeKey !== null && typeof dedupeKey !== 'string') {
    throw new Error('dedupe_key must be string or null');
  }

  const utteranceId = args.utterance_id ?? randomUUID();
  if (utteranceId !== null && typeof utteranceId !== 'string') {
    throw new Error('utterance_id must be string or null');
  }

  const messageId = args.message_id ?? randomUUID();
  if (messageId !== null && (typeof messageId !== 'string' || messageId.trim() === '')) {
    throw new Error('message_id must be non-empty string or null');
  }

  const revision = optionalInteger(args, 'revision', Date.now());

  return {
    v: 1,
    type: 'say',
    session_id: sessionId,
    ...(agentId ? { agent_id: agentId } : {}),
    ...(agentLabel ? { agent_label: agentLabel } : {}),
    ts: Date.now(),
    utterance_id: utteranceId,
    text,
    priority,
    policy,
    ttl_ms: ttlMs,
    dedupe_key: dedupeKey,
    message_id: messageId,
    revision
  };
}

function normalizePingPayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  const sessionId = requireString(args, 'session_id');

  return {
    v: 1,
    type: 'ping',
    session_id: sessionId,
    ts: Date.now()
  };
}

function normalizeAgentReportPayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  const streamId = requireString(args, 'stream_id');
  const missionId = requireString(args, 'mission_id');
  const ownerAgentId = requireString(args, 'owner_agent_id');
  const fromAgentId = requireString(args, 'from_agent_id');
  const kind = requireString(args, 'kind');
  if (!['progress', 'done', 'question', 'blocked', 'review_findings', 'error'].includes(kind)) {
    throw new Error('kind must be one of: progress, done, question, blocked, review_findings, error');
  }
  const summary = requireString(args, 'summary');
  const detail = args.detail ?? null;
  if (detail !== null && typeof detail !== 'string') {
    throw new Error('detail must be string or null');
  }
  const requestedAction = args.requested_action ?? null;
  if (requestedAction !== null && typeof requestedAction !== 'string') {
    throw new Error('requested_action must be string or null');
  }
  const blocking = args.blocking ?? null;
  if (blocking !== null && typeof blocking !== 'boolean') {
    throw new Error('blocking must be boolean or null');
  }
  const severity = args.severity ?? null;
  if (severity !== null && (typeof severity !== 'number' || Number.isNaN(severity))) {
    throw new Error('severity must be number or null');
  }
  const supersedesReportId = args.supersedes_report_id ?? null;
  if (supersedesReportId !== null && typeof supersedesReportId !== 'string') {
    throw new Error('supersedes_report_id must be string or null');
  }
  const reportId = args.report_id ?? randomUUID();
  if (typeof reportId !== 'string' || reportId.trim() === '') {
    throw new Error('report_id must be string or null');
  }
  const ts = args.ts ?? Date.now();
  if (!Number.isInteger(ts)) {
    throw new Error('ts must be integer or null');
  }
  return {
    stream_id: streamId,
    mission_id: missionId,
    owner_agent_id: ownerAgentId,
    from_agent_id: fromAgentId,
    kind,
    summary,
    detail,
    requested_action: requestedAction,
    blocking,
    severity,
    supersedes_report_id: supersedesReportId,
    report_id: reportId,
    ts
  };
}

function normalizeAgentListPayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  const rawScope = args.scope ?? 'active';
  const scope = rawScope === 'stream' ? 'active' : rawScope;
  if (scope !== null && !['active', 'all'].includes(scope)) {
    throw new Error('scope must be one of: active, stream, all, null');
  }
  const streamId = args.stream_id ?? null;
  if (streamId !== null && typeof streamId !== 'string') {
    throw new Error('stream_id must be string or null');
  }
  return {
    scope,
    stream_id: streamId
  };
}

function normalizeAgentSpawnPayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  const payload = {};
  const id = optionalString(args, 'id');
  const agentId = optionalString(args, 'agent_id');
  if (id && agentId && id !== agentId) {
    throw new Error('id and agent_id must match when both are provided');
  }
  if (id || agentId) {
    payload.id = id ?? agentId;
  }
  const optionalStringKeys = [
    'session_id',
    'source_repo_path',
    'target_repo_root',
    'worktree_path',
    'branch',
    'agent_cmd',
    'stream_id',
    'permission_preset'
  ];
  for (const key of optionalStringKeys) {
    const value = args[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new Error(`${key} must be string or null`);
    }
    payload[key] = value;
  }
  if (args.slot !== undefined && args.slot !== null) {
    if (!Number.isInteger(args.slot)) {
      throw new Error('slot must be integer or null');
    }
    payload.slot = args.slot;
  }
  for (const key of ['create_worktree', 'create_tmux']) {
    const value = args[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'boolean') {
      throw new Error(`${key} must be boolean or null`);
    }
    payload[key] = value;
  }
  return payload;
}

function normalizeAgentFocusPayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  const agentId = requireString(args, 'agent_id');
  const sessionId = args.session_id ?? null;
  if (sessionId !== null && typeof sessionId !== 'string') {
    throw new Error('session_id must be string or null');
  }
  return {
    agent_id: agentId,
    session_id: sessionId
  };
}

function normalizeAgentDeletePayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  return {
    agent_id: requireString(args, 'agent_id')
  };
}

function normalizeAgentAssignPayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  const payload = {
    stream_id: requireString(args, 'stream_id'),
    mission_id: requireString(args, 'mission_id'),
    owner_agent_id: requireString(args, 'owner_agent_id'),
    agent_id: requireString(args, 'agent_id'),
    goal: requireString(args, 'goal')
  };
  for (const key of ['role', 'constraints', 'expected_output', 'completion_criteria', 'review_policy', 'detail', 'prompt_text']) {
    const value = args[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new Error(`${key} must be string or null`);
    }
    payload[key] = value;
  }
  if (args.target_paths !== undefined && args.target_paths !== null) {
    if (!Array.isArray(args.target_paths) || args.target_paths.some((item) => typeof item !== 'string')) {
      throw new Error('target_paths must be array of strings or null');
    }
    payload.target_paths = args.target_paths;
  }
  for (const key of ['timebox_minutes', 'max_findings']) {
    const value = args[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${key} must be integer >= 1 or null`);
    }
    payload[key] = value;
  }
  return payload;
}

function normalizeAgentInjectPayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  const payload = {
    agent_id: requireString(args, 'agent_id'),
    mission_id: requireString(args, 'mission_id')
  };
  if (args.stream_id !== undefined && args.stream_id !== null) {
    if (typeof args.stream_id !== 'string') {
      throw new Error('stream_id must be string or null');
    }
    payload.stream_id = args.stream_id;
  }
  if (args.ack_timeout_ms !== undefined && args.ack_timeout_ms !== null) {
    if (!Number.isInteger(args.ack_timeout_ms)) {
      throw new Error('ack_timeout_ms must be integer or null');
    }
    payload.ack_timeout_ms = args.ack_timeout_ms;
  }
  for (const key of ['ready_timeout_ms', 'ready_poll_ms', 'probe_timeout_ms', 'probe_poll_ms', 'rescue_submit_delay_ms']) {
    const value = args[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (!Number.isInteger(value)) {
      throw new Error(`${key} must be integer or null`);
    }
    payload[key] = value;
  }
  for (const key of ['wait_for_ready', 'submit', 'reinforce_submit', 'probe_before_send', 'rescue_submit_if_buffered']) {
    const value = args[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'boolean') {
      throw new Error(`${key} must be boolean or null`);
    }
    payload[key] = value;
  }
  if (args.delivery_id !== undefined && args.delivery_id !== null) {
    if (typeof args.delivery_id !== 'string') {
      throw new Error('delivery_id must be string or null');
    }
    payload.delivery_id = args.delivery_id;
  }
  if (args.followup_mode !== undefined && args.followup_mode !== null) {
    if (typeof args.followup_mode !== 'string' || !['completion_rescue', 'blocker_summary'].includes(args.followup_mode)) {
      throw new Error('followup_mode must be completion_rescue, blocker_summary, or null');
    }
    payload.followup_mode = args.followup_mode;
  }
  return payload;
}

function normalizeAgentAssignmentListPayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  const payload = {};
  for (const key of ['stream_id', 'owner_agent_id', 'agent_id', 'mission_id']) {
    const value = args[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== 'string') {
      throw new Error(`${key} must be string or null`);
    }
    payload[key] = value;
  }
  return payload;
}

function normalizeOwnerInboxListPayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  const ownerAgentId = requireString(args, 'owner_agent_id');
  const streamId = args.stream_id ?? null;
  if (streamId !== null && typeof streamId !== 'string') {
    throw new Error('stream_id must be string or null');
  }
  const includeResolved = args.include_resolved ?? false;
  if (typeof includeResolved !== 'boolean') {
    throw new Error('include_resolved must be boolean or null');
  }
  return {
    owner_agent_id: ownerAgentId,
    stream_id: streamId,
    include_resolved: includeResolved
  };
}

function normalizeOwnerInboxResolvePayload(rawArguments) {
  const args = requireObject(rawArguments ?? {}, 'arguments');
  const streamId = requireString(args, 'stream_id');
  const reportId = requireString(args, 'report_id');
  const action = args.action ?? 'resolved';
  if (!['seen_by_owner', 'acted_on', 'resolved', 'dismissed'].includes(action)) {
    throw new Error('action must be one of: seen_by_owner, acted_on, resolved, dismissed');
  }
  return {
    stream_id: streamId,
    report_id: reportId,
    action
  };
}

async function handleToolCall(params) {
  const request = requireObject(params ?? {}, 'params');
  const rawToolName = requireString(request, 'name');
  const toolName = canonicalizeToolName(rawToolName);
  const rawArguments = request.arguments ?? {};

  if (toolName === 'face.event') {
    try {
      const payload = normalizeEventPayload(rawArguments);
      await forwardToFace(payload);
      return toolTextResult('forwarded face.event', {
        structuredContent: { ok: true, ws: FACE_WS_URL, payload }
      });
    } catch (error) {
      return toolTextResult(`face.event failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, ws: FACE_WS_URL }
      });
    }
  }

  if (toolName === 'face.say') {
    try {
      const payload = normalizeSayPayload(rawArguments);
      const sayResult = await forwardToFace(payload, { awaitSayResult: true });
      const spoken = typeof sayResult?.spoken === 'boolean' ? sayResult.spoken : null;
      const reason = typeof sayResult?.reason === 'string' ? sayResult.reason : null;

      return toolTextResult(`forwarded face.say spoken=${spoken ?? 'unknown'} reason=${reason ?? '-'}`, {
        structuredContent: { ok: true, ws: FACE_WS_URL, payload, say_result: sayResult ?? null, spoken, reason }
      });
    } catch (error) {
      return toolTextResult(`face.say failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, ws: FACE_WS_URL }
      });
    }
  }

  if (toolName === 'face.ping') {
    try {
      const payload = normalizePingPayload(rawArguments);
      await forwardToFace(payload);
      return toolTextResult('forwarded face.ping', {
        structuredContent: { ok: true, ws: FACE_WS_URL, payload }
      });
    } catch (error) {
      return toolTextResult(`face.ping failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, ws: FACE_WS_URL }
      });
    }
  }

  if (toolName === 'agent.list') {
    try {
      const payload = normalizeAgentListPayload(rawArguments);
      const query = new URLSearchParams();
      if (payload.scope) {
        query.set('scope', payload.scope);
      }
      if (payload.stream_id) {
        query.set('stream_id', payload.stream_id);
      }
      const path = query.size > 0 ? `/api/agents?${query.toString()}` : '/api/agents';
      const { response, payload: apiPayload, url } = await callFaceHttp(path);
      if (!response.ok || apiPayload?.ok !== true) {
        const detail = typeof apiPayload?.detail === 'string' ? apiPayload.detail : `http_${response.status}`;
        return toolTextResult(`agent.list failed: ${detail}`, {
          isError: true,
          structuredContent: { ok: false, http: url, status: response.status, payload: apiPayload }
        });
      }
      const agents = Array.isArray(apiPayload?.agents) ? apiPayload.agents : [];
      return toolTextResult(`listed agents count=${agents.length}`, {
        structuredContent: {
          ok: true,
          http: url,
          active_stream_id: apiPayload?.active_stream_id ?? null,
          active_target_repo_root: apiPayload?.active_target_repo_root ?? null,
          agents
        }
      });
    } catch (error) {
      return toolTextResult(`agent.list failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, http: FACE_HTTP_BASE_URL }
      });
    }
  }

  if (toolName === 'agent.spawn') {
    try {
      const payload = normalizeAgentSpawnPayload(rawArguments);
      const { response, payload: apiPayload, url } = await callFaceHttp('/api/agents/add', {
        method: 'POST',
        body: payload
      });
      if (!response.ok || apiPayload?.ok !== true) {
        const detail = typeof apiPayload?.detail === 'string' ? apiPayload.detail : `http_${response.status}`;
        return toolTextResult(`agent.spawn failed: ${detail}`, {
          isError: true,
          structuredContent: { ok: false, http: url, status: response.status, payload: apiPayload }
        });
      }
      const agentId = apiPayload?.result?.agent?.id ?? payload.id ?? '-';
      return toolTextResult(`spawned agent id=${agentId}`, {
        structuredContent: { ok: true, http: url, request: payload, result: apiPayload.result }
      });
    } catch (error) {
      return toolTextResult(`agent.spawn failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, http: FACE_HTTP_BASE_URL }
      });
    }
  }

  if (toolName === 'agent.focus') {
    try {
      const payload = normalizeAgentFocusPayload(rawArguments);
      const requestBody = {};
      if (payload.session_id) {
        requestBody.session_id = payload.session_id;
      }
      const { response, payload: apiPayload, url } = await callFaceHttp(`/api/agents/${encodeURIComponent(payload.agent_id)}/focus`, {
        method: 'POST',
        body: requestBody
      });
      if (!response.ok || apiPayload?.ok !== true) {
        const detail = typeof apiPayload?.detail === 'string' ? apiPayload.detail : `http_${response.status}`;
        return toolTextResult(`agent.focus failed: ${detail}`, {
          isError: true,
          structuredContent: { ok: false, http: url, status: response.status, payload: apiPayload }
        });
      }
      const paneId = apiPayload?.result?.focus?.pane_id ?? null;
      return toolTextResult(`focused agent id=${payload.agent_id}${paneId ? ` pane=${paneId}` : ''}`, {
        structuredContent: { ok: true, http: url, request: payload, result: apiPayload.result }
      });
    } catch (error) {
      return toolTextResult(`agent.focus failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, http: FACE_HTTP_BASE_URL }
      });
    }
  }

  if (toolName === 'agent.delete') {
    try {
      const payload = normalizeAgentDeletePayload(rawArguments);
      const { response, payload: apiPayload, url } = await callFaceHttp(`/api/agents/${encodeURIComponent(payload.agent_id)}/delete`, {
        method: 'POST',
        body: {}
      });
      if (!response.ok || apiPayload?.ok !== true) {
        const detail = typeof apiPayload?.detail === 'string' ? apiPayload.detail : `http_${response.status}`;
        return toolTextResult(`agent.delete failed: ${detail}`, {
          isError: true,
          structuredContent: { ok: false, http: url, status: response.status, payload: apiPayload }
        });
      }
      return toolTextResult(`deleted agent id=${payload.agent_id}`, {
        structuredContent: { ok: true, http: url, request: payload, result: apiPayload.result }
      });
    } catch (error) {
      return toolTextResult(`agent.delete failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, http: FACE_HTTP_BASE_URL }
      });
    }
  }

  if (toolName === 'agent.assign') {
    try {
      const payload = normalizeAgentAssignPayload(rawArguments);
      const { response, payload: apiPayload, url } = await callFaceHttp('/api/agent-assignments/assign', {
        method: 'POST',
        body: payload
      });
      if (!response.ok || apiPayload?.ok !== true) {
        const detail = typeof apiPayload?.detail === 'string' ? apiPayload.detail : `http_${response.status}`;
        return toolTextResult(`agent.assign failed: ${detail}`, {
          isError: true,
          structuredContent: { ok: false, http: url, status: response.status, payload: apiPayload }
        });
      }
      const action = apiPayload?.result?.action ?? 'created';
      return toolTextResult(`stored assignment mission_id=${payload.mission_id} action=${action}`, {
        structuredContent: { ok: true, http: url, request: payload, result: apiPayload.result }
      });
    } catch (error) {
      return toolTextResult(`agent.assign failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, http: FACE_HTTP_BASE_URL }
      });
    }
  }

  if (toolName === 'agent.inject') {
    try {
      const payload = normalizeAgentInjectPayload(rawArguments);
      const { response, payload: apiPayload, url } = await callFaceHttp('/api/agent-assignments/inject', {
        method: 'POST',
        body: payload
      });
      if (!response.ok || apiPayload?.ok !== true) {
        const detail = typeof apiPayload?.detail === 'string' ? apiPayload.detail : `http_${response.status}`;
        return toolTextResult(`agent.inject failed: ${detail}`, {
          isError: true,
          structuredContent: { ok: false, http: url, status: response.status, payload: apiPayload }
        });
      }
      const deliveryState = apiPayload?.result?.assignment?.delivery_state ?? null;
      return toolTextResult(`injected mission_id=${payload.mission_id}${deliveryState ? ` delivery=${deliveryState}` : ''}`, {
        structuredContent: { ok: true, http: url, request: payload, result: apiPayload.result }
      });
    } catch (error) {
      return toolTextResult(`agent.inject failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, http: FACE_HTTP_BASE_URL }
      });
    }
  }

  if (toolName === 'agent.assignment.list') {
    try {
      const payload = normalizeAgentAssignmentListPayload(rawArguments);
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(payload)) {
        if (typeof value === 'string' && value.trim() !== '') {
          query.set(key, value);
        }
      }
      const path = query.size > 0 ? `/api/agent-assignments/list?${query.toString()}` : '/api/agent-assignments/list';
      const { response, payload: apiPayload, url } = await callFaceHttp(path);
      if (!response.ok || apiPayload?.ok !== true) {
        const detail = typeof apiPayload?.detail === 'string' ? apiPayload.detail : `http_${response.status}`;
        return toolTextResult(`agent.assignment.list failed: ${detail}`, {
          isError: true,
          structuredContent: { ok: false, http: url, status: response.status, payload: apiPayload }
        });
      }
      const assignments = Array.isArray(apiPayload?.state?.assignments) ? apiPayload.state.assignments : [];
      return toolTextResult(`listed assignments count=${assignments.length}`, {
        structuredContent: { ok: true, http: url, state: apiPayload.state }
      });
    } catch (error) {
      return toolTextResult(`agent.assignment.list failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, http: FACE_HTTP_BASE_URL }
      });
    }
  }

  if (toolName === 'agent.report') {
    try {
      const payload = normalizeAgentReportPayload(rawArguments);
      const { response, payload: apiPayload, url } = await callFaceHttp('/api/owner-inbox/report', {
        method: 'POST',
        body: payload
      });
      if (!response.ok || apiPayload?.ok !== true) {
        const detail = typeof apiPayload?.detail === 'string' ? apiPayload.detail : `http_${response.status}`;
        return toolTextResult(`agent.report failed: ${detail}`, {
          isError: true,
          structuredContent: { ok: false, http: url, status: response.status, payload: apiPayload }
        });
      }
      const transportState = typeof apiPayload?.result?.transport_state === 'string' ? apiPayload.result.transport_state : 'accepted';
      const reason = typeof apiPayload?.result?.reason === 'string' ? apiPayload.result.reason : null;
      return toolTextResult(`submitted agent.report transport=${transportState}${reason ? ` reason=${reason}` : ''}`, {
        structuredContent: { ok: true, http: url, request: payload, result: apiPayload.result }
      });
    } catch (error) {
      return toolTextResult(`agent.report failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, http: FACE_HTTP_BASE_URL }
      });
    }
  }

  if (toolName === 'owner.inbox.list') {
    try {
      const payload = normalizeOwnerInboxListPayload(rawArguments);
      const query = new URLSearchParams();
      query.set('owner_agent_id', payload.owner_agent_id);
      if (payload.stream_id) {
        query.set('stream_id', payload.stream_id);
      }
      if (payload.include_resolved) {
        query.set('include_resolved', '1');
      }
      const { response, payload: apiPayload, url } = await callFaceHttp(`/api/owner-inbox/list?${query.toString()}`);
      if (!response.ok || apiPayload?.ok !== true) {
        const detail = typeof apiPayload?.detail === 'string' ? apiPayload.detail : `http_${response.status}`;
        return toolTextResult(`owner.inbox.list failed: ${detail}`, {
          isError: true,
          structuredContent: { ok: false, http: url, status: response.status, payload: apiPayload }
        });
      }
      const unresolvedCount = apiPayload?.state?.summary?.unresolved_count ?? 0;
      return toolTextResult(`listed owner inbox unresolved=${unresolvedCount}`, {
        structuredContent: { ok: true, http: url, state: apiPayload.state }
      });
    } catch (error) {
      return toolTextResult(`owner.inbox.list failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, http: FACE_HTTP_BASE_URL }
      });
    }
  }

  if (toolName === 'owner.inbox.resolve') {
    try {
      const payload = normalizeOwnerInboxResolvePayload(rawArguments);
      const { response, payload: apiPayload, url } = await callFaceHttp('/api/owner-inbox/resolve', {
        method: 'POST',
        body: payload
      });
      if (!response.ok || apiPayload?.ok !== true) {
        const detail = typeof apiPayload?.detail === 'string' ? apiPayload.detail : `http_${response.status}`;
        return toolTextResult(`owner.inbox.resolve failed: ${detail}`, {
          isError: true,
          structuredContent: { ok: false, http: url, status: response.status, payload: apiPayload }
        });
      }
      const lifecycleState = apiPayload?.result?.report?.lifecycle_state ?? payload.action;
      return toolTextResult(`updated owner inbox report state=${lifecycleState}`, {
        structuredContent: { ok: true, http: url, request: payload, result: apiPayload.result }
      });
    } catch (error) {
      return toolTextResult(`owner.inbox.resolve failed: ${error.message}`, {
        isError: true,
        structuredContent: { ok: false, http: FACE_HTTP_BASE_URL }
      });
    }
  }

  return toolTextResult(`Unknown tool: ${toolName}`, {
    isError: true,
    structuredContent: { ok: false, ws: FACE_WS_URL, http: FACE_HTTP_BASE_URL }
  });
}

function sendResponse(id, result, format = 'framed') {
  writeMessage(process.stdout, {
    jsonrpc: '2.0',
    id,
    result
  }, format);
}

function sendError(id, code, message, data, format = 'framed') {
  writeMessage(process.stdout, {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  }, format);
}

async function handleRequest(message, format = 'framed') {
  const id = message.id;
  if (typeof message.method !== 'string') {
    sendError(id ?? null, -32600, 'Invalid Request', undefined, format);
    return;
  }

  try {
    if (message.method === 'initialize') {
      sendResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        }
      }, format);
      return;
    }

    if (message.method === 'tools/list') {
      sendResponse(id, { tools: TOOL_DEFINITIONS }, format);
      return;
    }

    if (message.method === 'tools/call') {
      const result = await handleToolCall(message.params);
      sendResponse(id, result, format);
      return;
    }

    sendError(id, -32601, `Method not found: ${message.method}`, undefined, format);
  } catch (error) {
    sendError(id, -32603, error.message, undefined, format);
  }
}

function handleNotification(message) {
  if (message.method === 'notifications/initialized' || message.method === 'initialized') {
    return;
  }
  // Ignore unknown notifications in phase 1.
}

const parseChunk = createFramedMessageParser((message, meta = {}) => {
  if (!isObject(message)) {
    return;
  }

  const format = meta.format === 'line' ? 'line' : 'framed';
  const hasMethod = typeof message.method === 'string';
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');

  if (hasMethod && hasId) {
    handleRequest(message, format).catch((error) => {
      sendError(message.id ?? null, -32603, error.message, undefined, format);
    });
    return;
  }

  if (hasMethod) {
    handleNotification(message);
  }
});

process.stdin.on('data', (chunk) => {
  try {
    parseChunk(chunk);
  } catch (error) {
    sendError(null, -32700, `Parse error: ${error.message}`);
  }
});

process.stdin.on('error', (error) => {
  console.error(`[mcp-server] stdin error: ${error.message}`);
});

process.stdin.resume();
console.error(`[mcp-server] ready; forwarding to ${FACE_WS_URL} and ${FACE_HTTP_BASE_URL}`);
