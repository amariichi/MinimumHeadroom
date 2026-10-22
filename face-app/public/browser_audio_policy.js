export const BROWSER_AUDIO_MAX_CHANNELS_DEFAULT = 4;
export const BROWSER_AUDIO_MAX_CHANNELS_MIN = 1;
export const BROWSER_AUDIO_MAX_CHANNELS_MAX = 8;

function asSessionId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function clampBrowserAudioMaxChannels(value) {
  if (!Number.isFinite(value)) {
    return BROWSER_AUDIO_MAX_CHANNELS_DEFAULT;
  }
  return Math.max(
    BROWSER_AUDIO_MAX_CHANNELS_MIN,
    Math.min(BROWSER_AUDIO_MAX_CHANNELS_MAX, Math.floor(value))
  );
}

export function selectBrowserAudioChannelIndex(channels, sessionId, maxChannels) {
  const list = Array.isArray(channels) ? channels : [];
  const normalizedSessionId = asSessionId(sessionId);

  if (normalizedSessionId) {
    for (let index = 0; index < list.length; index += 1) {
      const channel = list[index];
      if (channel?.active && asSessionId(channel.sessionId) === normalizedSessionId) {
        return index;
      }
    }
  }

  for (let index = 0; index < list.length; index += 1) {
    if (list[index]?.active !== true) {
      return index;
    }
  }

  const cap = clampBrowserAudioMaxChannels(maxChannels);
  if (list.length < cap) {
    return list.length;
  }

  let fallbackIndex = 0;
  for (let index = 1; index < list.length; index += 1) {
    const current = list[index];
    const fallback = list[fallbackIndex];
    const currentStartedAt = Number.isFinite(current?.startedAt) ? current.startedAt : 0;
    const fallbackStartedAt = Number.isFinite(fallback?.startedAt) ? fallback.startedAt : 0;
    if (currentStartedAt < fallbackStartedAt) {
      fallbackIndex = index;
    }
  }
  return fallbackIndex;
}

export function matchesBrowserAudioSource(source, criteria = {}) {
  if (!source) return false;
  const generation = Number.isFinite(criteria.generation) ? Math.floor(criteria.generation) : null;
  const sessionId = asSessionId(criteria.sessionId ?? criteria.session_id);
  const messageId = asSessionId(criteria.messageId ?? criteria.message_id);

  if (Number.isInteger(generation)) {
    if (!Number.isInteger(source.generation) || source.generation !== generation) {
      return false;
    }
  }
  if (sessionId && asSessionId(source.sessionId ?? source.session_id) !== sessionId) {
    return false;
  }
  if (messageId && asSessionId(source.messageId ?? source.message_id) !== messageId) return false;
  if (Number.isFinite(criteria.revision) && source.revision !== criteria.revision) return false;
  return true;
}

export function shouldStopBrowserAudioChannel(channel, criteria = {}) {
  return channel?.active === true && matchesBrowserAudioSource(channel, criteria);
}

export function planBrowserAudioCancellation(channel, criteria = {}) {
  const keep = [], remove = [];
  for (const source of channel?.queue ?? []) {
    (matchesBrowserAudioSource(source, criteria) ? remove : keep).push(source);
  }
  return { stopActive: shouldStopBrowserAudioChannel(channel, criteria), keep, remove };
}

export function createBrowserAudioCancellationLedger(maxEntries = 256) {
  const cancelled = new Set();
  const limit = Number.isInteger(maxEntries) ? Math.max(1, maxEntries) : 256;
  const key = source => {
    const sessionId = asSessionId(source?.sessionId ?? source?.session_id);
    const messageId = asSessionId(source?.messageId ?? source?.message_id);
    // Numeric generations restart. Never retain a generation-only tombstone.
    return sessionId && messageId && Number.isInteger(source?.generation) && Number.isFinite(source?.revision)
      ? JSON.stringify([sessionId, source.generation, messageId, source.revision]) : null;
  };
  return {
    cancel(source) {
      const identity = key(source);
      if (!identity) return;
      cancelled.add(identity);
      while (cancelled.size > limit) cancelled.delete(cancelled.values().next().value);
    },
    isCancelled(source) { const identity = key(source); return identity !== null && cancelled.has(identity); },
    get size() { return cancelled.size; }
  };
}

