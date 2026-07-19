import { randomBytes } from 'node:crypto';

export const MEDIA_MIME_TYPE = 'audio/mpeg';
export const MEDIA_NOMINAL_BITRATE = 128000;

export class MediaControllerError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'MediaControllerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function optionalText(value, field, maxLength) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new MediaControllerError('invalid_' + field, field + ' must be a string.');
  }
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new MediaControllerError(field + '_too_long', field + ' is too long.');
  }
  return text;
}

function requiredText(value, field, maxLength) {
  const text = optionalText(value, field, maxLength);
  if (!text) throw new MediaControllerError('missing_' + field, field + ' is required.');
  return text;
}

function endpointIdentity(url) {
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  return {
    protocol: url.protocol,
    hostname: url.hostname.toLowerCase(),
    port: url.port || defaultPort,
    pathname: url.pathname,
  };
}

function sameEndpoint(left, right) {
  const a = endpointIdentity(left);
  const b = endpointIdentity(right);
  return a.protocol === b.protocol
    && a.hostname === b.hostname
    && a.port === b.port
    && a.pathname === b.pathname;
}

export function parseMediaAllowedEndpoints(value, { log = console } = {}) {
  const endpoints = [];
  const seen = new Set();
  for (const raw of String(value ?? '').split(',')) {
    const item = raw.trim();
    if (!item) continue;
    try {
      const url = new URL(item);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
      if (url.username || url.password || url.hash || url.search) throw new Error('credentials, fragments, and queries are forbidden');
      const identity = endpointIdentity(url);
      const key = JSON.stringify(identity);
      if (!seen.has(key)) {
        seen.add(key);
        endpoints.push(url);
      }
    } catch (error) {
      log.warn?.('[face-app] ignoring invalid MH_MEDIA_ALLOWED_ENDPOINTS item: ' + item + ' (' + error.message + ')');
    }
  }
  return endpoints;
}

function immutableState(state) {
  return Object.freeze({
    ...state,
    error: state.error ? Object.freeze({ ...state.error }) : null,
  });
}

export function createMediaController(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const randomToken = typeof options.randomToken === 'function'
    ? options.randomToken
    : () => randomBytes(24).toString('hex');
  const broadcast = typeof options.broadcast === 'function' ? options.broadcast : () => false;
  const maxLifetimeMs = Number.isFinite(options.maxLifetimeMs)
    ? Math.max(1, Number(options.maxLifetimeMs))
    : 24 * 60 * 60 * 1000;
  const allowedEndpoints = Array.isArray(options.allowedEndpoints)
    ? [...options.allowedEndpoints]
    : parseMediaAllowedEndpoints(options.allowedEndpoints);

  let revision = 0;
  let registration = null;
  let state = immutableState({
    v: 1,
    type: 'media_state',
    state: 'idle',
    revision,
    media_id: null,
    title: null,
    subtitle: null,
    stream_url: null,
    mime_type: null,
    bitrate: MEDIA_NOMINAL_BITRATE,
    updated_at: new Date(now()).toISOString(),
    error: null,
  });

  function publish(next) {
    revision += 1;
    state = immutableState({
      v: 1,
      type: 'media_state',
      revision,
      bitrate: MEDIA_NOMINAL_BITRATE,
      updated_at: new Date(now()).toISOString(),
      ...next,
    });
    try {
      broadcast(state);
    } catch {}
    return status();
  }

  function revokeRegistration() {
    if (!registration) return;
    for (const controller of registration.abortControllers) {
      try {
        controller.abort();
      } catch {}
    }
    registration.abortControllers.clear();
    registration = null;
  }

  function validateUpstream(value) {
    const text = requiredText(value, 'upstream_url', 2048);
    let candidate;
    try {
      candidate = new URL(text);
    } catch {
      throw new MediaControllerError('invalid_upstream_url', 'upstream_url must be an absolute URL.');
    }
    if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') {
      throw new MediaControllerError('invalid_upstream_scheme', 'upstream_url must use http or https.');
    }
    if (candidate.username || candidate.password || candidate.hash) {
      throw new MediaControllerError('unsafe_upstream_url', 'upstream_url cannot contain credentials or a fragment.');
    }
    if (!allowedEndpoints.some((allowed) => sameEndpoint(candidate, allowed))) {
      throw new MediaControllerError('upstream_not_allowed', 'The upstream endpoint is not allowed.', 403);
    }
    return candidate;
  }

  function play(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new MediaControllerError('invalid_request', 'Expected a JSON object.');
    }
    const allowedFields = new Set(['upstream_url', 'media_id', 'title', 'subtitle']);
    const unknown = Object.keys(input).find((key) => !allowedFields.has(key));
    if (unknown) {
      throw new MediaControllerError('unsupported_field', 'Unsupported media field: ' + unknown);
    }
    const upstream = validateUpstream(input.upstream_url);
    const mediaId = requiredText(input.media_id, 'media_id', 128);
    const title = requiredText(input.title, 'title', 200);
    const subtitle = optionalText(input.subtitle, 'subtitle', 200);
    const token = randomToken();
    if (typeof token !== 'string' || token.length < 24) {
      throw new Error('Media token source returned insufficient entropy.');
    }

    revokeRegistration();
    registration = {
      token,
      upstream,
      mediaId,
      expiresAt: now() + maxLifetimeMs,
      abortControllers: new Set(),
    };
    return publish({
      state: 'active',
      media_id: mediaId,
      title,
      subtitle,
      stream_url: '/api/media/stream/' + encodeURIComponent(token),
      mime_type: MEDIA_MIME_TYPE,
      error: null,
    });
  }

  function stop(reason = 'requested') {
    if (state.state === 'idle' && !registration) return status();
    revokeRegistration();
    return publish({
      state: 'idle',
      media_id: null,
      title: null,
      subtitle: null,
      stream_url: null,
      mime_type: null,
      error: null,
      reason,
    });
  }

  function fail(token, code, message) {
    if (!registration || registration.token !== token) return status();
    const mediaId = registration.mediaId;
    revokeRegistration();
    return publish({
      state: 'error',
      media_id: mediaId,
      title: state.title,
      subtitle: state.subtitle,
      stream_url: null,
      mime_type: null,
      error: {
        code: String(code ?? 'upstream_error').slice(0, 64),
        message: String(message ?? 'Media upstream failed.').slice(0, 240),
      },
    });
  }

  function resolve(token) {
    if (!registration || registration.token !== token || state.state !== 'active') return null;
    if (now() > registration.expiresAt) {
      stop('expired');
      return null;
    }
    return Object.freeze({
      token: registration.token,
      upstream: new URL(registration.upstream.href),
      mediaId: registration.mediaId,
      expiresAt: registration.expiresAt,
    });
  }

  function attachAbortController(token, controller) {
    if (!registration || registration.token !== token || !controller) return () => {};
    registration.abortControllers.add(controller);
    return () => registration?.abortControllers.delete(controller);
  }

  function status() {
    return immutableState(state);
  }

  function replay() {
    try {
      broadcast(state);
    } catch {}
    return status();
  }

  return {
    play,
    stop,
    fail,
    resolve,
    attachAbortController,
    status,
    replay,
    close() {
      revokeRegistration();
    },
  };
}
