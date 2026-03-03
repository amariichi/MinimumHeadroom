import { normalizeOperatorAsrTerms } from '../face-app/public/operator_asr_term_normalizer.js';
import { getOperatorRealtimeAsrSuspicion } from '../face-app/public/operator_asr_text.js';

export const defaultLoopSpeakers = Object.freeze(['Serena', 'Vivian', 'Ono_Anna']);

const loopComparisonAcronyms = new Map([
  ['pr', 'PR'],
  ['ci', 'CI'],
  ['cd', 'CD']
]);

const loopComparisonAcronymPattern = new RegExp(
  `(^|[^A-Za-z0-9])(?:${[...loopComparisonAcronyms.keys()].join('|')})(?=$|[^A-Za-z0-9])`,
  'giu'
);

const canonicalSpeakerByAlias = new Map(
  defaultLoopSpeakers.map((speaker) => [normalizeSpeakerAlias(speaker), speaker])
);

function asNonEmptyTrimmedString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeSpeakerAlias(value) {
  return asNonEmptyTrimmedString(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function normalizeLoopSpeakerName(value) {
  const alias = normalizeSpeakerAlias(value);
  if (alias === '') {
    return null;
  }
  return canonicalSpeakerByAlias.get(alias) ?? null;
}

export function parseLoopSpeakers(rawValue, fallback = defaultLoopSpeakers) {
  const fallbackList = Array.isArray(fallback) ? fallback.filter((value) => typeof value === 'string' && value.trim() !== '') : [];
  const raw = asNonEmptyTrimmedString(rawValue);
  if (raw === '') {
    return [...fallbackList];
  }

  const speakers = [];
  const seen = new Set();
  for (const token of raw.split(',')) {
    const speaker = normalizeLoopSpeakerName(token);
    if (speaker === null) {
      throw new Error(`Unknown speaker: ${token.trim() || '(empty)'}`);
    }
    if (!seen.has(speaker)) {
      seen.add(speaker);
      speakers.push(speaker);
    }
  }
  if (speakers.length === 0) {
    return [...fallbackList];
  }
  return speakers;
}

function stripOptionalHaiPrefix(text, allowOptionalHaiPrefix) {
  if (!allowOptionalHaiPrefix) {
    return text;
  }
  return text.replace(/^はい(?:[、,\s]+)?/u, '').trimStart();
}

function normalizeLoopComparisonText(text, language) {
  if (text === '') {
    return text;
  }
  let next = text;
  if (language === 'ja') {
    next = next.replace(loopComparisonAcronymPattern, (match, prefix = '') => {
      const token = match.slice(prefix.length);
      return `${prefix}${loopComparisonAcronyms.get(token.toLowerCase()) ?? token}`;
    });
    next = next.replace(/[、,]/gu, '');
    next = next.replace(/(?<=[A-Za-z0-9./:+_-])\s+(?=[ぁ-んァ-ヶー一-龯々〆ヵヶ])/gu, '');
    next = next.replace(/(?<=[ぁ-んァ-ヶー一-龯々〆ヵヶ])\s+(?=[A-Za-z0-9./:+_-])/gu, '');
    next = next.replace(/[。．.!！?？]+$/gu, '');
    next = next.replace(/(?<=[ぁ-んァ-ヶー一-龯々〆ヵヶ])をお願いします$/gu, 'お願いします');
  }
  return next;
}

export function normalizeLoopObservedText(text, fixture = {}) {
  const language = fixture.language === 'ja' ? 'ja' : 'en';
  const trimmed = asNonEmptyTrimmedString(text);
  if (trimmed === '') {
    return '';
  }
  const withoutOptionalPrefix = stripOptionalHaiPrefix(trimmed, fixture.allowOptionalHaiPrefix === true);
  const normalized = asNonEmptyTrimmedString(normalizeOperatorAsrTerms(withoutOptionalPrefix, language));
  return asNonEmptyTrimmedString(normalizeLoopComparisonText(normalized, language));
}

function normalizeLoopExpectedText(text, fixture = {}) {
  const language = fixture.language === 'ja' ? 'ja' : 'en';
  const normalized = asNonEmptyTrimmedString(normalizeOperatorAsrTerms(asNonEmptyTrimmedString(text), language));
  return asNonEmptyTrimmedString(normalizeLoopComparisonText(normalized, language));
}

function normalizeAllowedOutputs(fixture = {}) {
  if (!Array.isArray(fixture.allowedOutputs)) {
    return [];
  }
  return fixture.allowedOutputs
    .map((candidate) => normalizeLoopExpectedText(candidate, fixture))
    .filter((candidate) => candidate !== '');
}

export function evaluateLoopCase(fixture, observed) {
  const normalizedObserved = normalizeLoopObservedText(observed, fixture);
  const expected = normalizeLoopExpectedText(fixture?.displayText ?? '', fixture);
  const allowed = normalizeAllowedOutputs(fixture);
  const matchesExpected = normalizedObserved !== '' && normalizedObserved === expected;
  const matchesAllowed = normalizedObserved !== '' && allowed.includes(normalizedObserved);
  const matches = matchesExpected || matchesAllowed;

  let status = 'fail';
  let reason = 'mismatch';
  if (matchesExpected) {
    status = 'pass';
    reason = 'expected-match';
  } else if (matchesAllowed) {
    status = 'pass';
    reason = 'allowed-variant';
  } else if (fixture?.tier === 'fragile') {
    status = 'warn';
    reason = normalizedObserved === '' ? 'fragile-empty' : 'fragile-mismatch';
  } else if (normalizedObserved === '') {
    reason = 'empty-output';
  }

  return {
    status,
    reason,
    normalizedObserved,
    expected,
    humanReviewRequired: true
  };
}

export function classifyRealtimePrimaryOutcome({ text = '', language = 'en', error = null, hasBufferedAudio = true } = {}) {
  if (typeof error === 'string' && error.trim() !== '') {
    return hasBufferedAudio
      ? { useFallback: true, reason: 'error', acceptedText: '', suspicion: null }
      : { useFallback: false, reason: 'error-no-buffer', acceptedText: '', suspicion: null };
  }

  const trimmed = asNonEmptyTrimmedString(text);
  if (trimmed === '') {
    return hasBufferedAudio
      ? { useFallback: true, reason: 'empty', acceptedText: '', suspicion: null }
      : { useFallback: false, reason: 'empty-no-buffer', acceptedText: '', suspicion: null };
  }

  const normalizedLanguage = language === 'ja' ? 'ja' : 'en';
  const suspicion = getOperatorRealtimeAsrSuspicion(trimmed, normalizedLanguage);
  if (suspicion) {
    return hasBufferedAudio
      ? { useFallback: true, reason: 'suspicious', acceptedText: '', suspicion }
      : { useFallback: false, reason: 'suspicious-no-buffer', acceptedText: '', suspicion };
  }

  return { useFallback: false, reason: 'accepted', acceptedText: trimmed, suspicion: null };
}
