function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

const UNUSABLE_TRANSCRIPT_DETAILS = new Set([
  'language_tag_missing',
  'terminal_language_tag_missing',
  'empty_transcript'
]);

function toLogger(log) {
  if (!log) {
    return { info: () => {}, warn: () => {} };
  }
  return {
    info: typeof log.info === 'function' ? log.info.bind(log) : () => {},
    warn: typeof log.warn === 'function' ? log.warn.bind(log) : () => {}
  };
}

function usableAsrResult(value) {
  return Boolean(
    asNonEmptyString(value?.text ?? value?.transcript)
    && asNonEmptyString(value?.language ?? value?.sourceLanguage)
  );
}

export function createNemotronAsrProvider(options = {}) {
  const baseUrl = asNonEmptyString(options.baseUrl) ?? 'http://127.0.0.1:8095';
  const endpointUrl = new URL('/v1/asr/auto', baseUrl);
  const healthUrl = new URL('/healthz', baseUrl);
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const fallbackAsr = options.fallbackAsr ?? null;
  const fallbackName = asNonEmptyString(fallbackAsr?.name) ?? 'fallback-asr';
  const log = toLogger(options.log);
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs)
    ? Math.max(1_000, Math.floor(options.requestTimeoutMs))
    : 45_000;

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch API is unavailable for Nemotron ASR');
  }

  async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'nemotron-3.5-asr',
    async transcribe(audio, requestOptions = {}) {
      try {
        const response = await fetchWithTimeout(endpointUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            audioBase64: audio.toString('base64'),
            mimeType: requestOptions.mimeType ?? 'audio/wav',
            language: 'auto'
          })
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          const detail = asNonEmptyString(payload?.detail);
          const error = new Error(
            `Nemotron ASR returned status ${response.status}${detail ? `: ${detail}` : ''}`
          );
          error.statusCode = response.status;
          error.detail = detail;
          if (response.status === 422 && UNUSABLE_TRANSCRIPT_DETAILS.has(detail)) {
            error.code = 'asr_unusable_result';
          }
          throw error;
        }
        if (!payload || typeof payload.text !== 'string' || typeof payload.language !== 'string') {
          throw new Error('Nemotron ASR returned an invalid response');
        }
        return payload;
      } catch (error) {
        if (error?.code !== 'asr_unusable_result' || !fallbackAsr) {
          throw error;
        }

        log.warn(
          `[interpreter] Nemotron ASR returned ${error.detail}; `
          + `retrying once with ${fallbackName}`
        );
        try {
          const fallbackResult = await fallbackAsr.transcribe(audio, requestOptions);
          if (!usableAsrResult(fallbackResult)) {
            throw new Error(`${fallbackName} returned an invalid ASR response`);
          }
          const fallbackEvidence = (
            fallbackResult.languageEvidence
            ?? fallbackResult.language_evidence
            ?? {}
          );
          log.info(
            `[interpreter] Nemotron ASR fallback succeeded with ${fallbackName}`
          );
          return {
            ...fallbackResult,
            languageEvidence: {
              ...fallbackEvidence,
              provider: fallbackName,
              fallbackFrom: 'nemotron-3.5-asr',
              fallbackReason: error.detail
            }
          };
        } catch (fallbackError) {
          error.fallbackAttempted = true;
          error.fallbackProvider = fallbackName;
          log.warn(
            `[interpreter] Nemotron ASR fallback failed with ${fallbackName}: `
            + `${fallbackError?.message ?? 'unknown error'}`
          );
          throw error;
        }
      }
    },
    async health() {
      try {
        const response = await fetchWithTimeout(healthUrl, { method: 'GET' });
        const payload = await response.json().catch(() => null);
        return {
          ready: response.ok && payload?.ok === true,
          revision: payload?.revision ?? null,
          offline: payload?.offline === true
        };
      } catch (error) {
        return {
          ready: false,
          error: error.name === 'AbortError' ? 'timeout' : 'unreachable'
        };
      }
    }
  };
}

export function createPassthroughIntentProvider() {
  return {
    name: 'passthrough-intent',
    async analyze(input) {
      return {
        contentText: input.transcript,
        requestedTargetLanguage: null,
        commandOnly: false
      };
    }
  };
}
