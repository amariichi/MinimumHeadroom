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

export function shouldStopBrowserAudioChannel(channel, criteria = {}) {
  if (!channel || channel.active !== true) {
    return false;
  }
  const generation = Number.isFinite(criteria.generation) ? Math.floor(criteria.generation) : null;
  const sessionId = asSessionId(criteria.sessionId);

  if (Number.isInteger(generation)) {
    if (!Number.isInteger(channel.generation) || channel.generation !== generation) {
      return false;
    }
  }
  if (sessionId && asSessionId(channel.sessionId) !== sessionId) {
    return false;
  }
  return true;
}

