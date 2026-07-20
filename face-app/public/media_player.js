const DEFAULT_PLAY_TIMEOUT_MS = 3000;

function noop() {}

function normalizeRevision(value) {
  return Number.isFinite(value) ? Math.floor(value) : null;
}

function normalizeText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text || null;
}

function isAutoplayBlock(error) {
  return error?.name === 'NotAllowedError'
    || /notallowed|user gesture|not allowed/i.test(String(error?.message ?? ''));
}

export function createMediaPlayer(options = {}) {
  const audio = options.audio ?? new Audio();
  const notify = typeof options.onStateChange === 'function' ? options.onStateChange : noop;
  const fetchImpl = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch?.bind(globalThis);
  const schedule = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const cancel = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const playTimeoutMs = Number.isFinite(options.playTimeoutMs)
    ? Math.max(1, Number(options.playTimeoutMs))
    : DEFAULT_PLAY_TIMEOUT_MS;

  audio.preload = 'auto';
  audio.playsInline = true;
  audio.setAttribute?.('playsinline', 'true');
  audio.setAttribute?.('webkit-playsinline', 'true');
  // Keep the media stream at unity gain. Ducking is applied once, at the
  // source encoder, so every browser hears the same bounded mix.
  audio.volume = 1;

  let serverState = 'idle';
  let playbackState = 'idle';
  let revision = -1;
  let mediaId = null;
  let title = null;
  let subtitle = null;
  let currentStreamUrl = null;
  let error = null;
  let operation = 0;
  let primed = false;
  let destroyed = false;

  function snapshot() {
    return Object.freeze({
      serverState,
      playbackState,
      revision,
      mediaId,
      title,
      subtitle,
      error,
      primed
    });
  }

  function publish() {
    const next = snapshot();
    try {
      notify(next);
    } catch {}
    return next;
  }

  function pauseAndReset({ removeSource = true } = {}) {
    operation += 1;
    try {
      audio.pause();
    } catch {}
    try {
      audio.currentTime = 0;
    } catch {}
    if (removeSource) {
      try {
        audio.removeAttribute?.('src');
        audio.load?.();
      } catch {}
      currentStreamUrl = null;
    }
  }

  function playWithTimeout() {
    return new Promise((resolve, reject) => {
      let timer = null;
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) cancel(timer);
        handler(value);
      };
      timer = schedule(() => {
        const timeout = new Error('media playback start timed out');
        timeout.name = 'TimeoutError';
        finish(reject, timeout);
      }, playTimeoutMs);
      try {
        Promise.resolve(audio.play()).then(
          () => finish(resolve, true),
          (playError) => finish(reject, playError)
        );
      } catch (playError) {
        finish(reject, playError);
      }
    });
  }

  async function attemptPlay({ gesture = false } = {}) {
    if (destroyed || serverState !== 'active' || !currentStreamUrl) {
      return false;
    }
    const attempt = ++operation;
    playbackState = 'starting';
    error = null;
    publish();
    try {
      await playWithTimeout();
      if (destroyed || attempt !== operation || serverState !== 'active') return false;
      primed = true;
      playbackState = 'playing';
      error = null;
      publish();
      return true;
    } catch (playError) {
      if (destroyed || attempt !== operation || serverState !== 'active') return false;
      if (isAutoplayBlock(playError)) {
        playbackState = 'tap_required';
        error = gesture ? 'Tap Resume to allow audio.' : 'Tap Resume to allow audio.';
      } else {
        playbackState = 'error';
        error = playError?.message || 'Media playback failed.';
      }
      publish();
      return false;
    }
  }

  function applyState(payload) {
    if (destroyed || !payload || payload.type !== 'media_state') return snapshot();
    const nextRevision = normalizeRevision(payload.revision);
    if (nextRevision === null || nextRevision <= revision) return snapshot();
    revision = nextRevision;
    serverState = payload.state === 'active' || payload.state === 'error' ? payload.state : 'idle';
    mediaId = normalizeText(payload.media_id);
    title = normalizeText(payload.title);
    subtitle = normalizeText(payload.subtitle);
    error = normalizeText(payload.error?.message);

    if (serverState !== 'active') {
      pauseAndReset();
      playbackState = serverState === 'error' ? 'error' : 'idle';
      publish();
      return snapshot();
    }

    const streamUrl = normalizeText(payload.stream_url);
    if (!streamUrl || payload.mime_type !== 'audio/mpeg' || Number(payload.bitrate) !== 128000) {
      pauseAndReset();
      playbackState = 'error';
      error = 'Media stream policy mismatch.';
      publish();
      return snapshot();
    }

    if (streamUrl !== currentStreamUrl) {
      pauseAndReset();
      currentStreamUrl = streamUrl;
      try {
        audio.src = streamUrl;
        audio.currentTime = 0;
        audio.load?.();
      } catch (sourceError) {
        playbackState = 'error';
        error = sourceError?.message || 'Media source could not be loaded.';
        publish();
        return snapshot();
      }
    }
    void attemptPlay();
    return snapshot();
  }

  function primeInGesture(silentAudioUrl) {
    if (destroyed) return;
    if (serverState === 'active' && currentStreamUrl) {
      void attemptPlay({ gesture: true });
      return;
    }
    if (primed || !normalizeText(silentAudioUrl)) return;

    const attempt = ++operation;
    const originalStreamUrl = currentStreamUrl;
    try {
      audio.src = silentAudioUrl;
      audio.currentTime = 0;
      Promise.resolve(audio.play())
        .then(() => {
          if (destroyed || attempt !== operation) return;
          primed = true;
        })
        .catch(noop)
        .finally(() => {
          if (destroyed || attempt !== operation || serverState === 'active') return;
          try {
            audio.pause();
            audio.currentTime = 0;
            if (originalStreamUrl) {
              audio.src = originalStreamUrl;
            } else {
              audio.removeAttribute?.('src');
              audio.load?.();
            }
          } catch {}
        });
    } catch {}
  }

  async function resume() {
    return attemptPlay({ gesture: true });
  }

  async function requestStop() {
    if (typeof fetchImpl !== 'function') throw new Error('Media stop API is unavailable.');
    const response = await fetchImpl('/api/media/stop', {
      method: 'POST',
      headers: { accept: 'application/json' }
    });
    if (!response?.ok) throw new Error('Media stop request failed.');
    return response.json?.();
  }

  audio.addEventListener?.('playing', () => {
    if (destroyed || serverState !== 'active') return;
    playbackState = 'playing';
    error = null;
    publish();
  });
  audio.addEventListener?.('error', () => {
    if (destroyed || serverState !== 'active') return;
    playbackState = 'error';
    error = 'Media stream could not be decoded.';
    publish();
  });
  audio.addEventListener?.('ended', () => {
    if (destroyed || serverState !== 'active') return;
    playbackState = 'ended';
    error = 'Media stream ended.';
    publish();
  });

  return {
    audio,
    applyState,
    primeInGesture,
    resume,
    requestStop,
    snapshot,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      pauseAndReset();
    }
  };
}
