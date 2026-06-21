import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
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
    return;
  }
  try {
    socket.write(frame);
  } catch {
    socket.destroy();
  }
}

async function serveStaticFile(request, response, staticDir) {
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

  const requestPath = pathname === '/' ? '/index.html' : pathname;
  if (requestPath === '/vendor/three.module.js') {
    const vendorPath = path.resolve(staticDir, '../../node_modules/three/build/three.module.js');
    try {
      const content = await readFile(vendorPath);
      response.writeHead(200, {
        'content-type': MIME_TYPES.get('.js'),
        'cache-control': 'no-store'
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
  // Called once per broadcastPayload when a TTS audio payload is about to be
  // delivered to at least one Arduino/Atom socket. Used by the Atom VAD
  // bridge to reset any partial buffer from the prior turn before the device
  // plays out the new audio.
  const onAtomTtsDispatch = typeof options.onAtomTtsDispatch === 'function' ? options.onAtomTtsDispatch : null;
  const relayPayloads = options.relayPayloads ?? true;
  const staticDir = options.staticDir ?? null;
  const authToken = asNonEmptyString(options.authToken);
  const requireOriginCheck = options.requireOriginCheck === true;
  const sendAudioToArduino = options.sendAudioToArduino === true;
  const allowedOrigins = new Set(
    (Array.isArray(options.allowedOrigins) ? options.allowedOrigins : [])
      .map((origin) => normalizeOrigin(origin))
      .filter(Boolean)
  );
  const log = toLogger(options.log ?? console);

  const sockets = new Set();
  const replayablePayloads = new Map();

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

  function isArduinoSocket(socket) {
    return socket && socket.__mhArduinoClient === true;
  }

  function shouldSendPayloadToSocket(socket, payload) {
    if (!isArduinoSocket(socket)) {
      return true;
    }
    switch (payload?.type) {
      case "operator_state":
      case "operator_terminal_snapshot":
      case "operator_prompt":
      case "operator_ack":
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
      safeSocketWrite(socket, encodeServerFrame(0x1, JSON.stringify(payload)));
      return true;
    } catch {
      return false;
    }
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
      safeSocketWrite(peer, frame);
    }
  }

  function broadcastPayload(payload, excludeSocket = null) {
    try {
      rememberReplayablePayload(payload);
      const frame = encodeServerFrame(0x1, JSON.stringify(payload));
      for (const peer of sockets) {
        if (excludeSocket && peer === excludeSocket) {
          continue;
        }
        if (!shouldSendPayloadToSocket(peer, payload)) {
          continue;
        }
        safeSocketWrite(peer, frame);
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
        (payload.type === 'tts_audio' || payload.type === 'tts_audio_ref')
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

    await serveStaticFile(request, response, staticDir);
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
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptValue}`
    ];
    if (arduinoClient) {
      responseHeaders.push('Sec-WebSocket-Protocol: arduino');
    }
    responseHeaders.push('\r\n');
    socket.write(responseHeaders.join('\r\n'));

    socket.__mhArduinoClient = arduinoClient;
    sockets.add(socket);
    replayCachedPayloads(socket);
    const state = { buffer: Buffer.alloc(0) };

    socket.on('data', (chunk) => {
      parseFrames(
        socket,
        state,
        chunk,
        (text) => {
          try {
            const payload = JSON.parse(text);
            log.info(`[face-app] received ${JSON.stringify(payload)}`);
            const payloadDirective = onPayload(payload);
            const allowRelay =
              !payloadDirective ||
              typeof payloadDirective !== 'object' ||
              payloadDirective.relay !== false;

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
      sockets.delete(socket);
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
