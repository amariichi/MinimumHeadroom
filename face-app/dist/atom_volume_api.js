const MAX_VOLUME_BODY_BYTES = 1_024;
const MAX_ATOM_SPEAKER_VOLUME = 200;

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function contentTypeIsJson(value) {
  if (typeof value !== 'string') return false;
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

async function readRequestBody(request, maxBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      const error = new Error('payload_too_large');
      error.code = 'payload_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function publicVolumeError(error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const code = asNonEmptyString(error?.code) ?? 'atom_volume_failed';
  return {
    statusCode,
    payload: { ok: false, error: code }
  };
}

export function createAtomVolumeApi(options = {}) {
  const registry = options.registry;
  const setVolume = typeof options.setVolume === 'function' ? options.setVolume : null;
  const log = options.log ?? console;

  if (!registry || typeof registry.getPresence !== 'function') {
    throw new TypeError('Atom volume API requires an endpoint registry');
  }

  async function handleGet(request, response) {
    if (request.method !== 'GET') {
      writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    const presence = registry.getPresence();
    writeJson(response, 200, {
      ok: true,
      connected: presence.connected === true,
      endpoint: presence.endpoint ?? 'browser',
      devices: Array.isArray(presence.devices) ? presence.devices : []
    });
  }

  async function handleSet(request, response) {
    if (request.method !== 'POST') {
      writeJson(response, 405, { ok: false, error: 'method_not_allowed' });
      return;
    }
    if (!contentTypeIsJson(request.headers['content-type'])) {
      writeJson(response, 415, {
        ok: false,
        error: 'unsupported_media_type',
        supported: ['application/json']
      });
      return;
    }
    if (!setVolume) {
      writeJson(response, 503, { ok: false, error: 'atom_volume_unavailable' });
      return;
    }

    let body;
    try {
      const raw = await readRequestBody(request, MAX_VOLUME_BODY_BYTES);
      body = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      writeJson(
        response,
        error?.code === 'payload_too_large' ? 413 : 400,
        {
          ok: false,
          error: error?.code === 'payload_too_large'
            ? 'payload_too_large'
            : 'invalid_json'
        }
      );
      return;
    }

    const keys = body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body).sort()
      : [];
    const deviceId = asNonEmptyString(body?.deviceId);
    if (
      keys.length !== 2
      || keys[0] !== 'deviceId'
      || keys[1] !== 'volume'
      || !deviceId
      || !Number.isInteger(body.volume)
      || body.volume < 0
      || body.volume > MAX_ATOM_SPEAKER_VOLUME
    ) {
      writeJson(response, 400, { ok: false, error: 'invalid_atom_volume_request' });
      return;
    }

    try {
      const result = await setVolume({
        deviceId,
        volume: body.volume
      });
      writeJson(response, 200, result);
    } catch (error) {
      log.warn?.(`[atom-volume] set failed: ${error.message}`);
      const failure = publicVolumeError(error);
      writeJson(response, failure.statusCode, failure.payload);
    }
  }

  return {
    async handleHttpRequest(request, response) {
      let pathname;
      try {
        pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      } catch {
        return false;
      }
      if (pathname !== '/api/atom/volume') {
        return false;
      }
      if (request.method === 'GET') {
        await handleGet(request, response);
      } else {
        await handleSet(request, response);
      }
      return true;
    }
  };
}

export const ATOM_VOLUME_API_MAX = MAX_ATOM_SPEAKER_VOLUME;
