export function createAudioFocusController(options = {}) {
  const broadcast = typeof options.broadcast === 'function' ? options.broadcast : () => false;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const schedule = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const cancel = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const releaseDelayMs = Number.isFinite(options.releaseDelayMs)
    ? Math.max(0, Number(options.releaseDelayMs))
    : 1500;

  let state = 'normal';
  let revision = 0;
  let releaseTimer = null;

  function payload() {
    return Object.freeze({
      v: 1,
      type: 'audio_focus',
      state,
      revision,
      ts: now(),
    });
  }

  function emit(nextState) {
    if (nextState === state && revision > 0) return payload();
    state = nextState;
    revision += 1;
    const next = payload();
    try {
      broadcast(next);
    } catch {}
    return next;
  }

  function clearRelease() {
    if (releaseTimer === null) return;
    cancel(releaseTimer);
    releaseTimer = null;
  }

  function update(activity = {}) {
    const hasSpeech = activity.active === true || Number(activity.queued ?? 0) > 0;
    if (hasSpeech) {
      clearRelease();
      return emit('speech');
    }
    if (state !== 'speech') return payload();
    if (releaseTimer !== null) return payload();
    releaseTimer = schedule(() => {
      releaseTimer = null;
      emit('normal');
    }, releaseDelayMs);
    releaseTimer?.unref?.();
    return payload();
  }

  return {
    update,
    status: payload,
    replay() {
      if (revision === 0) return emit(state);
      const current = payload();
      try {
        broadcast(current);
      } catch {}
      return current;
    },
    close() {
      clearRelease();
    },
  };
}
