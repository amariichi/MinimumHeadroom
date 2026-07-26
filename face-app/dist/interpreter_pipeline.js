import {
  createInterpreterSessionStore,
  createInterpreterState,
  normalizeInterpreterLanguage,
  resolveInterpreterTurnState
} from './interpreter_state.js';
import { resolveInterpreterAudioEndpoint } from './interpreter_audio_route.js';
import {
  createInterpreterPairAnnouncements
} from './interpreter_pair_announcement.js';

const TARGET_LANGUAGE_PROMPT_TEXT = 'What language should I translate into?';
const PAIR_ANNOUNCEMENT_PURPOSE = 'language_pair_announcement';

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toLogger(log) {
  if (!log) {
    return { info: () => {}, warn: () => {}, error: () => {} };
  }
  return {
    info: typeof log.info === 'function' ? log.info.bind(log) : () => {},
    warn: typeof log.warn === 'function' ? log.warn.bind(log) : () => {},
    error: typeof log.error === 'function' ? log.error.bind(log) : () => {}
  };
}

function publicState(value) {
  const state = createInterpreterState(value);
  return {
    anchorLanguage: state.anchorLanguage,
    partnerLanguage: state.partnerLanguage,
    revision: state.revision
  };
}

function publicTurn(value) {
  const turnId = asNonEmptyString(value?.turnId);
  if (!turnId || typeof value?.transcript !== 'string') {
    return null;
  }
  const tts = value?.tts && typeof value.tts === 'object'
    ? {
        status: asNonEmptyString(value.tts.status) ?? 'unknown',
        ...(asNonEmptyString(value.tts.purpose)
          ? { purpose: value.tts.purpose.trim() }
          : {}),
        ...(asNonEmptyString(value.tts.language)
          ? { language: value.tts.language.trim() }
          : {}),
        ...(asNonEmptyString(value.tts.audioEndpoint)
          ? { audioEndpoint: value.tts.audioEndpoint.trim() }
          : {}),
        ...(asNonEmptyString(value.tts.reason)
          ? { reason: value.tts.reason.trim() }
          : {})
      }
    : null;
  return {
    turnId,
    transcript: value.transcript,
    contentText: typeof value.contentText === 'string' ? value.contentText : '',
    sourceLanguage: normalizeInterpreterLanguage(value.sourceLanguage),
    targetLanguage: normalizeInterpreterLanguage(value.targetLanguage),
    translation: typeof value.translation === 'string' ? value.translation : '',
    commandOnly: value.commandOnly === true,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((warning) => typeof warning === 'string')
      : [],
    audioEndpoint: asNonEmptyString(value.audioEndpoint),
    state: publicState(value.state),
    ...(tts ? { tts } : {})
  };
}

function normalizeAsrResult(value) {
  const transcript = asNonEmptyString(value?.text ?? value?.transcript);
  const language = normalizeInterpreterLanguage(value?.language ?? value?.sourceLanguage);
  if (!transcript || !language) {
    throw new InterpreterPipelineError(
      'asr_invalid_response',
      502,
      'ASR did not return transcript and language'
    );
  }
  const evidence = value?.languageEvidence ?? value?.language_evidence ?? {};
  return {
    transcript,
    sourceLanguage: language,
    locale: asNonEmptyString(value?.locale),
    confidence: Number.isFinite(value?.confidence) ? Number(value.confidence) : null,
    languageEvidence: {
      tagObserved: evidence.tagObserved === true || evidence.tag_observed === true,
      confidence: Number.isFinite(evidence.confidence)
        ? Number(evidence.confidence)
        : Number.isFinite(value?.confidence)
          ? Number(value.confidence)
          : null,
      speechMs: Number.isFinite(evidence.speechMs ?? evidence.speech_ms)
        ? Math.max(0, Math.floor(evidence.speechMs ?? evidence.speech_ms))
        : 0,
      contentGraphemeCount: Number.isFinite(
        evidence.contentGraphemeCount ?? evidence.content_grapheme_count
      )
        ? Math.max(
          0,
          Math.floor(evidence.contentGraphemeCount ?? evidence.content_grapheme_count)
        )
        : [...transcript].length,
      provider: asNonEmptyString(evidence.provider),
      fallbackFrom: asNonEmptyString(
        evidence.fallbackFrom ?? evidence.fallback_from
      ),
      fallbackReason: asNonEmptyString(
        evidence.fallbackReason ?? evidence.fallback_reason
      )
    },
    providerContext: value?.providerContext ?? value?.provider_context ?? null
  };
}

