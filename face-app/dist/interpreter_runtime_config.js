const PRESETS = Object.freeze({
  'gemma4-supertonic': Object.freeze({
    asr: 'gemma4',
    intent: 'gemma4',
    translation: 'gemma4',
    tts: 'supertonic'
  }),
  'gemma4-qwen3': Object.freeze({
    asr: 'gemma4',
    intent: 'gemma4',
    translation: 'gemma4',
    tts: 'qwen3'
  }),
  'nemotron-gemma4-supertonic': Object.freeze({
    asr: 'nemotron-3.5-asr',
    intent: 'gemma4',
    translation: 'gemma4',
    tts: 'supertonic'
  }),
  'nemotron-gemma4-qwen3': Object.freeze({
    asr: 'nemotron-3.5-asr',
    intent: 'gemma4',
    translation: 'gemma4',
    tts: 'qwen3'
  })
});

const PRESET_ALIASES = Object.freeze({
  'light-cloud': 'nemotron-gemma4-supertonic'
});

export function listInterpreterPresets() {
  return Object.keys(PRESETS);
}

export function resolveInterpreterPreset(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const requestedName = name || 'gemma4-supertonic';
  const resolvedName = PRESET_ALIASES[requestedName] ?? requestedName;
  const providers = PRESETS[resolvedName];
  if (!providers) {
    throw new Error(
      `unsupported interpreter preset: ${requestedName} (expected ${listInterpreterPresets().join('|')})`
    );
  }
  return {
    name: resolvedName,
    ...providers
  };
}

export function atomInterpreterSessionId(deviceId) {
  const normalized = typeof deviceId === 'string' ? deviceId.trim() : '';
  return `atom:${normalized || 'headroom'}`;
}
