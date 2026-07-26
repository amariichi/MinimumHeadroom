const SUPERTONIC_LANGUAGES = new Set([
  'ar', 'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de',
  'el', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'lv', 'lt', 'pl', 'pt',
  'ro', 'ru', 'sk', 'sl', 'es', 'sv', 'tr', 'uk', 'vi'
]);

const QWEN3_LANGUAGES = new Set([
  'zh', 'en', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it'
]);

const NEMOTRON_SUPERTONIC_LANGUAGES = new Set([
  'ar', 'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de',
  'hi', 'hu', 'it', 'ja', 'ko', 'pl', 'pt', 'ro', 'ru', 'sk', 'es',
  'sv', 'tr', 'uk', 'vi'
]);

const NEMOTRON_QWEN3_LANGUAGES = new Set([
  'zh', 'en', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it'
]);

function primaryLanguage(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase().split('-')[0];
  return normalized || null;
}

export function interpreterTtsSupportsLanguage(engine, language) {
  const primary = primaryLanguage(language);
  if (!primary) {
    return false;
  }
  if (engine === 'supertonic') {
    return SUPERTONIC_LANGUAGES.has(primary);
  }
  if (engine === 'qwen3') {
    return QWEN3_LANGUAGES.has(primary);
  }
  return false;
}

export function interpreterTtsSupportedLanguages(engine) {
  if (engine === 'supertonic') {
    return [...SUPERTONIC_LANGUAGES].sort();
  }
  if (engine === 'qwen3') {
    return [...QWEN3_LANGUAGES].sort();
  }
  return [];
}

export function interpreterManualPairLanguages(presetName) {
  if (
    presetName === 'light-cloud'
    || presetName === 'nemotron-gemma4-supertonic'
  ) {
    return [...NEMOTRON_SUPERTONIC_LANGUAGES].sort();
  }
  if (presetName === 'gemma4-supertonic') {
    return interpreterTtsSupportedLanguages('supertonic');
  }
  if (presetName === 'gemma4-qwen3') {
    return interpreterTtsSupportedLanguages('qwen3');
  }
  if (presetName === 'nemotron-gemma4-qwen3') {
    return [...NEMOTRON_QWEN3_LANGUAGES].sort();
  }
  return [];
}

export function createInterpreterTtsGate() {
  return {
    check() {
      return { allow: true };
    }
  };
}