function normalizeIntentResult(value, transcript) {
  if (!value || typeof value !== 'object') {
    return {
      contentText: transcript,
      requestedTargetLanguage: null,
      commandOnly: false,
      providerContext: null
    };
  }
  const commandOnly = value.commandOnly === true || value.command_only === true;
  const requestedTargetLanguage = normalizeInterpreterLanguage(
    value.requestedTargetLanguage ?? value.requested_target_language
  );
  const contentText = commandOnly
    ? ''
    : asNonEmptyString(value.contentText ?? value.content_text) ?? transcript;
  if (commandOnly && !requestedTargetLanguage) {
    throw new InterpreterPipelineError(
      'intent_invalid_response',
      502,
      'Command-only intent requires a target language'
    );
  }
  return {
    contentText,
    requestedTargetLanguage,
    commandOnly,
    providerContext: value.providerContext ?? value.provider_context ?? null
  };
}

function normalizeTranslationResult(value) {
  const translation = asNonEmptyString(
    typeof value === 'string' ? value : value?.translation ?? value?.text
  );
  if (!translation) {
    throw new InterpreterPipelineError(
      'translation_invalid_response',
      502,
      'Translation provider returned empty text'
    );
  }
  return translation;
}

function pairAnnouncementEligibility({
  previousState,
  committedState,
  pairChanged,
  requestedTargetLanguage
}) {
  if (!pairChanged) {
    return { eligible: false, reason: 'pair_unchanged' };
  }
  if (!committedState.anchorLanguage || !committedState.partnerLanguage) {
    return { eligible: false, reason: 'pair_incomplete' };
  }
  if (!previousState.anchorLanguage && !requestedTargetLanguage) {
    return { eligible: false, reason: 'initial_implicit_pair' };
  }
  return { eligible: true, reason: null };
}

