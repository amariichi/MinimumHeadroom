function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request, maxBytes = 32_768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('request_body_too_large');
      error.code = 'request_body_too_large';
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    const error = new Error('invalid_json');
    error.code = 'invalid_json';
    error.statusCode = 400;
    throw error;
  }
}

export function createMediaApi({ controller, proxy } = {}) {
  if (!controller || !proxy) throw new TypeError('Media API requires controller and proxy.');

  async function handleHttpRequest(request, response) {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/api/media/status') {
      if (request.method !== 'GET') {
        writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
      } else {
        writeJson(response, 200, controller.status());
      }
      return true;
    }
    if (url.pathname === '/api/media/play') {
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
        return true;
      }
      try {
        writeJson(response, 200, controller.play(await readJson(request)));
      } catch (error) {
        writeJson(response, error.statusCode ?? 400, {
          ok: false,
          error: error.code ?? 'invalid_request',
          message: error.message,
        });
      }
      return true;
    }
    if (url.pathname === '/api/media/stop') {
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
      } else {
        writeJson(response, 200, controller.stop('requested'));
      }
      return true;
    }
    if (url.pathname.startsWith('/api/media/stream/')) {
      const encoded = url.pathname.slice('/api/media/stream/'.length);
      if (!encoded || encoded.includes('/')) {
        writeJson(response, 404, { ok: false, error: 'stream_not_found' });
        return true;
      }
      let token;
      try {
        token = decodeURIComponent(encoded);
      } catch {
        writeJson(response, 400, { ok: false, error: 'invalid_stream_token' });
        return true;
      }
      return proxy.handle(request, response, token);
    }
    return false;
  }

  return { handleHttpRequest };
}
