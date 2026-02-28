import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

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
  const relayPayloads = options.relayPayloads ?? true;
  const staticDir = options.staticDir ?? null;
  const log = toLogger(options.log ?? console);

  const sockets = new Set();
  const replayablePayloads = new Map();

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
      sendPayloadToSocket(socket, payload);
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
      const text = JSON.stringify(payload);
      broadcastText(text, excludeSocket);
      return true;
    } catch {
      return false;
    }
  }

  const server = http.createServer(async (request, response) => {
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
    const incomingPath = (() => {
      try {
        return new URL(request.url ?? '/', 'http://localhost').pathname;
      } catch {
        return '/';
      }
    })();

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

    const acceptValue = websocketAcceptValue(key);
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptValue}`,
        '\r\n'
      ].join('\r\n')
    );

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
            onPayload(payload);

            if (relayPayloads) {
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