export class InterpreterPipelineError extends Error {
  constructor(code, statusCode = 500, message = code, details = null) {
    super(message);
    this.name = 'InterpreterPipelineError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function createInterpreterPipeline(options = {}) {
  const asr = options.asr;
  const intent = options.intent;
  const translation = options.translation;
  const tts = options.tts ?? null;
  const store = options.store ?? createInterpreterSessionStore();
  const atomRegistry = options.atomRegistry ?? null;
  const broadcast = typeof options.broadcast === 'function' ? options.broadcast : () => false;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const log = toLogger(options.log ?? console);
  const resolverOptions = options.resolverOptions ?? {};
  const supportedPairLanguages = new Set(
    (Array.isArray(options.supportedPairLanguages)
      ? options.supportedPairLanguages
      : []
    )
      .map((language) => normalizeInterpreterLanguage(language))
      .filter(Boolean)
  );
  const inFlight = new Map();

  if (!asr || typeof asr.transcribe !== 'function') {
    throw new TypeError('interpreter ASR provider must implement transcribe()');
  }
  if (!intent || typeof intent.analyze !== 'function') {
    throw new TypeError('interpreter intent provider must implement analyze()');
  }
  if (!translation || typeof translation.translate !== 'function') {
    throw new TypeError('interpreter translation provider must implement translate()');
  }

  function emit(type, payload) {
    broadcast({
      v: 1,
      type,
      ts: now(),
      ...payload
    });
  }

  async function enqueuePairAnnouncement({
    sessionId,
    turnId,
    audioEndpoint,
    previousState,
    committedState,
    pairChanged,
    requestedTargetLanguage
  }) {
    const eligibility = pairAnnouncementEligibility({
      previousState,
      committedState,
      pairChanged,
      requestedTargetLanguage
    });
    const base = {
      status: 'skipped',
      reason: eligibility.reason,
      revision: committedState.revision,
      audioEndpoint,
      queuedCount: 0,
      utterances: []
    };
    if (!eligibility.eligible) {
      return base;
    }

    const announcements = createInterpreterPairAnnouncements(committedState);
    if (announcements.length !== 2) {
      return {
        ...base,
        reason: 'announcement_unavailable'
      };
    }

    if (!tts || typeof tts.enqueue !== 'function') {
      const result = {
        ...base,
        status: 'disabled',
        reason: 'tts_disabled',
        utterances: announcements.map((entry) => ({
          ...entry,
          status: 'disabled'
        }))
      };
      emit('interpreter_pair_announcement', {
        sessionId,
        turnId,
        state: committedState,
        ...result
      });
      return result;
    }

    const utterances = [];
    let queuedCount = 0;
    for (const [index, announcement] of announcements.entries()) {
      try {
        const enqueueResult = await tts.enqueue({
          text: announcement.text,
          language: announcement.language,
          sessionId,
          turnId,
          audioEndpoint,
          purpose: PAIR_ANNOUNCEMENT_PURPOSE,
          queueMode: queuedCount > 0 ? 'append' : 'replace',
          sequenceIndex: index,
          sequenceCount: announcements.length
        });
        const unsupported = enqueueResult?.accepted === false
          && enqueueResult?.reason === 'unsupported_language';
        const accepted = enqueueResult?.accepted !== false;
        if (accepted) {
          queuedCount += 1;
        } else {
          log.warn(
            `[interpreter] pair announcement rejected language=${announcement.language}`
            + ` reason=${enqueueResult?.reason ?? 'tts_rejected'}`
          );
        }
        utterances.push({
          ...announcement,
          status: accepted ? 'queued' : unsupported ? 'unsupported' : 'failed',
          ...(Number.isInteger(enqueueResult?.generation)
            ? { generation: enqueueResult.generation }
            : {}),
          ...(asNonEmptyString(enqueueResult?.reason)
            ? { reason: enqueueResult.reason }
            : {})
        });
      } catch (error) {
        log.warn(
          `[interpreter] pair announcement enqueue failed`
          + ` language=${announcement.language}: ${error.message}`
        );
        utterances.push({
          ...announcement,
          status: 'failed',
          reason: 'tts_enqueue_failed'
        });
      }
    }

    const statuses = utterances.map((entry) => entry.status);
    const status = queuedCount === utterances.length
      ? 'queued'
      : queuedCount > 0
        ? 'partial'
        : statuses.every((value) => value === 'unsupported')
          ? 'unsupported'
          : 'failed';
    const result = {
      status,
      reason: status === 'queued' ? null : 'announcement_incomplete',
      revision: committedState.revision,
      audioEndpoint,
      queuedCount,
      utterances
    };
    emit('interpreter_pair_announcement', {
      sessionId,
      turnId,
      state: committedState,
      ...result
    });
    return result;
  }

  async function runTurn(input) {
    const sessionId = asNonEmptyString(input.sessionId) ?? 'interpreter';
    const turnId = asNonEmptyString(input.turnId);
    if (!turnId) {
      throw new InterpreterPipelineError('turn_id_required', 400);
    }
    const hasPreparedAsr = input.asrResult !== undefined && input.asrResult !== null;
    const audio = Buffer.isBuffer(input.audio) ? input.audio : Buffer.from(input.audio ?? []);
    if (!hasPreparedAsr && audio.length === 0) {
      throw new InterpreterPipelineError('empty_audio', 400);
    }
    const inputSource = input.inputSource === 'atom' ? 'atom' : 'browser';
    const atomPresence = atomRegistry?.getPresence?.() ?? { connected: false };
    const audioEndpoint = resolveInterpreterAudioEndpoint({ inputSource, atomPresence });

    return store.runExclusive(sessionId, async (session) => {
      const cached = session.cachedTurn(turnId);
      if (cached) {
        if (cached.manual === true) {
          throw new InterpreterPipelineError('turn_id_conflict', 409);
        }
        return {
          ...cached,
          duplicate: true
        };
      }

      emit('interpreter_turn_started', {
        sessionId,
        turnId,
        audioEndpoint
      });

      let asrResult;
      try {
        asrResult = hasPreparedAsr
          ? normalizeAsrResult(input.asrResult)
          : normalizeAsrResult(await asr.transcribe(audio, {
              languageHint: 'auto',
              mimeType: input.mimeType ?? 'audio/wav',
              speechMs: Number.isFinite(input.speechMs)
                ? Math.max(0, Math.floor(input.speechMs))
                : 0,
              sessionSnapshot: publicState(session.state),
              sessionId,
              turnId
            }));
      } catch (error) {
        if (inputSource === 'atom' && error?.code === 'asr_unusable_result') {
          const ignored = session.remember(turnId, {
            ok: true,
            ignored: true,
            reason: 'asr_unusable_result',
            turnId,
            audioEndpoint,
            state: publicState(session.state)
          });
          emit('interpreter_turn_ignored', {
            sessionId,
            turnId,
            stage: 'asr',
            reason: ignored.reason,
            audioEndpoint
          });
          return ignored;
        }
        const normalized = error instanceof InterpreterPipelineError
          ? error
          : new InterpreterPipelineError('asr_failed', 502, error.message);
        emit('interpreter_turn_failed', {
          sessionId,
          turnId,
          stage: 'asr',
          error: normalized.code
        });
        throw normalized;
      }

      emit('interpreter_transcript', {
        sessionId,
        turnId,
        transcript: asrResult.transcript,
        sourceLanguage: asrResult.sourceLanguage
      });
      if (asrResult.languageEvidence.fallbackFrom) {
        emit('interpreter_asr_fallback', {
          sessionId,
          turnId,
          from: asrResult.languageEvidence.fallbackFrom,
          to: asrResult.languageEvidence.provider,
          reason: asrResult.languageEvidence.fallbackReason,
          audioEndpoint
        });
      }

      let intentResult;
      try {
        intentResult = normalizeIntentResult(await intent.analyze({
          transcript: asrResult.transcript,
          sourceLanguage: asrResult.sourceLanguage,
          sessionSnapshot: publicState(session.state),
          providerContext: asrResult.providerContext,
          sessionId,
          turnId
        }), asrResult.transcript);
      } catch (error) {
        const normalized = error instanceof InterpreterPipelineError
          ? error
          : new InterpreterPipelineError('intent_failed', 502, error.message);
        emit('interpreter_turn_failed', {
          sessionId,
          turnId,
          stage: 'intent',
          error: normalized.code
        });
        throw normalized;
      }

      const previousState = publicState(session.state);
      const resolved = resolveInterpreterTurnState({
        currentState: session.state,
        sourceLanguage: asrResult.sourceLanguage,
        requestedTargetLanguage: intentResult.requestedTargetLanguage,
        contentText: intentResult.contentText,
        commandOnly: intentResult.commandOnly,
        languageEvidence: asrResult.languageEvidence,
        nowMs: now()
      }, resolverOptions);
      const noTranslation =
        intentResult.commandOnly
        || !resolved.targetLanguage
        || resolved.warnings.includes('language_uncertain');

      if (noTranslation) {
        const shouldPromptForTarget =
          audioEndpoint === 'atom'
          && asrResult.sourceLanguage === 'en'
          && session.state.anchorLanguage === null
          && resolved.warnings.includes('target_required');
        const committed = session.commit(resolved.proposedState, null, null);
        const committedState = publicState(committed.state);
        if (committed.pairChanged) {
          emit('interpreter_state_changed', {
            sessionId,
            turnId,
            state: committedState
          });
        }

        const pairAnnouncement = await enqueuePairAnnouncement({
          sessionId,
          turnId,
          audioEndpoint,
          previousState,
          committedState,
          pairChanged: committed.pairChanged,
          requestedTargetLanguage: intentResult.requestedTargetLanguage
        });
        let ttsResult = { status: 'skipped', audioEndpoint };
        if (shouldPromptForTarget) {
          const promptBase = {
            purpose: 'target_language_prompt',
            language: 'en',
            audioEndpoint
          };
          if (!tts || typeof tts.enqueue !== 'function') {
            ttsResult = { status: 'disabled', ...promptBase };
          } else {
            try {
              const result = await tts.enqueue({
                text: TARGET_LANGUAGE_PROMPT_TEXT,
                language: 'en',
                sessionId,
                turnId,
                audioEndpoint,
                purpose: promptBase.purpose
              });
              const unsupported = result?.accepted === false
                && result?.reason === 'unsupported_language';
              ttsResult = {
                status: unsupported
                  ? 'unsupported'
                  : result?.accepted === false
                    ? 'failed'
                    : 'queued',
                ...promptBase,
                ...(Number.isInteger(result?.generation)
                  ? { generation: result.generation }
                  : {}),
                ...(asNonEmptyString(result?.reason) ? { reason: result.reason } : {})
              };
              if (result?.accepted === false) {
                emit(unsupported ? 'interpreter_tts_unsupported' : 'interpreter_tts_failed', {
                  sessionId,
                  turnId,
                  error: result.reason ?? 'tts_rejected',
                  audioEndpoint,
                  purpose: promptBase.purpose
                });
              }
            } catch (error) {
              log.warn(`[interpreter] target-language prompt enqueue failed: ${error.message}`);
              ttsResult = {
                status: 'failed',
                reason: 'tts_enqueue_failed',
                ...promptBase
              };
              emit('interpreter_tts_failed', {
                sessionId,
                turnId,
                error: 'tts_enqueue_failed',
                audioEndpoint,
                purpose: promptBase.purpose
              });
            }
          }
          emit('interpreter_target_prompt', {
            sessionId,
            turnId,
            text: TARGET_LANGUAGE_PROMPT_TEXT,
            language: 'en',
            audioEndpoint,
            tts: ttsResult
          });
        }

        const baseResponse = {
          ok: true,
          turnId,
          transcript: asrResult.transcript,
          contentText: intentResult.contentText,
          sourceLanguage: asrResult.sourceLanguage,
          targetLanguage: null,
          translation: '',
          commandOnly: intentResult.commandOnly,
          warnings: [...resolved.warnings],
          audioEndpoint,
          pairAnnouncement,
          tts: ttsResult
        };
        const response = session.remember(turnId, {
          ...baseResponse,
          state: committedState
        });
        emit('interpreter_turn_completed', {
          sessionId,
          turnId
        });
        return response;
      }

      let translatedText;
      try {
        translatedText = normalizeTranslationResult(await translation.translate({
          contentText: intentResult.contentText,
          sourceLanguage: asrResult.sourceLanguage,
          targetLanguage: resolved.targetLanguage,
          sessionSnapshot: publicState(session.state),
          providerContext: intentResult.providerContext ?? asrResult.providerContext,
          forceFreshTranslation: (
            resolved.pairChanged
            && Boolean(intentResult.requestedTargetLanguage)
          ),
          sessionId,
          turnId
        }));
      } catch (error) {
        const normalized = error instanceof InterpreterPipelineError
          ? error
          : new InterpreterPipelineError('translation_failed', 502, error.message);
        emit('interpreter_turn_failed', {
          sessionId,
          turnId,
          stage: 'translation',
          error: normalized.code
        });
        throw normalized;
      }

      const committed = session.commit(resolved.proposedState, null, null);
      const committedState = publicState(committed.state);
      emit('interpreter_translation', {
        sessionId,
        turnId,
        translation: translatedText,
        sourceLanguage: asrResult.sourceLanguage,
        targetLanguage: resolved.targetLanguage,
        audioEndpoint
      });
      if (committed.pairChanged) {
        emit('interpreter_state_changed', {
          sessionId,
          turnId,
          state: committedState
        });
      }

      const pairAnnouncement = await enqueuePairAnnouncement({
        sessionId,
        turnId,
        audioEndpoint,
        previousState,
        committedState,
        pairChanged: committed.pairChanged,
        requestedTargetLanguage: intentResult.requestedTargetLanguage
      });
      let ttsResult = {
        status: tts && typeof tts.enqueue === 'function' ? 'queued' : 'disabled',
        language: resolved.targetLanguage,
        audioEndpoint
      };
      if (tts && typeof tts.enqueue === 'function') {
        try {
          const result = await tts.enqueue({
            text: translatedText,
            language: resolved.targetLanguage,
            sessionId,
            turnId,
            audioEndpoint,
            purpose: 'translation',
            queueMode: pairAnnouncement.queuedCount > 0 ? 'append' : 'replace'
          });
          const unsupported = result?.accepted === false
            && result?.reason === 'unsupported_language';
          ttsResult = {
            status: unsupported
              ? 'unsupported'
              : result?.accepted === false
                ? 'failed'
                : 'queued',
            language: resolved.targetLanguage,
            audioEndpoint,
            ...(Number.isInteger(result?.generation) ? { generation: result.generation } : {}),
            ...(asNonEmptyString(result?.reason) ? { reason: result.reason } : {})
          };
          if (result?.accepted === false) {
            emit(unsupported ? 'interpreter_tts_unsupported' : 'interpreter_tts_failed', {
              sessionId,
              turnId,
              error: result.reason ?? 'tts_rejected',
              audioEndpoint
            });
          }
        } catch (error) {
          log.warn(`[interpreter] TTS enqueue failed: ${error.message}`);
          ttsResult = {
            status: 'failed',
            reason: 'tts_enqueue_failed',
            language: resolved.targetLanguage,
            audioEndpoint
          };
          emit('interpreter_tts_failed', {
            sessionId,
            turnId,
            error: 'tts_enqueue_failed',
            audioEndpoint
          });
        }
      }

      const response = session.remember(turnId, {
        ok: true,
        turnId,
        transcript: asrResult.transcript,
        contentText: intentResult.contentText,
        sourceLanguage: asrResult.sourceLanguage,
        targetLanguage: resolved.targetLanguage,
        translation: translatedText,
        commandOnly: false,
        warnings: [...resolved.warnings],
        audioEndpoint,
        state: committedState,
        pairAnnouncement,
        tts: ttsResult
      });
      emit('interpreter_turn_completed', {
        sessionId,
        turnId
      });
      return response;
    });
  }

  async function runTranscription(input) {
    const sessionId = asNonEmptyString(input.sessionId) ?? 'interpreter';
    const turnId = asNonEmptyString(input.turnId);
    if (!turnId) {
      throw new InterpreterPipelineError('turn_id_required', 400);
    }
    const audio = Buffer.isBuffer(input.audio) ? input.audio : Buffer.from(input.audio ?? []);
    if (audio.length === 0) {
      throw new InterpreterPipelineError('empty_audio', 400);
    }
    try {
      return normalizeAsrResult(await asr.transcribe(audio, {
        languageHint: 'auto',
        mimeType: input.mimeType ?? 'audio/wav',
        speechMs: Number.isFinite(input.speechMs)
          ? Math.max(0, Math.floor(input.speechMs))
          : 0,
        sessionSnapshot: publicState(store.snapshot(sessionId)),
        sessionId,
        turnId
      }));
    } catch (error) {
      const normalized = error instanceof InterpreterPipelineError
        ? error
        : new InterpreterPipelineError('asr_failed', 502, error.message);
      emit('interpreter_turn_failed', {
        sessionId,
        turnId,
        stage: 'asr',
        error: normalized.code
      });
      throw normalized;
    }
  }

  async function runManualPair(input) {
    const sessionId = asNonEmptyString(input.sessionId) ?? 'interpreter';
    const turnId = asNonEmptyString(input.turnId);
    if (!turnId) {
      throw new InterpreterPipelineError('turn_id_required', 400);
    }
    const anchorLanguage = normalizeInterpreterLanguage(input.anchorLanguage);
    const partnerLanguage = normalizeInterpreterLanguage(input.partnerLanguage);
    if (!anchorLanguage) {
      throw new InterpreterPipelineError('anchor_language_required', 400);
    }
    if (!partnerLanguage) {
      throw new InterpreterPipelineError('partner_language_required', 400);
    }
    if (anchorLanguage === partnerLanguage) {
      throw new InterpreterPipelineError('pair_languages_must_differ', 422);
    }
    if (
      !supportedPairLanguages.has(anchorLanguage)
      || !supportedPairLanguages.has(partnerLanguage)
    ) {
      throw new InterpreterPipelineError('unsupported_pair_language', 422);
    }

    const inputSource = input.inputSource === 'atom' ? 'atom' : 'browser';
    const atomPresence = atomRegistry?.getPresence?.() ?? { connected: false };
    const audioEndpoint = resolveInterpreterAudioEndpoint({ inputSource, atomPresence });

    return store.runExclusive(sessionId, async (session) => {
      const cached = session.cachedTurn(turnId);
      if (cached) {
        if (cached.manual !== true) {
          throw new InterpreterPipelineError('turn_id_conflict', 409);
        }
        return {
          ...cached,
          duplicate: true
        };
      }

      const previousState = publicState(session.state);
      const committed = session.commit(createInterpreterState({
        anchorLanguage,
        partnerLanguage,
        revision: session.state.revision,
        pendingLanguageCandidate: null
      }), null, null);
      const committedState = publicState(committed.state);
      if (committed.pairChanged) {
        emit('interpreter_state_changed', {
          sessionId,
          turnId,
          state: committedState
        });
      }
      const pairAnnouncement = await enqueuePairAnnouncement({
        sessionId,
        turnId,
        audioEndpoint,
        previousState,
        committedState,
        pairChanged: committed.pairChanged,
        requestedTargetLanguage: partnerLanguage
      });
      return session.remember(turnId, {
        ok: true,
        manual: true,
        turnId,
        audioEndpoint,
        state: committedState,
        pairAnnouncement
      });
    });
  }

  async function runWithInFlight(kind, input, callback) {
    const sessionId = asNonEmptyString(input.sessionId) ?? 'interpreter';
    const turnId = asNonEmptyString(input.turnId);
    if (!turnId) {
      throw new InterpreterPipelineError('turn_id_required', 400);
    }
    const active = inFlight.get(sessionId);
    if (active) {
      if (active.kind === kind && active.turnId === turnId) {
        return active.promise;
      }
      throw new InterpreterPipelineError('turn_in_progress', 409);
    }
    const promise = callback({ ...input, sessionId, turnId });
    inFlight.set(sessionId, { kind, turnId, promise });
    try {
      return await promise;
    } finally {
      if (inFlight.get(sessionId)?.promise === promise) {
        inFlight.delete(sessionId);
      }
    }
  }

  async function processTurn(input = {}) {
    return runWithInFlight('audio_turn', input, runTurn);
  }

  async function transcribeAudio(input = {}) {
    return runWithInFlight('asr_only', input, runTranscription);
  }

  async function processRecognizedTurn(input = {}) {
    return runWithInFlight('recognized_turn', input, runTurn);
  }

  async function setSessionPair(input = {}) {
    return runWithInFlight('manual_pair', input, runManualPair);
  }

  function resetSession(sessionId, turnId) {
    return store.reset(sessionId, turnId);
  }

  function getSessionSnapshot(sessionId) {
    return {
      state: publicState(store.snapshot(sessionId)),
      latestTurn: typeof store.latestTurn === 'function'
        ? publicTurn(store.latestTurn(sessionId))
        : null
    };
  }

  return {
    processTurn,
    transcribeAudio,
    processRecognizedTurn,
    setSessionPair,
    resetSession,
    getSessionState: (sessionId) => publicState(store.snapshot(sessionId)),
    getSessionSnapshot,
    store
  };
}
