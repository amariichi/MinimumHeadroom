function toLogger(log) {
  if (!log) {
    return { info: () => {}, warn: () => {}, error: () => {} };
  }
  return {
    info: typeof log.info === 'function' ? log.info.bind(log) : console.log.bind(console),
    warn: typeof log.warn === 'function' ? log.warn.bind(log) : console.warn.bind(console),
    error: typeof log.error === 'function' ? log.error.bind(log) : console.error.bind(console)
  };
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeLanguage(value, fallback = 'en') {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized.startsWith('ja')) {
    return 'ja';
  }
  if (normalized.startsWith('en')) {
    return 'en';
  }
  return fallback;
}

function normalizeSessionId(value) {
  const normalized = asNonEmptyString(value);
  return normalized ?? 'default';
}

function normalizeGeneration(value, fallback = 0) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeTextPayload(data) {
  if (typeof data === 'string') {
    return data;
  }
  if (data && typeof data === 'object' && typeof data.text === 'function') {
    return null;
  }
  if (data == null) {
    return '';
  }
  return String(data);
}

function createEventPayload(type, sessionId, language, extra = {}) {
  return {
    v: 1,
    type,
    session_id: sessionId,
    language,
    ts: Date.now(),
    route: 'operator_realtime_asr_proxy',
    ...extra
  };
}

