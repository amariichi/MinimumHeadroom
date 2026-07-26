import { normalizeInterpreterLanguage } from './interpreter_state.js';

const FALLBACK_LANGUAGE_NAMES = Object.freeze({
  ar: 'العربية',
  bg: 'български',
  cs: 'čeština',
  da: 'dansk',
  de: 'Deutsch',
  el: 'Ελληνικά',
  en: 'English',
  es: 'español',
  et: 'eesti',
  fi: 'suomi',
  fr: 'français',
  hi: 'हिन्दी',
  hr: 'hrvatski',
  hu: 'magyar',
  id: 'Bahasa Indonesia',
  it: 'italiano',
  ja: '日本語',
  ko: '한국어',
  lt: 'lietuvių',
  lv: 'latviešu',
  nl: 'Nederlands',
  pl: 'polski',
  pt: 'português',
  ro: 'română',
  ru: 'русский',
  sk: 'slovenčina',
  sl: 'slovenščina',
  sv: 'svenska',
  tr: 'Türkçe',
  uk: 'українська',
  vi: 'Tiếng Việt',
  zh: '中文'
});

const PAIR_FORMATTERS = Object.freeze({
  de: (anchor, partner) => `Jetzt: ${anchor} und ${partner}.`,
  en: (anchor, partner) => `Now: ${anchor} and ${partner}.`,
  es: (anchor, partner) => `Ahora, ${anchor} y ${partner}.`,
  fr: (anchor, partner) => `Maintenant : ${anchor} et ${partner}.`,
  ja: (anchor, partner) => `${anchor}と${partner}に切り替えます。`,
  ko: (anchor, partner) => `현재 언어: ${anchor}, ${partner}.`,
  zh: (anchor, partner) => `现在使用${anchor}和${partner}。`
});

function localizedLanguageName(locale, language) {
  if (typeof Intl.DisplayNames === 'function') {
    try {
      const names = new Intl.DisplayNames([locale], { type: 'language' });
      const localized = names.of(language);
      if (typeof localized === 'string' && localized.trim() !== '') {
        return localized.trim();
      }
    } catch {
      // Fall through to a deterministic local name when ICU lacks a locale.
    }
  }
  return FALLBACK_LANGUAGE_NAMES[language] ?? language;
}

function formatPair(locale, anchorLanguage, partnerLanguage) {
  const anchorName = localizedLanguageName(locale, anchorLanguage);
  const partnerName = localizedLanguageName(locale, partnerLanguage);
  const formatter = PAIR_FORMATTERS[locale];
  return formatter
    ? formatter(anchorName, partnerName)
    : `${anchorName}, ${partnerName}.`;
}

export function createInterpreterPairAnnouncements(value = {}) {
  const anchorLanguage = normalizeInterpreterLanguage(
    value.anchorLanguage ?? value.anchor_language
  );
  const partnerLanguage = normalizeInterpreterLanguage(
    value.partnerLanguage ?? value.partner_language
  );
  if (!anchorLanguage || !partnerLanguage || anchorLanguage === partnerLanguage) {
    return [];
  }
  return [anchorLanguage, partnerLanguage].map((language) => ({
    language,
    text: formatPair(language, anchorLanguage, partnerLanguage)
  }));
}
