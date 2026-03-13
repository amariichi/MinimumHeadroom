function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function resolveBrowserAudioMaxChannels(options = {}) {
  const env = options.env ?? process.env;
  const uiMode = typeof options.uiMode === 'string' ? options.uiMode.trim().toLowerCase() : 'auto';
  const fallback = uiMode === 'pc' ? 8 : 4;
  const raw = Object.prototype.hasOwnProperty.call(env, 'FACE_BROWSER_AUDIO_MAX_CHANNELS')
    ? env.FACE_BROWSER_AUDIO_MAX_CHANNELS
    : String(fallback);
  const parsed = Number.parseInt(raw ?? String(fallback), 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return clamp(parsed, 1, 8);
}