export function createOperatorRealtimeAsrProxy(options = {}) {
  const log = toLogger(options.log ?? console);
  const endpointUrl = asNonEmptyString(options.endpointUrl);
  const model = asNonEmptyString(options.model);
  const broadcast = typeof options.broadcast === 'function' ? options.broadcast : () => false;
  const websocketFactory =
    typeof options.websocketFactory === 'function'
      ? options.websocketFactory
      : (url) => {
          if (typeof WebSocket !== 'function') {
            throw new Error('WebSocket API is unavailable for realtime ASR proxy');
          }
          return new WebSocket(url);
        };
  const enabled = options.enabled === true && Boolean(endpointUrl);
  const sessions = new Map();

  function closeSession(sessionId, reason = null, emitError = false) {
    const context = sessions.get(sessionId);
    if (!context) {
      return;
    }
    sessions.delete(sessionId);
    context.closing = true;
    try {
      context.socket.close();
    } catch {
      // Ignore close errors while cleaning up.
    }
    if (emitError) {
      broadcast(
        createEventPayload('operator_realtime_asr_error', sessionId, context.language, {
          generation: context.generation,
          error: reason ?? 'realtime_asr_closed'
        })
      );
    }
  }

  function sendJson(context, payload) {
    try {
      context.socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      log.warn(`[face-app] realtime ASR proxy send failed: ${error.message}`);
      broadcast(
        createEventPayload('operator_realtime_asr_error', context.sessionId, context.language, {
          generation: context.generation,
          error: 'realtime_asr_send_failed',
          detail: error.message
        })
      );
      closeSession(context.sessionId);
      return false;
    }
  }

  function flushPendingAudio(context) {
    while (context.pendingAudio.length > 0) {
      const audio = context.pendingAudio.shift();
      if (!sendJson(context, { type: 'input_audio_buffer.append', audio })) {
        return;
      }
    }
  }

  function handleUpstreamPayload(context, payload) {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    if (payload.type === 'session.created') {
      context.ready = true;
      if (model) {
        sendJson(context, { type: 'session.update', model });
      }
      sendJson(context, { type: 'input_audio_buffer.commit' });
      flushPendingAudio(context);
      return;
    }

    if (payload.type === 'transcription.delta') {
      const delta = typeof payload.delta === 'string' ? payload.delta : '';
      if (delta === '') {
        return;
      }
      context.text += delta;
      broadcast(
        createEventPayload('operator_realtime_asr_delta', context.sessionId, context.language, {
          generation: context.generation,
          delta,
          text: context.text
        })
      );
      return;
    }

    if (payload.type === 'transcription.done') {
      const text = typeof payload.text === 'string' && payload.text !== '' ? payload.text : context.text;
      context.text = text;
      context.doneEmitted = true;
      broadcast(
        createEventPayload('operator_realtime_asr_done', context.sessionId, context.language, {
          generation: context.generation,
          text
        })
      );
      if (context.finalRequested) {
        closeSession(context.sessionId);
      }
      return;
    }

    if (payload.type === 'error') {
      const errorMessage =
        asNonEmptyString(payload.error) ??
        asNonEmptyString(payload.message) ??
        asNonEmptyString(payload.code) ??
        'realtime_asr_upstream_error';
      broadcast(
        createEventPayload('operator_realtime_asr_error', context.sessionId, context.language, {
          generation: context.generation,
          error: errorMessage,
          detail: payload
        })
      );
      closeSession(context.sessionId);
    }
  }

  function attachSocketHandlers(context) {
    context.socket.addEventListener('message', async (event) => {
      try {
        const raw = normalizeTextPayload(event.data);
        const text = raw === null ? await event.data.text() : raw;
        handleUpstreamPayload(context, JSON.parse(text));
      } catch (error) {
        log.warn(`[face-app] realtime ASR proxy decode failed: ${error.message}`);
        broadcast(
          createEventPayload('operator_realtime_asr_error', context.sessionId, context.language, {
            generation: context.generation,
            error: 'realtime_asr_decode_failed',
            detail: error.message
          })
        );
        closeSession(context.sessionId);
      }
    });

    context.socket.addEventListener('error', () => {
      closeSession(context.sessionId, 'realtime_asr_socket_error', true);
    });

    context.socket.addEventListener('close', () => {
      const shouldSynthesizeDone = !context.closing && context.finalRequested && !context.doneEmitted;
      if (sessions.get(context.sessionId) === context) {
        sessions.delete(context.sessionId);
      }
      if (shouldSynthesizeDone) {
        broadcast(
          createEventPayload('operator_realtime_asr_done', context.sessionId, context.language, {
            generation: context.generation,
            text: context.text
          })
        );
        return;
      }
      if (!context.closing && !context.finalRequested) {
        broadcast(
          createEventPayload('operator_realtime_asr_error', context.sessionId, context.language, {
            generation: context.generation,
            error: 'realtime_asr_socket_closed'
          })
        );
      }
    });
  }

  function createSession(sessionId, language, generation) {
    closeSession(sessionId);
    const socket = websocketFactory(endpointUrl);
    const context = {
      sessionId,
      language,
      generation,
      socket,
      ready: false,
      pendingAudio: [],
      text: '',
      finalRequested: false,
      doneEmitted: false,
      closing: false
    };
    sessions.set(sessionId, context);
    attachSocketHandlers(context);
    return context;
  }

  function ensureEnabled(sessionId, language, generation = 0) {
    if (enabled) {
      return true;
    }
    broadcast(
      createEventPayload('operator_realtime_asr_error', sessionId, language, {
        generation,
        error: 'realtime_asr_not_configured'
      })
    );
    return false;
  }

  return {
    enabled,
    handlePayload(payload) {
      if (!payload || typeof payload !== 'object') {
        return null;
      }

      const type = asNonEmptyString(payload.type);
      if (!type || !type.startsWith('operator_realtime_asr_')) {
        return null;
      }

      const sessionId = normalizeSessionId(payload.session_id);
      const language = normalizeLanguage(payload.language, 'en');
      const generation = normalizeGeneration(payload.generation);

      if (type === 'operator_realtime_asr_start') {
        if (ensureEnabled(sessionId, language, generation)) {
          createSession(sessionId, language, generation);
        }
        return { relay: false };
      }

      const context = sessions.get(sessionId);
      if (!context) {
        if (type === 'operator_realtime_asr_cancel') {
          return { relay: false };
        }
        ensureEnabled(sessionId, language, generation);
        broadcast(
          createEventPayload('operator_realtime_asr_error', sessionId, language, {
            generation,
            error: 'realtime_asr_session_missing'
          })
        );
        return { relay: false };
      }

      if (type === 'operator_realtime_asr_chunk') {
        if (generation !== context.generation) {
          return { relay: false };
        }
        const audio = asNonEmptyString(payload.audio);
        if (!audio) {
          return { relay: false };
        }
        if (context.ready) {
          sendJson(context, { type: 'input_audio_buffer.append', audio });
        } else {
          context.pendingAudio.push(audio);
        }
        return { relay: false };
      }

      if (type === 'operator_realtime_asr_stop') {
        if (generation !== context.generation) {
          return { relay: false };
        }
        context.finalRequested = true;
        sendJson(context, { type: 'input_audio_buffer.commit', final: true });
        return { relay: false };
      }

      if (type === 'operator_realtime_asr_cancel') {
        if (generation !== context.generation) {
          return { relay: false };
        }
        closeSession(sessionId);
        return { relay: false };
      }

      return { relay: false };
    },
    async closeAll() {
      for (const sessionId of [...sessions.keys()]) {
        closeSession(sessionId);
      }
    }
  };
}
