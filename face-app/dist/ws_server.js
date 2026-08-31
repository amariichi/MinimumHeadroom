import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPERATOR_BRIDGE_PROTOCOL = 'mh-operator-bridge-v1';
const TERMINAL_CLIENT_MESSAGE_TYPES = new Set([
  'operator_terminal_subscribe',
  'operator_terminal_unsubscribe',
  'operator_terminal_ack',
  'operator_terminal_resync'
]);
const TERMINAL_STREAM_MESSAGE_TYPES = new Set([
  'operator_terminal_reset',
  'operator_terminal_data',
  'operator_terminal_error'
]);

// Shortest gap between two reset requests made on one socket's behalf.
const TERMINAL_RESYNC_RETRY_MS = 1000;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.woff2', 'font/woff2']
]);

function normalizePath(pathname) {
  if (!pathname || pathname === '/') {
    return '/ws';
  }
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function toLogger(log) {
  if (!log) {
    return { info: () => {}, error: () => {} };
  }
  return {
    info: typeof log.info === 'function' ? log.info.bind(log) : console.log.bind(console),
    error: typeof log.error === 'function' ? log.error.bind(log) : console.error.bind(console)
  };
}

function websocketAcceptValue(key) {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function receivedPayloadLogMessage(payload) {
  if (payload?.type === 'operator_terminal_data' || payload?.type === 'operator_terminal_ack') {
    return null;
  }
  if (payload?.type === 'operator_terminal_reset') {
    const dataBase64 = typeof payload.data_base64 === 'string' ? payload.data_base64 : '';
    return JSON.stringify({
      v: payload.v,
      type: payload.type,
      session_id: payload.session_id,
      pane: payload.pane,
      generation: payload.generation,
      seq: payload.seq,
      cols: payload.cols,
      rows: payload.rows,
      data_base64_chars: dataBase64.length
    });
  }
  if (payload?.type !== 'atom_audio_frame') {
    return JSON.stringify(payload);
  }
  const sequence = Number.isFinite(payload.seq)
    ? Math.floor(payload.seq)
    : null;
  if (sequence !== null && sequence !== 1 && sequence % 50 !== 0) {
    return null;
  }
  const audioBase64 = typeof payload.audio_base64 === 'string'
    ? payload.audio_base64
    : typeof payload.audioBase64 === 'string'
      ? payload.audioBase64
      : '';
  return JSON.stringify({
    v: payload.v,
    type: payload.type,
    session_id: payload.session_id,
    device_id: payload.device_id,
    sample_rate: payload.sample_rate,
    sample_count: payload.sample_count,
    encoding: payload.encoding,
    generation: payload.generation,
    seq: payload.seq,
    audio_base64_chars: audioBase64.length
  });
}

export function armTerminalResetAfterDrain(socket, requestReset) {
  if (
    !socket
    || socket.__mhTerminalResetOnDrain === true
    || typeof socket.once !== 'function'
    || typeof requestReset !== 'function'
  ) {
    return false;
  }
  socket.__mhTerminalResetOnDrain = true;
  socket.once('drain', () => {
    socket.__mhTerminalResetOnDrain = false;
    if (socket.__mhTerminalNeedsReset === true) {
      requestReset();
    }
  });
  return true;
}

// Decides what to do with one terminal data frame for one socket.
//
//   'send'    deliver it
//   'latch'   the write buffer is over the limit: stop sending output and wait
//             for a full-screen reset to replace what this socket will miss
//   'suppress' already latched and still behind: drop silently
//   'resync'  already latched but the buffer has drained: ask for the reset now
//
// The 'resync' case exists because the socket 'drain' event is not a reliable
// wake-up. A socket can fall behind, catch up quietly, and never emit 'drain',
// which used to leave the mirror latched off forever - the terminal simply
// stopped updating until the user switched panes.
export function planTerminalDataDelivery(socket, highWaterBytes) {
  const buffered = Number(socket?.writableLength ?? 0);
  const overHighWater = Number.isFinite(buffered) && buffered > highWaterBytes;
  if (socket?.__mhTerminalNeedsReset === true) {
    return overHighWater ? 'suppress' : 'resync';
  }
  return overHighWater ? 'latch' : 'send';
}

export function encodeTerminalPayloadForSubscription(payload, subscription) {
  if (
    subscription?.dataEncoding !== 'gzip-base64'
    || !TERMINAL_STREAM_MESSAGE_TYPES.has(payload?.type)
    || typeof payload?.data_base64 !== 'string'
  ) {
    return payload;
  }
  const raw = Buffer.from(payload.data_base64, 'base64');
  if (raw.length === 0) {
    return payload;
  }
  const compressed = gzipSync(raw, { level: 6 });
  if (compressed.length >= raw.length) {
    return payload;
  }
  return {
    ...payload,
    data_encoding: 'gzip-base64',
    data_base64: compressed.toString('base64'),
    data_uncompressed_bytes: raw.length
  };
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookieHeader(header) {
  const cookies = new Map();
  if (typeof header !== 'string' || header.trim() === '') {
    return cookies;
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const rawValue = part.slice(index + 1).trim();
    let value = rawValue;
    try {
      value = decodeURIComponent(rawValue);
    } catch {}
    if (key) {
      cookies.set(key, value);
    }
  }
  return cookies;
}

function authCookieHeader(authToken) {
  const token = asNonEmptyString(authToken);
  if (!token) {
    return null;
  }
  return [
    `mh_face_auth=${encodeURIComponent(token)}`,
    'Path=/',
    'Max-Age=15552000',
    'SameSite=Lax',
    'HttpOnly'
  ].join('; ');
}

function tokenFromAuthorizationHeader(header) {
  const value = asNonEmptyString(header);
  if (!value) {
    return null;
  }
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match ? asNonEmptyString(match[1]) : null;
}

function tokenFromRequest(request, parsedUrl) {
  const authHeader = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization;
  const bearer = tokenFromAuthorizationHeader(authHeader);
  if (bearer) {
    return bearer;
  }

  const queryToken = asNonEmptyString(parsedUrl.searchParams.get('auth_token'))
    ?? asNonEmptyString(parsedUrl.searchParams.get('token'));
  if (queryToken) {
    return queryToken;
  }

  const cookies = parseCookieHeader(request.headers.cookie);
  return asNonEmptyString(cookies.get('mh_face_auth'));
}

function tokenFromWebSocketProtocol(header) {
  if (typeof header !== 'string') {
    return null;
  }
  for (const item of header.split(',')) {
    const protocol = item.trim();
    if (protocol.startsWith('mh-face-auth-b64.')) {
      const encoded = protocol.slice('mh-face-auth-b64.'.length);
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
        continue;
      }
      try {
        const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
        if (decoded && Buffer.from(decoded, 'utf8').toString('base64url') === encoded) {
          return decoded;
        }
      } catch {}
      continue;
    }
    if (protocol.startsWith('mh-face-auth.')) {
      return asNonEmptyString(protocol.slice('mh-face-auth.'.length));
    }
  }
  return null;
}

function isAuthorizedRequest(request, parsedUrl, authToken) {
  const expected = asNonEmptyString(authToken);
  if (!expected) {
    return true;
  }
  const supplied = tokenFromRequest(request, parsedUrl)
    ?? tokenFromWebSocketProtocol(request.headers['sec-websocket-protocol']);
  if (!supplied) {
    return false;
  }
  return timingSafeStringEqual(supplied, expected);
}

function hasValidQueryToken(parsedUrl, authToken) {
  const expected = asNonEmptyString(authToken);
  if (!expected) {
    return false;
  }
  const supplied = asNonEmptyString(parsedUrl.searchParams.get('auth_token'))
    ?? asNonEmptyString(parsedUrl.searchParams.get('token'));
  return Boolean(supplied) && timingSafeStringEqual(supplied, expected);
}

function normalizeOrigin(value) {
  const origin = asNonEmptyString(value);
  if (!origin) {
    return null;
  }
  try {
    const parsed = new URL(origin);
    return parsed.origin;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname ?? '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function originMatchesHost(origin, hostHeader) {
  const normalizedOrigin = normalizeOrigin(origin);
  const host = asNonEmptyString(Array.isArray(hostHeader) ? hostHeader[0] : hostHeader);
  if (!normalizedOrigin || !host) {
    return false;
  }
  try {
    const parsed = new URL(normalizedOrigin);
    return parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function isAllowedOrigin(request, allowedOrigins) {
  const origin = normalizeOrigin(request.headers.origin);
  if (!origin) {
    return true;
  }
  if (originMatchesHost(origin, request.headers.host)) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    if (isLoopbackHostname(parsed.hostname)) {
      return true;
    }
  } catch {
    return false;
  }
  return allowedOrigins.has(origin);
}

function writeAuthError(response, statusCode, error, apiResponse) {
  if (apiResponse) {
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(JSON.stringify({ ok: false, error }));
    return;
  }

  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(`${error}\n`);
}

function encodeServerFrame(opcode, payload = Buffer.alloc(0)) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const payloadLength = payloadBuffer.length;

  if (payloadLength < 126) {
    const header = Buffer.from([0x80 | opcode, payloadLength]);
    return Buffer.concat([header, payloadBuffer]);
  }

  if (payloadLength <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
    return Buffer.concat([header, payloadBuffer]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payloadLength), 2);
  return Buffer.concat([header, payloadBuffer]);
}

function parseFrames(socket, state, chunk, onText, log) {
  state.buffer = Buffer.concat([state.buffer, chunk]);

  while (state.buffer.length >= 2) {
    const firstByte = state.buffer[0];
    const secondByte = state.buffer[1];
    const fin = (firstByte & 0x80) !== 0;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (state.buffer.length < 4) {
        return;
      }
      payloadLength = state.buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (state.buffer.length < 10) {
        return;
      }
      const rawLength = state.buffer.readBigUInt64BE(2);
      if (rawLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        log.error('[face-app] frame too large; closing connection');
        socket.end();
        return;
      }
      payloadLength = Number(rawLength);
      offset = 10;
    }

    const maskLength = masked ? 4 : 0;
    const totalLength = offset + maskLength + payloadLength;
    if (state.buffer.length < totalLength) {
      return;
    }

    let payload = state.buffer.subarray(offset + maskLength, totalLength);
    if (masked) {
      const maskKey = state.buffer.subarray(offset, offset + 4);
      const unmasked = Buffer.allocUnsafe(payloadLength);
      for (let index = 0; index < payloadLength; index += 1) {
        unmasked[index] = payload[index] ^ maskKey[index % 4];
      }
      payload = unmasked;
    }

    state.buffer = state.buffer.subarray(totalLength);

    if (!fin) {
      log.error('[face-app] fragmented frames are not supported in phase 2');
      continue;
    }

    if (opcode === 0x8) {
      socket.write(encodeServerFrame(0x8));
      socket.end();
      return;
    }

    if (opcode === 0x9) {
      socket.write(encodeServerFrame(0xA, payload));
      continue;
    }

    if (opcode === 0x1) {
      onText(payload.toString('utf8'));
    }
  }
}

function safeSocketWrite(socket, frame) {
  if (socket.destroyed || socket.writableEnded) {
    return false;
  }
  try {
    socket.write(frame);
    return true;
  } catch {
    socket.destroy();
    return false;
  }
}

async function serveStaticFile(
  request,
  response,
  staticDir,
  defaultDocument = 'index.html',
  documentRoutes = {}
) {
  if (!staticDir) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('WebSocket endpoint only\n');
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    pathname = '/';
  }

  const safeDefaultDocument =
    typeof defaultDocument === 'string'
    && /^[A-Za-z0-9._-]+$/u.test(defaultDocument)
      ? defaultDocument
      : 'index.html';
  const routedDocument = documentRoutes[pathname];
  const requestPath = typeof routedDocument === 'string' && routedDocument.trim() !== ''
    ? `/${routedDocument.replace(/^\/+/, '')}`
    : pathname === '/'
      ? `/${safeDefaultDocument}`
      : pathname;
  const vendorRelativePath = {
    '/vendor/three.module.js': '../../node_modules/three/build/three.module.js',
    '/vendor/xterm.mjs': '../../node_modules/@xterm/xterm/lib/xterm.mjs',
    '/vendor/xterm.css': '../../node_modules/@xterm/xterm/css/xterm.css'
  }[requestPath];
  if (vendorRelativePath) {
    const vendorPath = path.resolve(staticDir, vendorRelativePath);
    try {
      const content = await readFile(vendorPath);
      const extension = path.extname(vendorPath).toLowerCase();
      response.writeHead(200, {
        'content-type': MIME_TYPES.get(extension) ?? 'application/octet-stream',
        'cache-control': 'public, max-age=86400, must-revalidate'
      });
      response.end(content);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
    }
    return;
  }

  const normalized = path.normalize(requestPath);
  const rootPath = path.resolve(staticDir);
  const filePath = path.resolve(rootPath, `.${normalized}`);

  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${path.sep}`)) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Forbidden\n');
    return;
  }

  try {
    const content = await readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES.get(extension) ?? 'application/octet-stream';
    response.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'no-store'
    });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not Found\n');
      return;
    }

    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`Server Error: ${error.message}\n`);
  }
}

export async function startFaceWebSocketServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const configuredPort = Number.isInteger(options.port) ? options.port : Number(options.port ?? 8765);
  const port = Number.isNaN(configuredPort) ? 8765 : configuredPort;
  const wsPath = normalizePath(options.path ?? '/ws');
  const onPayload = typeof options.onPayload === 'function' ? options.onPayload : () => {};
  const onHttpRequest = typeof options.onHttpRequest === 'function' ? options.onHttpRequest : null;
  const onClientClose = typeof options.onClientClose === 'function' ? options.onClientClose : null;
  // Called once per broadcastPayload when a TTS audio payload is about to be
  // delivered to at least one Arduino/Atom socket. Used by the Atom VAD
  // bridge to reset any partial buffer from the prior turn before the device
  // plays out the new audio.
  const onAtomTtsDispatch = typeof options.onAtomTtsDispatch === 'function' ? options.onAtomTtsDispatch : null;
  const relayPayloads = options.relayPayloads ?? true;
  const staticDir = options.staticDir ?? null;
  const defaultDocument = options.defaultDocument ?? 'index.html';
  const documentRoutes = options.documentRoutes && typeof options.documentRoutes === 'object'
    ? options.documentRoutes
    : {};
  const authToken = asNonEmptyString(options.authToken);
  const requireOriginCheck = options.requireOriginCheck === true;
  const sendAudioToArduino = options.sendAudioToArduino === true;
  const terminalSocketHighWaterBytes = Number.isFinite(options.terminalSocketHighWaterBytes)
    ? Math.max(16 * 1024, Math.min(8 * 1024 * 1024, Math.floor(options.terminalSocketHighWaterBytes)))
    : 256 * 1024;
  const allowedOrigins = new Set(
    (Array.isArray(options.allowedOrigins) ? options.allowedOrigins : [])
      .map((origin) => normalizeOrigin(origin))
      .filter(Boolean)
  );
  const log = toLogger(options.log ?? console);

  const sockets = new Set();
  const replayablePayloads = new Map();
  const operatorBridgesBySession = new Map();
  const activeOperatorBridgeBySession = new Map();
  let nextTerminalSubscriberId = 1;

  function websocketProtocolSet(header) {
    const values = Array.isArray(header) ? header : [header];
    return new Set(
      values
        .filter((value) => typeof value === "string")
        .flatMap((value) => value.split(","))
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  function isArduinoUpgrade(request) {
    return websocketProtocolSet(request.headers["sec-websocket-protocol"]).has("arduino");
  }

  function isAudioFocusUpgrade(request) {
    return websocketProtocolSet(request.headers["sec-websocket-protocol"]).has("mh-audio-focus-v1");
  }

  function isAtomBridgeUpgrade(request) {
    return websocketProtocolSet(request.headers["sec-websocket-protocol"]).has("mh-atom-http-bridge-v1");
  }

  function isOperatorBridgeUpgrade(request) {
    return websocketProtocolSet(request.headers['sec-websocket-protocol']).has(OPERATOR_BRIDGE_PROTOCOL);
  }

  function isArduinoSocket(socket) {
    return socket && socket.__mhArduinoClient === true;
  }

  function isAudioFocusSocket(socket) {
    return socket && socket.__mhAudioFocusObserver === true;
  }

  function isOperatorBridgeSocket(socket) {
    return socket && socket.__mhOperatorBridge === true;
  }

  function isTerminalBrowserSocket(socket) {
    return Boolean(
      socket
      && !isOperatorBridgeSocket(socket)
      && !isAudioFocusSocket(socket)
      && !isAtomSocket(socket)
    );
  }

  function isAtomSocket(socket) {
    return Boolean(
      socket
      && (
        socket.__mhAtomClient === true
        || socket.__mhAtomBridgeClient === true
        || socket.__mhArduinoClient === true
      )
    );
  }

  function isDirectAtomSocket(socket) {
    return Boolean(
      socket
      && socket.__mhAtomBridgeClient !== true
      && (socket.__mhAtomClient === true || socket.__mhArduinoClient === true)
    );
  }

  function isPreferredAtomAudioSocket(socket) {
    const directConnected = [...sockets].some((peer) => isDirectAtomSocket(peer));
    return directConnected
      ? isDirectAtomSocket(socket)
      : socket?.__mhAtomBridgeClient === true;
  }

  function isPreferredAtomReferenceSocket(socket) {
    // A tts_audio_ref is an authenticated HTTP URL. The supervised HTTP
    // bridge can fetch that URL and POST the resulting binary WAV to Atom;
    // direct firmware WebSockets only understand inline audio payloads.
    // Prefer the bridge for references when both transports are connected,
    // while retaining the direct socket as the no-bridge fallback.
    const bridgeConnected = [...sockets].some(
      (peer) => peer?.__mhAtomBridgeClient === true
    );
    return bridgeConnected
      ? socket?.__mhAtomBridgeClient === true
      : isDirectAtomSocket(socket);
  }

  function shouldSendPayloadToSocket(socket, payload) {
    if (payload?.type === 'operator_response') {
      const sessionId = asNonEmptyString(payload.session_id) ?? 'default';
      return isOperatorBridgeSocket(socket)
        && activeOperatorBridgeBySession.get(sessionId) === socket;
    }
    if (TERMINAL_STREAM_MESSAGE_TYPES.has(payload?.type)) {
      const subscription = socket?.__mhTerminalSubscription;
      if (!isTerminalBrowserSocket(socket) || !subscription) {
        return false;
      }
      const payloadSessionId = asNonEmptyString(payload.session_id) ?? 'default';
      if (subscription.sessionId !== payloadSessionId) {
        return false;
      }
      const targetSubscriberId = asNonEmptyString(payload.subscriber_id);
      if (targetSubscriberId && targetSubscriberId !== socket.__mhTerminalSubscriberId) {
        return false;
      }
      // Whether a latched socket may receive this data frame is decided by
      // planTerminalDataDelivery in broadcastPayload, which can also turn the
      // latch back off; this function only answers "is this frame for you".
      return true;
    }
    if (TERMINAL_CLIENT_MESSAGE_TYPES.has(payload?.type)) {
      return isOperatorBridgeSocket(socket);
    }
    if (isAudioFocusSocket(socket)) {
      return payload?.type === 'audio_focus';
    }
    if (payload?.type === 'tts_audio' || payload?.type === 'tts_audio_ref') {
      if (payload.audio_endpoint === 'atom') {
        return payload.type === 'tts_audio_ref'
          ? isPreferredAtomReferenceSocket(socket)
          : isPreferredAtomAudioSocket(socket);
      }
      if (payload.audio_endpoint === 'browser') {
        return !isAtomSocket(socket);
      }
    }
    if (!isArduinoSocket(socket)) {
      return true;
    }
    switch (payload?.type) {
      case "operator_state":
      case "operator_terminal_snapshot":
      case "operator_prompt":
      case "operator_ack":
      case "media_state":
      case "audio_focus":
        return false;
      case "tts_audio":
      case "tts_audio_ref":
        return sendAudioToArduino;
      default:
        return true;
    }
  }

  function replayCacheKey(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const sessionId =
      typeof payload.session_id === 'string' && payload.session_id.trim() !== ''
        ? payload.session_id.trim()
        : '-';

    switch (payload.type) {
      case 'operator_state':
      case 'operator_terminal_snapshot':
      case 'operator_prompt':
      case 'operator_ack':
      case 'tts_state':
        return `${payload.type}:${sessionId}`;
      case 'media_state':
      case 'audio_focus':
        return payload.type;
      default:
        return null;
    }
  }

  function rememberReplayablePayload(payload) {
    const key = replayCacheKey(payload);
    if (!key) {
      return;
    }
    replayablePayloads.set(key, payload);
  }

  function sendPayloadToSocket(socket, payload) {
    try {
      return safeSocketWrite(socket, encodeServerFrame(0x1, JSON.stringify(payload)));
    } catch {
      return false;
    }
  }

  function operatorBridgeSessionId(socket) {
    return asNonEmptyString(socket?.__mhOperatorBridgeSessionId) ?? 'default';
  }

  function sendToOperatorBridges(payload) {
    const sessionId = asNonEmptyString(payload?.session_id) ?? 'default';
    const activeBridge = activeOperatorBridgeBySession.get(sessionId);
    if (!activeBridge || !sockets.has(activeBridge)) {
      return false;
    }
    return sendPayloadToSocket(activeBridge, payload);
  }

  function terminalControlPayload(socket, payload, subscription = socket.__mhTerminalSubscription) {
    return {
      ...payload,
      v: 1,
      session_id: subscription?.sessionId ?? asNonEmptyString(payload?.session_id) ?? 'default',
      subscriber_id: socket.__mhTerminalSubscriberId,
      ts: Number.isFinite(payload?.ts) ? payload.ts : Date.now()
    };
  }

  function handleTerminalClientPayload(socket, payload) {
    if (!TERMINAL_CLIENT_MESSAGE_TYPES.has(payload?.type) || !isTerminalBrowserSocket(socket)) {
      return false;
    }
    if (payload.type === 'operator_terminal_subscribe') {
      const sessionId = asNonEmptyString(payload.session_id) ?? 'default';
      const requestedEncodings = Array.isArray(payload.data_encodings)
        ? payload.data_encodings.map((value) => asNonEmptyString(value)).filter(Boolean)
        : [];
      const dataEncoding = requestedEncodings.includes('gzip-base64') ? 'gzip-base64' : 'base64';
      const previous = socket.__mhTerminalSubscription;
      if (previous && previous.sessionId !== sessionId) {
        sendToOperatorBridges(terminalControlPayload(socket, {
          type: 'operator_terminal_unsubscribe'
        }, previous));
      }
      socket.__mhTerminalSubscription = { sessionId, dataEncoding };
      socket.__mhTerminalNeedsReset = false;
      socket.__mhTerminalResyncRequestedAt = 0;
      sendToOperatorBridges(terminalControlPayload(socket, payload));
      return true;
    }
    const subscription = socket.__mhTerminalSubscription;
    if (!subscription) {
      return true;
    }
    if (payload.type === 'operator_terminal_unsubscribe') {
      sendToOperatorBridges(terminalControlPayload(socket, payload, subscription));
      socket.__mhTerminalSubscription = null;
      socket.__mhTerminalNeedsReset = false;
      return true;
    }
    const outgoing = terminalControlPayload(socket, payload, subscription);
    if (socket.__mhTerminalNeedsReset === true) {
      outgoing.needs_reset = true;
      socket.__mhTerminalNeedsReset = false;
    }
    sendToOperatorBridges(outgoing);
    return true;
  }

  // Asks the operator bridge for a fresh full-screen reset on this socket's
  // behalf. Rate limited because the trigger is "a terminal data frame arrived",
  // which on a busy pane happens twice a second.
  function requestTerminalResync(socket, reason) {
    if (!sockets.has(socket) || !socket.__mhTerminalSubscription) {
      return false;
    }
    const now = Date.now();
    const lastRequestedAt = Number(socket.__mhTerminalResyncRequestedAt ?? 0);
    if (Number.isFinite(lastRequestedAt) && now - lastRequestedAt < TERMINAL_RESYNC_RETRY_MS) {
      return false;
    }
    socket.__mhTerminalResyncRequestedAt = now;
    return sendToOperatorBridges(terminalControlPayload(socket, {
      type: 'operator_terminal_resync',
      reason
    }));
  }

  function replayTerminalSubscriptionsToBridge(bridgeSocket) {
    const bridgeSessionId = operatorBridgeSessionId(bridgeSocket);
    for (const peer of sockets) {
      if (
        !isTerminalBrowserSocket(peer)
        || !peer.__mhTerminalSubscription
        || peer.__mhTerminalSubscription.sessionId !== bridgeSessionId
      ) {
        continue;
      }
      sendPayloadToSocket(bridgeSocket, terminalControlPayload(peer, {
        type: 'operator_terminal_subscribe'
      }));
    }
  }

  function unsubscribeTerminalSubscriptionsFromBridge(bridgeSocket) {
    const bridgeSessionId = operatorBridgeSessionId(bridgeSocket);
    for (const peer of sockets) {
      if (
        !isTerminalBrowserSocket(peer)
        || !peer.__mhTerminalSubscription
        || peer.__mhTerminalSubscription.sessionId !== bridgeSessionId
      ) {
        continue;
      }
      sendPayloadToSocket(bridgeSocket, terminalControlPayload(peer, {
        type: 'operator_terminal_unsubscribe'
      }));
    }
  }

  function activateOperatorBridge(bridgeSocket) {
    if (!bridgeSocket || !sockets.has(bridgeSocket) || !isOperatorBridgeSocket(bridgeSocket)) {
      return false;
    }
    const sessionId = operatorBridgeSessionId(bridgeSocket);
    const previous = activeOperatorBridgeBySession.get(sessionId);
    if (previous === bridgeSocket) {
      return true;
    }
    if (previous && sockets.has(previous)) {
      unsubscribeTerminalSubscriptionsFromBridge(previous);
    }
    activeOperatorBridgeBySession.set(sessionId, bridgeSocket);
    replayTerminalSubscriptionsToBridge(bridgeSocket);
    return true;
  }

  function registerOperatorBridge(bridgeSocket, sessionId) {
    const normalizedSessionId = asNonEmptyString(sessionId) ?? 'default';
    bridgeSocket.__mhOperatorBridgeSessionId = normalizedSessionId;
    const candidates = operatorBridgesBySession.get(normalizedSessionId) ?? new Set();
    candidates.add(bridgeSocket);
    operatorBridgesBySession.set(normalizedSessionId, candidates);
    activateOperatorBridge(bridgeSocket);
  }

  function unregisterOperatorBridge(bridgeSocket) {
    const sessionId = operatorBridgeSessionId(bridgeSocket);
    const candidates = operatorBridgesBySession.get(sessionId);
    candidates?.delete(bridgeSocket);
    if (candidates?.size === 0) {
      operatorBridgesBySession.delete(sessionId);
    }
    if (activeOperatorBridgeBySession.get(sessionId) !== bridgeSocket) {
      return;
    }
    activeOperatorBridgeBySession.delete(sessionId);
    const standby = candidates
      ? [...candidates].reverse().find((candidate) => sockets.has(candidate))
      : null;
    if (standby) {
      activateOperatorBridge(standby);
    }
  }

  function isActiveOperatorBridgePayload(socket, payload) {
    if (!isOperatorBridgeSocket(socket)) {
      return true;
    }
    const sessionId = asNonEmptyString(payload?.session_id) ?? operatorBridgeSessionId(socket);
    return sessionId === operatorBridgeSessionId(socket)
      && activeOperatorBridgeBySession.get(sessionId) === socket;
  }

  function replayCachedPayloads(socket) {
    for (const payload of replayablePayloads.values()) {
      if (shouldSendPayloadToSocket(socket, payload)) {
        sendPayloadToSocket(socket, payload);
      }
    }
  }

  function broadcastText(text, excludeSocket = null) {
    const frame = encodeServerFrame(0x1, text);
    for (const peer of sockets) {
      if (excludeSocket && peer === excludeSocket) {
        continue;
      }
      if (isAudioFocusSocket(peer)) {
        continue;
      }
      safeSocketWrite(peer, frame);
    }
  }

  function broadcastPayload(payload, excludeSocket = null) {
    try {
      rememberReplayablePayload(payload);
      const plainFrame = encodeServerFrame(0x1, JSON.stringify(payload));
      let gzipPayload = null;
      let gzipFrame = null;
      for (const peer of sockets) {
        if (excludeSocket && peer === excludeSocket) {
          continue;
        }
        if (!shouldSendPayloadToSocket(peer, payload)) {
          continue;
        }
        if (payload?.type === 'operator_terminal_data') {
          const decision = planTerminalDataDelivery(peer, terminalSocketHighWaterBytes);
          if (decision === 'latch') {
            peer.__mhTerminalNeedsReset = true;
            armTerminalResetAfterDrain(peer, () => requestTerminalResync(peer, 'socket_backpressure'));
            continue;
          }
          if (decision === 'resync') {
            requestTerminalResync(peer, 'socket_backpressure_drained');
            continue;
          }
          if (decision === 'suppress') {
            continue;
          }
        }
        let frame = plainFrame;
        if (
          peer.__mhTerminalSubscription?.dataEncoding === 'gzip-base64'
          && TERMINAL_STREAM_MESSAGE_TYPES.has(payload?.type)
          && typeof payload?.data_base64 === 'string'
        ) {
          if (gzipPayload === null) {
            gzipPayload = encodeTerminalPayloadForSubscription(payload, peer.__mhTerminalSubscription);
            gzipFrame = gzipPayload === payload
              ? plainFrame
              : encodeServerFrame(0x1, JSON.stringify(gzipPayload));
          }
          frame = gzipFrame;
        }
        const sent = safeSocketWrite(peer, frame);
        if (sent && payload?.type === 'operator_terminal_reset') {
          peer.__mhTerminalNeedsReset = false;
          peer.__mhTerminalResyncRequestedAt = 0;
        }
      }
      // Fire the Atom TTS dispatch hook on every tts_audio / tts_audio_ref
      // broadcast, regardless of which sockets received it. face-app does not
      // know the downstream Atom topology (could be a direct Arduino WS
      // client OR the separate atoms3r-http-bridge process, which is a plain
      // WS subscriber that re-posts audio to the Atom over HTTP), so gating
      // on the Arduino subprotocol would miss the HTTP-bridge path entirely.
      // The bridge buffers are empty when the device is not streaming mic
      // frames, so resetSession is a harmless no-op in that case.
      if (
        onAtomTtsDispatch &&
        payload &&
        (payload.type === 'tts_audio' || payload.type === 'tts_audio_ref') &&
        payload.audio_endpoint !== 'browser'
      ) {
        try {
          onAtomTtsDispatch(payload);
        } catch (error) {
          // Hook failure must never break broadcast.
          log.warn?.(`onAtomTtsDispatch failed: ${error?.message ?? error}`);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  const server = http.createServer(async (request, response) => {
    let parsedUrl = null;
    try {
      parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      parsedUrl = new URL('/', 'http://127.0.0.1');
    }
    const isApiRequest = parsedUrl.pathname.startsWith('/api/');
    const cookieHeader = hasValidQueryToken(parsedUrl, authToken) ? authCookieHeader(authToken) : null;
    if (cookieHeader) {
      response.setHeader('set-cookie', cookieHeader);
    }

    if (isApiRequest && requireOriginCheck && !isAllowedOrigin(request, allowedOrigins)) {
      writeAuthError(response, 403, 'origin_not_allowed', isApiRequest);
      return;
    }

    if (isApiRequest && !isAuthorizedRequest(request, parsedUrl, authToken)) {
      writeAuthError(response, 401, 'unauthorized', isApiRequest);
      return;
    }

    if (onHttpRequest) {
      try {
        const handled = await onHttpRequest(request, response);
        if (handled || response.writableEnded) {
          return;
        }
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`Server Error: ${error.message}\n`);
        return;
      }
    }

    await serveStaticFile(request, response, staticDir, defaultDocument, documentRoutes);
  });

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    const parsedUrl = (() => {
      try {
        return new URL(request.url ?? '/', 'http://localhost');
      } catch {
        return new URL('/', 'http://localhost');
      }
    })();
    const incomingPath = parsedUrl.pathname;

    if (incomingPath !== wsPath) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    if (requireOriginCheck && !isAllowedOrigin(request, allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!isAuthorizedRequest(request, parsedUrl, authToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const acceptValue = websocketAcceptValue(key);
    const arduinoClient = isArduinoUpgrade(request);
    const audioFocusObserver = isAudioFocusUpgrade(request);
    const atomBridgeClient = isAtomBridgeUpgrade(request);
    const operatorBridgeClient = isOperatorBridgeUpgrade(request);
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptValue}`
    ];
    if (audioFocusObserver) {
      responseHeaders.push('Sec-WebSocket-Protocol: mh-audio-focus-v1');
    } else if (atomBridgeClient) {
      responseHeaders.push('Sec-WebSocket-Protocol: mh-atom-http-bridge-v1');
    } else if (arduinoClient) {
      responseHeaders.push('Sec-WebSocket-Protocol: arduino');
    } else if (operatorBridgeClient) {
      responseHeaders.push(`Sec-WebSocket-Protocol: ${OPERATOR_BRIDGE_PROTOCOL}`);
    }
    responseHeaders.push('\r\n');
    socket.write(responseHeaders.join('\r\n'));

    socket.__mhArduinoClient = arduinoClient;
    socket.__mhAudioFocusObserver = audioFocusObserver;
    socket.__mhAtomBridgeClient = atomBridgeClient;
    socket.__mhOperatorBridge = operatorBridgeClient;
    socket.__mhOperatorBridgeSessionId = operatorBridgeClient
      ? (asNonEmptyString(parsedUrl.searchParams.get('operator_session_id')) ?? 'default')
      : null;
    socket.__mhTerminalSubscriberId = `terminal-${nextTerminalSubscriberId}`;
    nextTerminalSubscriberId += 1;
    socket.__mhTerminalSubscription = null;
    socket.__mhTerminalNeedsReset = false;
    socket.__mhTerminalResetOnDrain = false;
    socket.__mhTerminalResyncRequestedAt = 0;
    sockets.add(socket);
    replayCachedPayloads(socket);
    if (operatorBridgeClient) {
      registerOperatorBridge(socket, socket.__mhOperatorBridgeSessionId);
    }
    const state = { buffer: Buffer.alloc(0) };

    socket.on('data', (chunk) => {
      parseFrames(
        socket,
        state,
        chunk,
        (text) => {
          if (isAudioFocusSocket(socket)) {
            return;
          }
          try {
            const payload = JSON.parse(text);
            if (!isActiveOperatorBridgePayload(socket, payload)) {
              return;
            }
            const receivedLogMessage = receivedPayloadLogMessage(payload);
            if (receivedLogMessage !== null) {
              log.info(`[face-app] received ${receivedLogMessage}`);
            }
            if (payload?.type === 'atom_audio_frame') {
              socket.__mhAtomClient = true;
            }
            if (handleTerminalClientPayload(socket, payload)) {
              onPayload(payload, {
                socket,
                isArduino: false,
                isAtom: false,
                isAtomBridge: false,
                isOperatorBridge: false
              });
              return;
            }
            const payloadDirective = onPayload(payload, {
              socket,
              isArduino: isArduinoSocket(socket),
              isAtom: isAtomSocket(socket),
              isAtomBridge: socket.__mhAtomBridgeClient === true,
              isOperatorBridge: isOperatorBridgeSocket(socket)
            });
            const allowRelay =
              payload?.type !== 'atom_endpoint_state'
              && (
                !payloadDirective
                || typeof payloadDirective !== 'object'
                || payloadDirective.relay !== false
              );

            if (relayPayloads && allowRelay) {
              broadcastPayload(payload, socket);
            }
          } catch (error) {
            log.error(`[face-app] invalid JSON payload: ${error.message}`);
          }
        },
        log
      );
    });

    socket.on('error', (error) => {
      log.error(`[face-app] socket error: ${error.message}`);
    });

    socket.on('close', () => {
      if (socket.__mhTerminalSubscription) {
        sendToOperatorBridges(terminalControlPayload(socket, {
          type: 'operator_terminal_unsubscribe'
        }));
      }
      sockets.delete(socket);
      if (isOperatorBridgeSocket(socket)) {
        unregisterOperatorBridge(socket);
      }
      if (onClientClose) {
        try {
          onClientClose({
            socket,
            isArduino: isArduinoSocket(socket),
            isAtom: isAtomSocket(socket),
            isAtomBridge: socket.__mhAtomBridgeClient === true,
            isOperatorBridge: isOperatorBridgeSocket(socket)
          });
        } catch (error) {
          log.warn?.(`[face-app] client close callback failed: ${error.message}`);
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const activePort = typeof address === 'object' && address ? address.port : port;
  const url = `ws://${host}:${activePort}${wsPath}`;
  const httpUrl = `http://${host}:${activePort}/`;

  log.info(`[face-app] listening ${url}`);
  if (staticDir) {
    log.info(`[face-app] http ui ${httpUrl}`);
  }

  return {
    host,
    path: wsPath,
    port: activePort,
    url,
    httpUrl,
    broadcast(payload) {
      return broadcastPayload(payload, null);
    },
    sendToSocket(socket, payload) {
      if (!sockets.has(socket)) {
        return false;
      }
      return sendPayloadToSocket(socket, payload);
    },
    async stop() {
      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}
