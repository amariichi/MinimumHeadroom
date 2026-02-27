function toLogger(log) {
  if (!log) {
    return { info: () => {}, warn: () => {}, error: () => {} };
  }
  return {
    info: typeof log.info === 'function' ? log.info.bind(log) : console.log.bind(console),
    warn: typeof log.warn === 'function' ? log.warn.bind(log) : console.warn.bind(console),
    error: typeof log.error === 'function' ? log.error.bind(log) : console.error.bind(console)
  };
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function normalizeLanguage(value, fallback = 'en') {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized.startsWith('ja')) {
    return 'ja';
  }
  if (normalized.startsWith('en')) {
    return 'en';
  }
  return fallback;
}

function normalizeAsrResult(payload, fallbackLanguage) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (typeof payload.text === 'string' && payload.text.trim() !== '') {
    return {
      text: payload.text.trim(),
      language: normalizeLanguage(payload.language, fallbackLanguage),
      confidence: Number.isFinite(payload.confidence) ? Number(payload.confidence) : null
    };
  }

  if (payload.transcript && typeof payload.transcript === 'object') {
    const transcript = payload.transcript;
    if (typeof transcript.text === 'string' && transcript.text.trim() !== '') {
      return {
        text: transcript.text.trim(),
        language: normalizeLanguage(transcript.language, fallbackLanguage),
        confidence: Number.isFinite(transcript.confidence) ? Number(transcript.confidence) : null
      };
    }
  }

  if (Array.isArray(payload.results) && payload.results.length > 0) {
    const first = payload.results[0];
    if (first && typeof first === 'object' && typeof first.text === 'string' && first.text.trim() !== '') {
      return {
        text: first.text.trim(),
        language: normalizeLanguage(first.language, fallbackLanguage),
        confidence: Number.isFinite(first.confidence) ? Number(first.confidence) : null
      };
    }
  }

  return null;
}

function readRequestBody(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    request.on('error', (error) => {
      reject(error);
    });
  });
}

function resolveUpstreamUrl(endpointUrl, baseUrl, language) {
  const explicitEndpoint = asNonEmptyString(endpointUrl);
  if (explicitEndpoint) {
    return new URL(explicitEndpoint);
  }

  const explicitBase = asNonEmptyString(baseUrl);
  if (!explicitBase) {
    return null;
  }

  const base = new URL(explicitBase);
  const pathPrefix = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  const pathSuffix = language === 'ja' ? '/v1/asr/ja' : '/v1/asr/en';
  base.pathname = `${pathPrefix}${pathSuffix}`.replace(/\/{2,}/g, '/');
  return base;
}

export function createOperatorAsrProxy(options = {}) {
  const log = toLogger(options.log ?? console);
  const endpointUrl = asNonEmptyString(options.endpointUrl);
  const baseUrl = asNonEmptyString(options.baseUrl);
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? Math.max(500, Math.floor(options.requestTimeoutMs)) : 20_000;
  const maxBodyBytes = Number.isFinite(options.maxBodyBytes) ? Math.max(1024, Math.floor(options.maxBodyBytes)) : 10 * 1024 * 1024;
  const modelEn = asNonEmptyString(options.modelEn);
  const modelJa = asNonEmptyString(options.modelJa);
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch API is unavailable for operator ASR proxy');
  }

  return {
    async handleHttpRequest(request, response) {
      const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (parsedUrl.pathname !== '/api/operator/asr') {
        return false;
      }

      if (request.method !== 'POST') {
        writeJson(response, 405, {
          ok: false,
          error: 'method_not_allowed'
        });
        return true;
      }

      const requestedLanguage = normalizeLanguage(
        parsedUrl.searchParams.get('lang') ?? parsedUrl.searchParams.get('languageHint') ?? 'en',
        'en'
      );
      const upstreamUrl = resolveUpstreamUrl(endpointUrl, baseUrl, requestedLanguage);
      if (!upstreamUrl) {
        writeJson(response, 503, {
          ok: false,
          error: 'asr_upstream_not_configured'
        });
        return true;
      }

      let audioBuffer;
      try {
        audioBuffer = await readRequestBody(request, maxBodyBytes);
      } catch (error) {
        writeJson(response, 413, {
          ok: false,
          error: 'payload_too_large',
          detail: error.message
        });
        return true;
      }

      const mimeTypeHeader = request.headers['content-type'];
      const mimeType = typeof mimeTypeHeader === 'string' && mimeTypeHeader.trim() !== '' ? mimeTypeHeader : 'application/octet-stream';

      const requestBody = {
        audioBase64: audioBuffer.toString('base64'),
        mimeType
      };

      if (requestedLanguage === 'ja' && modelJa) {
        requestBody.model = modelJa;
      } else if (requestedLanguage === 'en' && modelEn) {
        requestBody.model = modelEn;
      }

      let timer = null;
      const abortController = new AbortController();
      try {
        timer = setTimeout(() => {
          abortController.abort();
        }, requestTimeoutMs);

        const upstreamResponse = await fetchImpl(upstreamUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify(requestBody),
          signal: abortController.signal
        });

        const rawBody = await upstreamResponse.text();
        let parsedBody = null;
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = null;
        }

        if (!upstreamResponse.ok) {
          writeJson(response, 502, {
            ok: false,
            error: 'asr_upstream_error',
            status: upstreamResponse.status,
            detail: parsedBody ?? rawBody.slice(0, 300)
          });
          return true;
        }

        const normalized = normalizeAsrResult(parsedBody, requestedLanguage);
        if (!normalized) {
          writeJson(response, 502, {
            ok: false,
            error: 'asr_invalid_response',
            detail: parsedBody ?? rawBody.slice(0, 300)
          });
          return true;
        }

        writeJson(response, 200, {
          ok: true,
          text: normalized.text,
          language: normalized.language,
          confidence: normalized.confidence,
          route: 'operator_asr_proxy'
        });
        return true;
      } catch (error) {
        const isAbort = error?.name === 'AbortError';
        log.warn(`[face-app] operator ASR proxy request failed: ${error.message}`);
        writeJson(response, isAbort ? 504 : 502, {
          ok: false,
          error: isAbort ? 'asr_upstream_timeout' : 'asr_proxy_failed',
          detail: error.message
        });
        return true;
      } finally {
        if (timer !== null) {
          clearTimeout(timer);
        }
      }
    }
  };
}
