const DEFAULT_CONFIDENCE_MIN = 0.70;
const DEFAULT_SWITCH_MIN_MS = 700;
const DEFAULT_SWITCH_MIN_GRAPHEMES = 4;
const DEFAULT_REPEAT_WINDOW_MS = 30_000;
const DEFAULT_SESSION_TTL_MS = 30 * 60_000;
// Completed responses exist only to make an immediate retry idempotent. Four
// per session covers overlapping phone/Atom delivery without turning the
// volatile store into a conversation history.
const DEFAULT_TURN_CACHE_SIZE = 4;

const LANGUAGE_ALIASES = new Map([
  ['auto', null],
  ['automatic', null],
  ['und', null],
  ['unknown', null],
  ['japanese', 'ja'],
  ['日本語', 'ja'],
  ['english', 'en'],
  ['英語', 'en'],
  ['spanish', 'es'],
  ['español', 'es'],
  ['スペイン語', 'es'],
  ['french', 'fr'],
  ['français', 'fr'],
  ['フランス語', 'fr'],
  ['german', 'de'],
  ['deutsch', 'de'],
  ['ドイツ語', 'de'],
  ['korean', 'ko'],
  ['한국어', 'ko'],
  ['韓国語', 'ko'],
  ['chinese', 'zh'],
  ['mandarin', 'zh'],
  ['中文', 'zh'],
  ['中国語', 'zh'],
  ['italian', 'it'],
  ['italiano', 'it'],
  ['イタリア語', 'it'],
  ['portuguese', 'pt'],
  ['português', 'pt'],
  ['ポルトガル語', 'pt'],
  ['russian', 'ru'],
  ['русский', 'ru'],
  ['ロシア語', 'ru'],
  ['arabic', 'ar'],
  ['العربية', 'ar'],
  ['アラビア語', 'ar'],
  ['hindi', 'hi'],
  ['हिन्दी', 'hi'],
  ['ヒンディー語', 'hi'],
  ['thai', 'th'],
  ['ไทย', 'th'],
  ['タイ語', 'th'],
  ['vietnamese', 'vi'],
  ['tiếng việt', 'vi'],
  ['ベトナム語', 'vi'],
  ['indonesian', 'id'],
  ['bahasa indonesia', 'id'],
  ['インドネシア語', 'id']
]);

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function nonNegativeInteger(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function primaryLanguageTag(value) {
  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  if (LANGUAGE_ALIASES.has(normalized)) {
    return LANGUAGE_ALIASES.get(normalized);
  }
  const primary = normalized.split('-')[0];
  if (LANGUAGE_ALIASES.has(primary)) {
    return LANGUAGE_ALIASES.get(primary);
  }
  return /^[a-z]{2,3}$/u.test(primary) ? primary : null;
}

export function normalizeInterpreterLanguage(value, fallback = null) {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }
  return primaryLanguageTag(value) ?? fallback;
}

function normalizePendingCandidate(value) {
  const language = normalizeInterpreterLanguage(value?.language);
  if (!language) {
    return null;
  }
  return {
    language,
    count: Math.max(1, nonNegativeInteger(value?.count, 1)),
    firstSeenAt: nonNegativeInteger(value?.firstSeenAt ?? value?.first_seen_at, 0),
    lastSeenAt: nonNegativeInteger(value?.lastSeenAt ?? value?.last_seen_at, 0)
  };
}

export function createInterpreterState(value = {}) {
  const anchorLanguage = normalizeInterpreterLanguage(
    value?.anchorLanguage ?? value?.anchor_language
  );
  let partnerLanguage = normalizeInterpreterLanguage(
    value?.partnerLanguage ?? value?.partner_language
  );
  if (partnerLanguage === anchorLanguage) {
    partnerLanguage = null;
  }
  return {
    anchorLanguage,
    partnerLanguage,
    revision: nonNegativeInteger(value?.revision, 0),
    pendingLanguageCandidate: normalizePendingCandidate(
      value?.pendingLanguageCandidate ?? value?.pending_language_candidate
    )
  };
}

