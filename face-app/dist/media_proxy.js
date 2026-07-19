import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MEDIA_MIME_TYPE, MEDIA_NOMINAL_BITRATE } from './media_controller.js';

function writeError(response, statusCode, code) {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify({ ok: false, error: code }));
}

function normalizedMediaType(value) {
  return String(value ?? '').split(';', 1)[0].trim().toLowerCase();
}

export function createMediaProxy(options = {}) {
  const controller = options.controller;
  if (!controller || typeof controller.resolve !== 'function') {
    throw new TypeError('Media proxy requires a controller.');
  }
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch;
  const log = options.log ?? console;

  async function handle(request, response, token) {
    const registration = controller.resolve(token);
    if (!registration) {
      writeError(response, 404, 'stream_not_found');
      return true;
    }
    if (request.method === 'HEAD') {
      response.writeHead(200, {
        'content-type': MEDIA_MIME_TYPE,
        'x-media-nominal-bitrate': String(MEDIA_NOMINAL_BITRATE),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end();
      return true;
    }
    if (request.method !== 'GET') {
      writeError(response, 405, 'method_not_allowed');
      return true;
    }
    if (request.headers.range) {
      writeError(response, 416, 'range_not_supported');
      return true;
    }

    const abortController = new AbortController();
    const detach = controller.attachAbortController(token, abortController);
    const abort = () => abortController.abort();
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      const upstream = await fetchImpl(registration.upstream, {
        method: 'GET',
        redirect: 'manual',
        signal: abortController.signal,
        headers: {
          accept: MEDIA_MIME_TYPE,
        },
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel?.();
        controller.fail(token, 'upstream_redirect', 'The media upstream redirected.');
        writeError(response, 502, 'upstream_redirect');
        return true;
      }
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel?.();
        controller.fail(token, 'upstream_status', 'The media upstream was unavailable.');
        writeError(response, 502, 'upstream_status');
        return true;
      }
      if (normalizedMediaType(upstream.headers.get('content-type')) !== MEDIA_MIME_TYPE) {
        await upstream.body.cancel?.();
        controller.fail(token, 'invalid_media_type', 'The media upstream did not return MP3.');
        writeError(response, 502, 'invalid_media_type');
        return true;
      }
      if (String(upstream.headers.get('x-media-nominal-bitrate') ?? '').trim() !== String(MEDIA_NOMINAL_BITRATE)) {
        await upstream.body.cancel?.();
        controller.fail(token, 'invalid_nominal_bitrate', 'The media upstream bitrate policy did not match.');
        writeError(response, 502, 'invalid_nominal_bitrate');
        return true;
      }

      response.writeHead(200, {
        'content-type': MEDIA_MIME_TYPE,
        'x-media-nominal-bitrate': String(MEDIA_NOMINAL_BITRATE),
        'cache-control': 'no-store, no-transform',
        'x-content-type-options': 'nosniff',
      });
      await pipeline(Readable.fromWeb(upstream.body), response);
      return true;
    } catch (error) {
      if (error?.name !== 'AbortError') {
        log.warn?.('[face-app] media proxy failed for media_id=' + registration.mediaId + ': ' + error.message);
        controller.fail(token, 'upstream_error', 'The media upstream failed.');
        writeError(response, 502, 'upstream_error');
      }
      return true;
    } finally {
      request.off('aborted', abort);
      response.off('close', abort);
      detach();
    }
  }

  return { handle };
}
