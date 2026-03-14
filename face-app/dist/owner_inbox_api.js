function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function createApiError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function parseInteger(value, fallback, minValue = Number.MIN_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed) || parsed < minValue) {
    return fallback;
  }
  return parsed;
}

function statusCodeFromError(error) {
  switch (error?.code) {
    case 'invalid_request':
    case 'invalid_json':
      return 400;
    case 'report_not_found':
    case 'stream_not_found':
      return 404;
    case 'not_authorized':
      return 403;
    default:
      return 500;
  }
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request, maxBodyBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(createApiError('invalid_request', 'request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(createApiError('invalid_json', 'request json body must be an object'));
          return;
        }
        resolve(parsed);
      } catch (error) {
        reject(createApiError('invalid_json', `invalid json body: ${error.message}`));
      }
    });

    request.on('error', (error) => {
      reject(createApiError('invalid_request', error.message, error));
    });
  });
}

export function createOwnerInboxApi(options = {}) {
  const store = options.store;
  if (!store || typeof store.getInboxView !== 'function') {
    throw new Error('store is required');
  }
  const maxBodyBytes = parseInteger(options.maxBodyBytes, 128 * 1024, 1024);
  const onSubmitReport = typeof options.onSubmitReport === 'function' ? options.onSubmitReport : null;

  return {
    async handleHttpRequest(request, response) {
      const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;
      if (!pathname.startsWith('/api/owner-inbox')) {
        return false;
      }

      try {
        if (pathname === '/api/owner-inbox/list') {
          if (request.method !== 'GET') {
            writeJson(response, 405, {
              ok: false,
              error: 'method_not_allowed'
            });
            return true;
          }
          const ownerAgentId = asNonEmptyString(parsedUrl.searchParams.get('owner_agent_id'));
          const streamId = asNonEmptyString(parsedUrl.searchParams.get('stream_id'));
          const includeResolved = parsedUrl.searchParams.get('include_resolved') === '1';
          const view = store.getInboxView({
            owner_agent_id: ownerAgentId,
            stream_id: streamId,
            include_resolved: includeResolved
          });
          writeJson(response, 200, {
            ok: true,
            state: view
          });
          return true;
        }

        if (pathname === '/api/owner-inbox/report') {
          if (request.method !== 'POST') {
            writeJson(response, 405, {
              ok: false,
              error: 'method_not_allowed'
            });
            return true;
          }
          const body = await readJsonBody(request, maxBodyBytes);
          const result = store.submitReport(body);
          if (onSubmitReport) {
            await onSubmitReport({
              request: body,
              result
            });
          }
          writeJson(response, 200, {
            ok: true,
            result
          });
          return true;
        }

        if (pathname === '/api/owner-inbox/resolve') {
          if (request.method !== 'POST') {
            writeJson(response, 405, {
              ok: false,
              error: 'method_not_allowed'
            });
            return true;
          }
          const body = await readJsonBody(request, maxBodyBytes);
          const result = store.updateReportLifecycle({
            stream_id: body.stream_id,
            report_id: body.report_id,
            action: body.action
          });
          writeJson(response, 200, {
            ok: true,
            result
          });
          return true;
        }

        if (pathname === '/api/owner-inbox/streams/close') {
          if (request.method !== 'POST') {
            writeJson(response, 405, {
              ok: false,
              error: 'method_not_allowed'
            });
            return true;
          }
          const body = await readJsonBody(request, maxBodyBytes);
          const result = store.closeStream({
            stream_id: body.stream_id,
            status: body.status
          });
          writeJson(response, 200, {
            ok: true,
            result
          });
          return true;
        }

        writeJson(response, 404, {
          ok: false,
          error: 'not_found'
        });
        return true;
      } catch (error) {
        writeJson(response, statusCodeFromError(error), {
          ok: false,
          error: error?.code ?? 'internal_error',
          detail: error?.message ?? 'unknown error'
        });
        return true;
      }
    }
  };
}
