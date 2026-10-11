// Dashboard-only conditional reads. Full assignment history remains available to
// existing API callers; audio and the shared WebSocket have separate lifecycles.
export function createAssignmentDashboardReader(fetchImpl) {
  let cached = null;
  return async (streamId = null, { signal } = {}) => {
    const query = new URLSearchParams({ view: 'dashboard' });
    if (typeof streamId === 'string' && streamId.trim()) query.set('stream_id', streamId.trim());
    const url = `/api/agent-assignments/list?${query}`;
    const previous = cached?.url === url ? cached : null;
    const response = await fetchImpl(url, {
      method: 'GET', cache: 'no-store', signal,
      headers: previous?.etag ? { 'if-none-match': previous.etag } : {}
    });
    signal?.throwIfAborted();
    if (response.status === 304 && previous) return previous.state;
    if (!response.ok) throw new Error(`agent assignment request failed (${response.status})`);
    const payload = await response.json();
    signal?.throwIfAborted();
    if (payload?.ok !== true || !payload.state || typeof payload.state !== 'object') {
      throw new Error('agent assignment response is invalid');
    }
    cached = { url, etag: response.headers.get('etag'), state: payload.state };
    return cached.state;
  };
}

export function createDashboardRefreshLoop({ refresh, isVisible, intervalMs = 2400,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let active = null;
  let disposed = false;
  function clearScheduled() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule() {
    clearScheduled();
    if (disposed || !isVisible() || active) return;
    timer = setTimer(() => { timer = null; void run({ silentStatus: true }); }, intervalMs);
  }
  function run(options = {}) {
    if (disposed || !isVisible()) return Promise.resolve();
    if (active) return active.promise;
    clearScheduled();
    const request = { controller: new AbortController(), promise: null };
    active = request;
    request.promise = Promise.resolve().then(() => {
      request.controller.signal.throwIfAborted();
      return refresh({ ...options, signal: request.controller.signal });
    }).catch(error => {
      if (!request.controller.signal.aborted) throw error;
    }).finally(() => {
      if (active !== request) return;
      active = null;
      schedule();
    });
    return request.promise;
  }
  function pause() {
    clearScheduled();
    const old = active;
    active = null;
    old?.controller.abort();
  }
  return {
    refresh: run,
    visibilityChanged() { if (isVisible()) return run({ silentStatus: true }); pause(); },
    dispose() { disposed = true; pause(); }
  };
}
