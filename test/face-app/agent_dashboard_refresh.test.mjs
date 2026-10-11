import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssignmentDashboardReader, createDashboardRefreshLoop } from '../../face-app/public/agent_dashboard_refresh.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (state, etag = 'W/"a"') => new Response(JSON.stringify({ ok: true, state }), { headers: { etag } });

test('conditional dashboard cache is scoped, validates responses and does not cache aborted results', async () => {
  const calls = [];
  let next = response({ assignments: ['a'] });
  const read = createAssignmentDashboardReader(async (url, init) => { calls.push({ url, init }); return next; });
  const a = await read('a');
  next = new Response(null, { status: 304 });
  assert.equal(await read('a'), a);
  assert.equal(calls[1].init.headers['if-none-match'], 'W/"a"');
  await assert.rejects(read('b'), /304/);
  assert.deepEqual(calls[2].init.headers, {});
  const controller = new AbortController();
  next = response({ assignments: ['b'] }, 'W/"b"');
  controller.abort();
  await assert.rejects(read('a', { signal: controller.signal }), { name: 'AbortError' });
  next = new Response(null, { status: 304 });
  assert.equal(await read('a'), a);
  next = response({ assignments: ['updated'] }, 'W/"updated"');
  assert.deepEqual(await read('a'), { assignments: ['updated'] });
  next = new Response('{"ok":false}', { headers: { etag: 'bad' } });
  await assert.rejects(read('a'), /invalid/);
});

test('hidden refresh aborts once, foreground coalesces, old completion cannot schedule a duplicate timer', async () => {
  let visible = true;
  const pending = [], timers = new Map();
  let nextId = 0, calls = 0;
  const loop = createDashboardRefreshLoop({
    isVisible: () => visible,
    refresh: ({ signal }) => { calls++; return new Promise(resolve => pending.push({ signal, resolve })); },
    setTimer: (callback, delay) => { assert.equal(delay, 2400); timers.set(++nextId, callback); return nextId; },
    clearTimer: id => timers.delete(id)
  });
  const first = loop.refresh();
  assert.equal(loop.refresh(), first);
  await tick(); assert.equal(calls, 1);
  visible = false; loop.visibilityChanged();
  assert.equal(pending[0].signal.aborted, true);
  await loop.refresh(); assert.equal(calls, 1); assert.equal(timers.size, 0);
  visible = true; const second = loop.visibilityChanged();
  assert.equal(loop.refresh(), second);
  await tick(); assert.equal(calls, 2);
  pending[0].resolve(); await first; assert.equal(timers.size, 0);
  pending[1].resolve(); await second; assert.equal(timers.size, 1);
  const [id, callback] = [...timers][0]; timers.delete(id); callback(); await tick();
  assert.equal(calls, 3); assert.equal(timers.size, 0);
  loop.dispose(); assert.equal(pending[2].signal.aborted, true);
  pending[2].resolve(); await tick();
  await loop.refresh(); assert.equal(calls, 3); assert.equal(timers.size, 0);
});

test('an abort before deferred start and repeated visibility/focus do not leak polling', async () => {
  let visible = true, calls = 0;
  const timers = new Map();
  const loop = createDashboardRefreshLoop({ refresh: async () => { calls++; }, isVisible: () => visible,
    setTimer: cb => { timers.set(1, cb); return 1; }, clearTimer: id => timers.delete(id) });
  const request = loop.refresh(); visible = false; loop.visibilityChanged(); await request;
  assert.equal(calls, 0);
  visible = true;
  await Promise.all([loop.visibilityChanged(), loop.refresh(), loop.refresh()]);
  assert.equal(calls, 1); assert.equal(timers.size, 1);
  visible = false; loop.visibilityChanged(); assert.equal(timers.size, 0);
  loop.dispose();
});
