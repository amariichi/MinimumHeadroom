#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createFramedMessageParser, writeMessage } from './mcp_stdio.js';

const SERVER_NAME = 'minimum-headroom';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const FACE_WS_URL = process.env.FACE_WS_URL ?? 'ws://127.0.0.1:8765/ws';
const TOOL_NAME_STYLE = (process.env.MCP_TOOL_NAME_STYLE ?? 'dot').toLowerCase() === 'underscore' ? 'underscore' : 'dot';
const DEFAULT_SAY_TTL_MS = (() => {
  const raw = process.env.FACE_SAY_DEFAULT_TTL_MS;
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return 60_000;
  }
  return parsed;
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
        text: { type: 'string', minLength: 1 },
        priority: { type: 'integer', minimum: 0, maximum: 3 },
        policy: { type: 'string', enum: ['replace', 'interrupt'] },
        ttl_ms: { type: 'integer', minimum: 1 },
        dedupe_key: { type: ['string', 'null'] },
        language: { type: ['string', 'null'], enum: ['ja', 'en', null] },
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

  const language = args.language ?? null;
  if (language !== null && language !== 'ja' && language !== 'en') {
    throw new Error('language must be "ja", "en", or null');
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
    ts: Date.now(),
    utterance_id: utteranceId,
    text,
    priority,
    policy,
    ttl_ms: ttlMs,
    dedupe_key: dedupeKey,
    language,
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

  return toolTextResult(`Unknown tool: ${toolName}`, {
    isError: true,
    structuredContent: { ok: false, ws: FACE_WS_URL }
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
console.error(`[mcp-server] ready; forwarding to ${FACE_WS_URL}`);
