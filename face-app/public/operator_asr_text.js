import { normalizeOperatorAsrTerms } from './operator_asr_term_normalizer.js';

const OPERATOR_JA_LATIN_ONLY_MIN_CHARS = 6;
const OPERATOR_JA_LATIN_ONLY_NO_SPACE_MIN_CHARS = 12;

function isOperatorAsciiDigitCodePoint(codePoint) {
  return codePoint >= 0x30 && codePoint <= 0x39;
}

function isOperatorFullwidthDigitCodePoint(codePoint) {
  return codePoint >= 0xff10 && codePoint <= 0xff19;
}

function isOperatorAsciiLatinCodePoint(codePoint) {
  return (codePoint >= 0x41 && codePoint <= 0x5a) || (codePoint >= 0x61 && codePoint <= 0x7a);
}

function isOperatorFullwidthLatinCodePoint(codePoint) {
  return (codePoint >= 0xff21 && codePoint <= 0xff3a) || (codePoint >= 0xff41 && codePoint <= 0xff5a);
}

function isOperatorExtendedLatinCodePoint(codePoint) {
  return (
    (codePoint >= 0x00c0 && codePoint <= 0x00d6) ||
    (codePoint >= 0x00d8 && codePoint <= 0x00f6) ||
    (codePoint >= 0x00f8 && codePoint <= 0x00ff) ||
    (codePoint >= 0x0100 && codePoint <= 0x024f) ||
    (codePoint >= 0x1e00 && codePoint <= 0x1eff)
  );
}

function isOperatorLatinCombiningMarkCodePoint(codePoint) {
  return codePoint >= 0x0300 && codePoint <= 0x036f;
}

function isOperatorJapaneseCodePoint(codePoint) {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x309f) ||
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0xff66 && codePoint <= 0xff9d) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    codePoint === 0x3005 ||
    codePoint === 0x303b
  );
}

function isOperatorHangulCodePoint(codePoint) {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7ff)
  );
}

function isOperatorCyrillicCodePoint(codePoint) {
  return (
    (codePoint >= 0x0400 && codePoint <= 0x04ff) ||
    (codePoint >= 0x0500 && codePoint <= 0x052f) ||
    (codePoint >= 0x1c80 && codePoint <= 0x1c8f) ||
    (codePoint >= 0x2de0 && codePoint <= 0x2dff) ||
    (codePoint >= 0xa640 && codePoint <= 0xa69f)
  );
}

function isOperatorIgnorableCodePoint(codePoint) {
  return (
    codePoint <= 0x20 ||
    isOperatorAsciiDigitCodePoint(codePoint) ||
    isOperatorFullwidthDigitCodePoint(codePoint) ||
    (codePoint >= 0x21 && codePoint <= 0x2f) ||
    (codePoint >= 0x3a && codePoint <= 0x40) ||
    (codePoint >= 0x5b && codePoint <= 0x60) ||
    (codePoint >= 0x7b && codePoint <= 0x7e) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0xff01 && codePoint <= 0xff0f) ||
    (codePoint >= 0xff1a && codePoint <= 0xff20) ||
    (codePoint >= 0xff3b && codePoint <= 0xff40) ||
    (codePoint >= 0xff5b && codePoint <= 0xff65)
  );
}

function isOperatorLongLatinOnlyJapaneseMisrecognition(text, analysis) {
  if (analysis.significantCount < OPERATOR_JA_LATIN_ONLY_MIN_CHARS) {
    return false;
  }
  if (analysis.japaneseCount > 0 || analysis.latinCount !== analysis.significantCount) {
    return false;
  }

  const trimmed = text.trim();
  if (trimmed === '') {
    return false;
  }
  if (analysis.latinCount >= OPERATOR_JA_LATIN_ONLY_NO_SPACE_MIN_CHARS) {
    return true;
  }
  return /\s/u.test(trimmed);
}

export function analyzeOperatorRealtimeAsrText(text) {
  const result = {
    japaneseCount: 0,
    latinCount: 0,
    hangulCount: 0,
    cyrillicCount: 0,
    otherCount: 0,
    significantCount: 0
  };
  if (typeof text !== 'string' || text === '') {
    return result;
  }
  for (const symbol of text) {
    const codePoint = symbol.codePointAt(0);
    if (!Number.isFinite(codePoint) || isOperatorIgnorableCodePoint(codePoint)) {
      continue;
    }
    if (isOperatorJapaneseCodePoint(codePoint)) {
      result.japaneseCount += 1;
      result.significantCount += 1;
      continue;
    }
    if (
      isOperatorAsciiLatinCodePoint(codePoint) ||
      isOperatorFullwidthLatinCodePoint(codePoint) ||
      isOperatorExtendedLatinCodePoint(codePoint)
    ) {
      result.latinCount += 1;
      result.significantCount += 1;
      continue;
    }
    if (isOperatorLatinCombiningMarkCodePoint(codePoint)) {
      continue;
    }
    if (isOperatorHangulCodePoint(codePoint)) {
      result.hangulCount += 1;
      result.significantCount += 1;
      continue;
    }
    if (isOperatorCyrillicCodePoint(codePoint)) {
      result.cyrillicCount += 1;
      result.significantCount += 1;
      continue;
    }
    if (codePoint > 0x7f) {
      result.otherCount += 1;
      result.significantCount += 1;
    }
  }
  return result;
}

export function getOperatorRealtimeAsrSuspicion(text, language = 'en') {
  if (typeof text !== 'string' || text.trim() === '') {
    return null;
  }
  const analysis = analyzeOperatorRealtimeAsrText(text);
  if (analysis.hangulCount > 0) {
    return 'hangul';
  }
  if (analysis.cyrillicCount > 0) {
    return 'cyrillic';
  }
  if (analysis.otherCount > 0) {
    return 'other-script';
  }
  if (language === 'ja' && isOperatorLongLatinOnlyJapaneseMisrecognition(text, analysis)) {
    return 'latin-only-ja';
  }
  if (analysis.significantCount === 1) {
    if (language === 'ja' && analysis.japaneseCount === 0) {
      return 'single-non-japanese';
    }
    if (language === 'en' && analysis.latinCount === 0) {
      return 'single-non-english';
    }
  }
  if (language === 'en' && analysis.significantCount > 0 && analysis.latinCount === 0 && analysis.japaneseCount > 0) {
    return 'non-english';
  }
  return null;
}

export function shouldAcceptOperatorBatchFallbackResult(result, language = 'en') {
  if (!result || typeof result.text !== 'string' || result.text.trim() === '') {
    return false;
  }
  return getOperatorRealtimeAsrSuspicion(result.text, language) === null;
}

export function resolveOperatorRealtimeAsrFinalText(finalText, draftText = '', language = 'en') {
  const trimmedFinal = typeof finalText === 'string' ? finalText.trim() : '';
  const trimmedDraft = typeof draftText === 'string' ? draftText.trim() : '';
  if (trimmedFinal !== '') {
    return {
      text: normalizeOperatorAsrTerms(trimmedFinal, language),
      source: 'final'
    };
  }
  if (trimmedDraft !== '') {
    return {
      text: normalizeOperatorAsrTerms(trimmedDraft, language),
      source: 'draft'
    };
  }
  return {
    text: '',
    source: 'empty'
  };
}