function languageEvidenceIsStrong(evidence, options) {
  const confidence = Number.isFinite(evidence?.confidence) ? Number(evidence.confidence) : null;
  const tagObserved = evidence?.tagObserved === true || evidence?.tag_observed === true;
  const speechMs = nonNegativeInteger(evidence?.speechMs ?? evidence?.speech_ms, 0);
  const graphemes = nonNegativeInteger(
    evidence?.contentGraphemeCount ?? evidence?.content_grapheme_count,
    0
  );
  return (
    (confidence !== null && confidence >= options.confidenceMin)
    || (tagObserved && speechMs >= options.switchMinMs)
    || (tagObserved && graphemes >= options.switchMinGraphemes)
  );
}

function makeCandidate(language, nowMs, previous, repeatWindowMs) {
  if (
    previous
    && previous.language === language
    && nowMs - previous.lastSeenAt <= repeatWindowMs
  ) {
    return {
      language,
      count: previous.count + 1,
      firstSeenAt: previous.firstSeenAt,
      lastSeenAt: nowMs
    };
  }
  return {
    language,
    count: 1,
    firstSeenAt: nowMs,
    lastSeenAt: nowMs
  };
}

export function resolveInterpreterTurnState(input = {}, overrides = {}) {
  const options = {
    confidenceMin: Number.isFinite(overrides.confidenceMin)
      ? Number(overrides.confidenceMin)
      : DEFAULT_CONFIDENCE_MIN,
    switchMinMs: nonNegativeInteger(overrides.switchMinMs, DEFAULT_SWITCH_MIN_MS),
    switchMinGraphemes: nonNegativeInteger(
      overrides.switchMinGraphemes,
      DEFAULT_SWITCH_MIN_GRAPHEMES
    ),
    repeatWindowMs: nonNegativeInteger(
      overrides.repeatWindowMs,
      DEFAULT_REPEAT_WINDOW_MS
    )
  };
  const current = createInterpreterState(input.currentState ?? input.current_state ?? {});
  const sourceLanguage = normalizeInterpreterLanguage(
    input.sourceLanguage ?? input.source_language
  );
  const requestedTargetLanguage = normalizeInterpreterLanguage(
    input.requestedTargetLanguage ?? input.requested_target_language
  );
  const commandOnly = input.commandOnly === true || input.command_only === true;
  const contentText = asNonEmptyString(input.contentText ?? input.content_text) ?? '';
  const hasContent = !commandOnly && contentText !== '';
  const nowMs = nonNegativeInteger(input.nowMs ?? input.now_ms, Date.now());
  const warnings = [];

  if (!sourceLanguage) {
    return {
      sourceLanguage: null,
      requestedTargetLanguage,
      targetLanguage: null,
      proposedState: current,
      warnings: ['source_language_required'],
      pairChanged: false
    };
  }

  let anchorLanguage = current.anchorLanguage;
  let partnerLanguage = current.partnerLanguage;
  let pendingLanguageCandidate = current.pendingLanguageCandidate;

  if (!anchorLanguage) {
    anchorLanguage = sourceLanguage;
    if (requestedTargetLanguage && requestedTargetLanguage !== anchorLanguage) {
      partnerLanguage = requestedTargetLanguage;
    } else if (anchorLanguage !== 'en') {
      partnerLanguage = 'en';
    } else {
      partnerLanguage = null;
    }
    pendingLanguageCandidate = null;
  }

  if (requestedTargetLanguage) {
    if (requestedTargetLanguage === anchorLanguage) {
      if (sourceLanguage !== anchorLanguage) {
        partnerLanguage = sourceLanguage;
      }
    } else {
      partnerLanguage = requestedTargetLanguage;
    }
    pendingLanguageCandidate = null;
  }

  const knownLanguage =
    sourceLanguage === anchorLanguage
    || (partnerLanguage && sourceLanguage === partnerLanguage);
  let thirdLanguageAccepted = false;
  if (!requestedTargetLanguage && !knownLanguage) {
    if (!partnerLanguage || languageEvidenceIsStrong(input.languageEvidence, options)) {
      partnerLanguage = sourceLanguage;
      pendingLanguageCandidate = null;
      thirdLanguageAccepted = true;
    } else {
      const candidate = makeCandidate(
        sourceLanguage,
        nowMs,
        pendingLanguageCandidate,
        options.repeatWindowMs
      );
      if (candidate.count >= 2) {
        partnerLanguage = sourceLanguage;
        pendingLanguageCandidate = null;
        thirdLanguageAccepted = true;
      } else {
        pendingLanguageCandidate = candidate;
        warnings.push('language_uncertain');
      }
    }
  } else if (knownLanguage) {
    pendingLanguageCandidate = null;
  }

  let targetLanguage = null;
  if (hasContent && !warnings.includes('language_uncertain')) {
    if (requestedTargetLanguage && requestedTargetLanguage !== sourceLanguage) {
      targetLanguage = requestedTargetLanguage;
    } else if (requestedTargetLanguage === sourceLanguage) {
      warnings.push('target_same_as_source');
    } else if (sourceLanguage === anchorLanguage) {
      targetLanguage = partnerLanguage;
    } else if (sourceLanguage === partnerLanguage || thirdLanguageAccepted) {
      targetLanguage = anchorLanguage;
    }
  }

  if (hasContent && !targetLanguage && warnings.length === 0) {
    warnings.push('target_required');
  }

  const proposedState = createInterpreterState({
    anchorLanguage,
    partnerLanguage,
    revision: current.revision,
    pendingLanguageCandidate
  });
  const pairChanged =
    proposedState.anchorLanguage !== current.anchorLanguage
    || proposedState.partnerLanguage !== current.partnerLanguage;

  return {
    sourceLanguage,
    requestedTargetLanguage,
    targetLanguage,
    proposedState,
    warnings,
    pairChanged
  };
}

function normalizeSessionId(value) {
  return asNonEmptyString(value) ?? 'interpreter';
}

function normalizeTurnId(value) {
  return asNonEmptyString(value);
}

export function createInterpreterSessionStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ttlMs = Number.isFinite(options.ttlMs)
    ? Math.max(1_000, Math.floor(options.ttlMs))
    : DEFAULT_SESSION_TTL_MS;
  const maxCachedTurns = Number.isFinite(options.maxCachedTurns)
    ? Math.max(1, Math.floor(options.maxCachedTurns))
    : DEFAULT_TURN_CACHE_SIZE;
  const sessions = new Map();
  const locks = new Map();

  function prune(atMs = now()) {
    for (const [sessionId, entry] of sessions) {
      if (atMs - entry.updatedAt > ttlMs) {
        sessions.delete(sessionId);
      }
    }
  }

  function ensure(sessionId) {
    prune();
    const key = normalizeSessionId(sessionId);
    let entry = sessions.get(key);
    if (!entry) {
      entry = {
        state: createInterpreterState(),
        turns: new Map(),
        latestTurn: null,
        updatedAt: now()
      };
      sessions.set(key, entry);
    }
    entry.updatedAt = now();
    return { key, entry };
  }

  function snapshot(sessionId) {
    const { entry } = ensure(sessionId);
    return createInterpreterState(entry.state);
  }

  function cachedTurn(sessionId, turnId) {
    const normalized = normalizeTurnId(turnId);
    if (!normalized) {
      return null;
    }
    const { entry } = ensure(sessionId);
    return entry.turns.get(normalized) ?? null;
  }

  function latestTurn(sessionId) {
    const { entry } = ensure(sessionId);
    return entry.latestTurn;
  }

  function isVisibleSpeechTurn(response) {
    return (
      response?.manual !== true
      && response?.reset !== true
      && normalizeTurnId(response?.turnId) !== null
      && typeof response?.transcript === 'string'
    );
  }

  function commit(sessionId, proposedState, turnId, response) {
    const { entry } = ensure(sessionId);
    const current = createInterpreterState(entry.state);
    const next = createInterpreterState(proposedState);
    const pairChanged =
      current.anchorLanguage !== next.anchorLanguage
      || current.partnerLanguage !== next.partnerLanguage;
    entry.state = createInterpreterState({
      ...next,
      revision: current.revision + (pairChanged ? 1 : 0)
    });
    entry.updatedAt = now();

    const normalized = normalizeTurnId(turnId);
    let cachedResponse = response;
    if (normalized && response) {
      cachedResponse = Object.freeze({
        ...response,
        state: createInterpreterState(entry.state)
      });
      entry.turns.delete(normalized);
      entry.turns.set(normalized, cachedResponse);
      if (isVisibleSpeechTurn(cachedResponse)) {
        entry.latestTurn = cachedResponse;
      }
      while (entry.turns.size > maxCachedTurns) {
        entry.turns.delete(entry.turns.keys().next().value);
      }
    }
    return {
      state: createInterpreterState(entry.state),
      response: cachedResponse,
      pairChanged
    };
  }

  function remember(sessionId, turnId, response) {
    const normalized = normalizeTurnId(turnId);
    if (!normalized || !response) {
      return response;
    }
    const { entry } = ensure(sessionId);
    const cachedResponse = Object.freeze({
      ...response,
      state: createInterpreterState(entry.state)
    });
    entry.turns.delete(normalized);
    entry.turns.set(normalized, cachedResponse);
    if (isVisibleSpeechTurn(cachedResponse)) {
      entry.latestTurn = cachedResponse;
    }
    while (entry.turns.size > maxCachedTurns) {
      entry.turns.delete(entry.turns.keys().next().value);
    }
    return cachedResponse;
  }

  function reset(sessionId, turnId = null) {
    const { entry } = ensure(sessionId);
    const normalized = normalizeTurnId(turnId);
    if (normalized && entry.turns.has(normalized)) {
      return entry.turns.get(normalized);
    }
    const revision = entry.state.revision + 1;
    entry.state = createInterpreterState({ revision });
    entry.latestTurn = null;
    // Reset is also the explicit privacy boundary for this volatile session:
    // discard every prior idempotency response before remembering the reset.
    entry.turns.clear();
    entry.updatedAt = now();
    const response = Object.freeze({
      ok: true,
      reset: true,
      state: createInterpreterState(entry.state)
    });
    if (normalized) {
      entry.turns.set(normalized, response);
    }
    return response;
  }

  async function runExclusive(sessionId, callback) {
    const key = normalizeSessionId(sessionId);
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => {}).then(() => gate);
    locks.set(key, next);
    await previous.catch(() => {});
    try {
      return await callback({
        state: snapshot(key),
        cachedTurn: (turnId) => cachedTurn(key, turnId),
        commit: (proposedState, turnId, response) =>
          commit(key, proposedState, turnId, response),
        remember: (turnId, response) => remember(key, turnId, response),
        reset: (turnId) => reset(key, turnId)
      });
    } finally {
      release();
      if (locks.get(key) === next) {
        locks.delete(key);
      }
    }
  }

  return {
    snapshot,
    cachedTurn,
    latestTurn,
    commit,
    remember,
    reset,
    runExclusive,
    prune,
    size() {
      prune();
      return sessions.size;
    }
  };
}

export function commitInterpreterTurn(store, result, turnId, sessionId = 'interpreter') {
  if (!store || typeof store.commit !== 'function') {
    throw new TypeError('interpreter session store is required');
  }
  return store.commit(sessionId, result.proposedState, turnId, result.response);
}

export const INTERPRETER_STATE_DEFAULTS = Object.freeze({
  confidenceMin: DEFAULT_CONFIDENCE_MIN,
  switchMinMs: DEFAULT_SWITCH_MIN_MS,
  switchMinGraphemes: DEFAULT_SWITCH_MIN_GRAPHEMES,
  repeatWindowMs: DEFAULT_REPEAT_WINDOW_MS
});
