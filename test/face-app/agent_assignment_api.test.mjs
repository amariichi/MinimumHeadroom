import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { createAgentAssignmentStateStore } from '../../face-app/dist/agent_assignment_state.js';
import { createAgentAssignmentApi, renderAssignmentPrompt } from '../../face-app/dist/agent_assignment_api.js';

const quietLog = {
  info() {},
  warn() {},
  error() {}
};

function createTempStatePath(prefix) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    rootDir,
    statePath: path.join(rootDir, '.agent/runtime/agent-assignment-state.json')
  };
}

function createClock(start = 1_700_500_000_000) {
  let tick = start;
  return () => {
    tick += 29;
    return tick;
  };
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function createRequest({ method, url, body }) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  const stream = Readable.from(payload.length > 0 ? [payload] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = {
    'content-type': 'application/json; charset=utf-8'
  };
  return stream;
}

function createResponseCapture() {
  let statusCode = null;
  let headers = null;
  const chunks = [];

  return {
    writableEnded: false,
    writeHead(nextStatusCode, nextHeaders) {
      statusCode = nextStatusCode;
      headers = nextHeaders;
    },
    end(chunk = '') {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? '')));
      this.writableEnded = true;
    },
    snapshot() {
      const rawBytes = Buffer.concat(chunks);
      const rawBody = (headers?.['content-encoding'] === 'gzip' && rawBytes.length ? gunzipSync(rawBytes) : rawBytes).toString('utf8');
      return {
        statusCode,
        headers,
        rawBody,
        rawBytes,
        body: rawBody === '' ? null : JSON.parse(rawBody)
      };
    }
  };
}

test('renderAssignmentPrompt prepends helper bootstrap guidance for generated prompts', () => {
  const prompt = renderAssignmentPrompt({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-a',
    owner_agent_id: '__operator__',
    agent_id: 'helper-a',
    role: 'review',
    goal: 'Review the patch',
    constraints: 'Read only',
    target_paths: ['README.md', 'doc/examples/AGENT_RULES.md'],
    expected_output: 'Review findings',
    completion_criteria: 'Return one finding or done.',
    timebox_minutes: 3,
    max_findings: 1
  });

  assert.match(prompt, /Immediate protocol:/);
  assert.match(prompt, /Before reading repo files, skills, or running broad exploration/);
  assert.match(prompt, /kind=progress, summary='Mission accepted'/);
  assert.match(prompt, /inherit your helper identity from MH_FACE_AGENT_ID=helper-a/i);
  assert.match(prompt, /speech, mouth animation, and status stay attributed to you/i);
  assert.match(prompt, /include agent_id=helper-a manually/i);
  assert.match(prompt, /[Ii]nspect the target paths before optional skill lookup, slash commands, or unrelated repo exploration/);
  assert.match(prompt, /Send done or review_findings as soon as the current completion criteria are satisfied/);
  assert.match(prompt, /return the first qualifying finding immediately instead of hunting for more/);
  assert.match(prompt, /If no qualifying finding appears within the stated scope or timebox, send done with a short no-findings summary/);
  assert.match(prompt, /If max_findings is 1 or the completion criteria say "one finding or done", stop after the first qualifying result/);
  assert.match(prompt, /After your final done\/review_findings report, stop and wait for the owner/);
  assert.match(prompt, /Stream root: \/tmp\/target/);
  assert.match(prompt, /Target paths \(stream-root anchored\): \/tmp\/target\/README\.md, \/tmp\/target\/doc\/examples\/AGENT_RULES\.md/);
  assert.match(prompt, /Target paths are READ references; make all edits and commits inside the assigned worktree on the helper branch/);
  assert.match(prompt, /Completion criteria: Return one finding or done\./);
  assert.match(prompt, /Timebox minutes: 3/);
  assert.match(prompt, /Max findings this pass: 1/);
  assert.match(prompt, /Prefer returning one concrete result quickly/);
  assert.match(prompt, /Goal: Review the patch/);
});

test('renderAssignmentPrompt wraps explicit prompt_text with helper bootstrap guidance', () => {
  const prompt = renderAssignmentPrompt({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-b',
    owner_agent_id: '__operator__',
    agent_id: 'helper-b',
    goal: 'Implement the fix',
    prompt_text: 'Investigate the failure and patch the bug.'
  });

  assert.match(prompt, /^Owner assignment for helper agent helper-b\./);
  assert.match(prompt, /Immediate protocol:/);
  assert.match(prompt, /inherit your helper identity from MH_FACE_AGENT_ID=helper-b/i);
  assert.match(prompt, /speech, mouth animation, and status stay attributed to you/i);
  assert.match(prompt, /include agent_id=helper-b manually/i);
  assert.match(prompt, /[Ii]nspect the target paths before optional skill lookup, slash commands, or unrelated repo exploration/);
  assert.match(prompt, /Send done or review_findings as soon as the current completion criteria are satisfied/);
  assert.match(prompt, /return the first qualifying finding immediately instead of hunting for more/);
  assert.match(prompt, /send done with a short no-findings summary instead of lingering/);
  assert.match(prompt, /After your final done\/review_findings report, stop and wait for the owner/);
  assert.match(prompt, /If the scope is still ambiguous after the first report, send question/);
  assert.match(prompt, /Stream root: \/tmp\/target\./);
  assert.match(prompt, /Read the exact target path under the stream root even if it sits outside your helper worktree/);
  assert.match(prompt, /Target paths are READ references; make all edits and commits inside the assigned worktree on the helper branch/);
  assert.match(prompt, /Mission body:/);
  assert.match(prompt, /Investigate the failure and patch the bug\./);
});

test('renderAssignmentPrompt adds role-aware shaping for reviewer missions', () => {
  const prompt = renderAssignmentPrompt({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-review',
    owner_agent_id: '__operator__',
    agent_id: 'helper-review',
    role: 'review',
    goal: 'Review README quick start',
    target_paths: ['README.md'],
    completion_criteria: 'Return one finding or done.',
    max_findings: 1
  });

  assert.match(prompt, /Role: reviewer/);
  assert.match(prompt, /Reviewer role: stay read-only unless the owner explicitly asks for edits/);
  assert.match(prompt, /Prioritize one concrete correctness, regression, or documentation mismatch finding/);
});

test('renderAssignmentPrompt can render a bounded completion rescue follow-up', () => {
  const prompt = renderAssignmentPrompt({
    stream_id: 'repo:/tmp/target',
    mission_id: 'mission-followup',
    owner_agent_id: '__operator__',
    agent_id: 'helper-followup',
    role: 'docs-check',
    goal: 'Check the mermaid diagram',
    target_paths: ['README.md'],
    completion_criteria: 'Return one finding or done.',
    max_findings: 1,
    timebox_minutes: 3
  }, {
    followup_mode: 'completion_rescue'
  });

  assert.match(prompt, /^Owner follow-up for helper agent helper-followup\./);
  assert.match(prompt, /Role: docs-check/);
  assert.match(prompt, /Follow-up protocol:/);
  assert.match(prompt, /send done or review_findings now/i);
  assert.match(prompt, /If no qualifying finding exists within the scoped pass, send done now with a concise no-findings summary/);
  assert.doesNotMatch(prompt, /Before reading repo files, skills, or running broad exploration/);
});

test('agent assignment api handles assign, list, and inject flows', async () => {
  const { rootDir, statePath } = createTempStatePath('mh-agent-assignment-api-');
  const store = createAgentAssignmentStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();
  const runtimeCalls = [];
  const api = createAgentAssignmentApi({
    store,
    lifecycleRuntime: {
      activeStreamId: 'repo:/tmp/target',
      async injectAgent(agentId, input) {
        runtimeCalls.push({ agentId, input });
        return {
          ok: true,
          action: 'inject',
          injection: {
            pane_id: '%42',
            text_length: input.text.length,
            submit: input.submit !== false
          }
        };
      }
    }
  });

  const assignRequest = createRequest({
    method: 'POST',
    url: '/api/agent-assignments/assign',
    body: {
      stream_id: 'repo:/tmp/target',
      mission_id: 'mission-a',
      owner_agent_id: '__operator__',
      agent_id: 'helper-a',
      role: 'implementation',
      goal: 'Add a helper test',
      target_paths: ['face-app/dist/agent_assignment_api.js'],
      expected_output: 'patch + tests',
      completion_criteria: 'Return a minimal patch summary.',
      timebox_minutes: 5,
      max_findings: 1
    }
  });
  const assignResponse = createResponseCapture();
  const assignHandled = await api.handleHttpRequest(assignRequest, assignResponse);
  assert.equal(assignHandled, true);
  assert.equal(assignResponse.snapshot().statusCode, 200);
  assert.equal(assignResponse.snapshot().body?.result?.assignment?.delivery_state, 'pending');

  const listRequest = createRequest({
    method: 'GET',
    url: '/api/agent-assignments/list?stream_id=repo%3A%2Ftmp%2Ftarget'
  });
  const listResponse = createResponseCapture();
  const listHandled = await api.handleHttpRequest(listRequest, listResponse);
  assert.equal(listHandled, true);
  assert.equal(listResponse.snapshot().statusCode, 200);
  assert.equal(listResponse.snapshot().body?.state?.summary?.count, 1);

  const injectRequest = createRequest({
    method: 'POST',
    url: '/api/agent-assignments/inject',
    body: {
      stream_id: 'repo:/tmp/target',
      mission_id: 'mission-a',
      agent_id: 'helper-a',
      ack_timeout_ms: 5000
    }
  });
  const injectResponse = createResponseCapture();
  const injectHandled = await api.handleHttpRequest(injectRequest, injectResponse);
  assert.equal(injectHandled, true);
  assert.equal(injectResponse.snapshot().statusCode, 200);
  assert.equal(injectResponse.snapshot().body?.result?.assignment?.delivery_state, 'sent_to_tmux');
  assert.equal(runtimeCalls.length, 1);
  assert.match(runtimeCalls[0]?.input?.text ?? '', /call the agent\.report MCP tool/);
  assert.match(runtimeCalls[0]?.input?.text ?? '', /Stream root: \/tmp\/target/);
  assert.match(runtimeCalls[0]?.input?.text ?? '', /Target paths \(stream-root anchored\): \/tmp\/target\/face-app\/dist\/agent_assignment_api\.js/);
  assert.match(runtimeCalls[0]?.input?.text ?? '', /Target paths are READ references; make all edits and commits inside the assigned worktree on the helper branch/);
  assert.match(runtimeCalls[0]?.input?.text ?? '', /Timebox minutes: 5/);
  assert.equal(runtimeCalls[0]?.input?.probe_before_send, false);

  const probeInjectRequest = createRequest({
    method: 'POST',
    url: '/api/agent-assignments/inject',
    body: {
      stream_id: 'repo:/tmp/target',
      mission_id: 'mission-a',
      agent_id: 'helper-a',
      ack_timeout_ms: 5000,
      probe_before_send: true,
      probe_timeout_ms: 1200,
      probe_poll_ms: 50
    }
  });
  const probeInjectResponse = createResponseCapture();
  const probeInjectHandled = await api.handleHttpRequest(probeInjectRequest, probeInjectResponse);
  assert.equal(probeInjectHandled, true);
  assert.equal(probeInjectResponse.snapshot().statusCode, 200);
  assert.equal(runtimeCalls.length, 2);
  assert.equal(runtimeCalls[1]?.input?.probe_before_send, true);
  assert.equal(runtimeCalls[1]?.input?.force_shell_inject, false);
  assert.equal(runtimeCalls[1]?.input?.probe_timeout_ms, 1200);
  assert.equal(runtimeCalls[1]?.input?.probe_poll_ms, 50);

  const forceShellInjectRequest = createRequest({
    method: 'POST',
    url: '/api/agent-assignments/inject',
    body: {
      stream_id: 'repo:/tmp/target',
      mission_id: 'mission-a',
      agent_id: 'helper-a',
      force_shell_inject: true
    }
  });
  const forceShellInjectResponse = createResponseCapture();
  const forceShellInjectHandled = await api.handleHttpRequest(forceShellInjectRequest, forceShellInjectResponse);
  assert.equal(forceShellInjectHandled, true);
  assert.equal(forceShellInjectResponse.snapshot().statusCode, 200);
  assert.equal(runtimeCalls.length, 3);
  assert.equal(runtimeCalls[2]?.input?.force_shell_inject, true);
  const forceAssignment = forceShellInjectResponse.snapshot().body?.result?.assignment;
  assert.equal(forceAssignment.ack_deadline_at - forceAssignment.last_sent_at, 120_000);

  const followupInjectRequest = createRequest({
    method: 'POST',
    url: '/api/agent-assignments/inject',
    body: {
      stream_id: 'repo:/tmp/target',
      mission_id: 'mission-a',
      agent_id: 'helper-a',
      ack_timeout_ms: 5000,
      followup_mode: 'completion_rescue',
      probe_before_send: true,
      rescue_submit_if_buffered: true
    }
  });
  const followupInjectResponse = createResponseCapture();
  const followupInjectHandled = await api.handleHttpRequest(followupInjectRequest, followupInjectResponse);
  assert.equal(followupInjectHandled, true);
  assert.equal(followupInjectResponse.snapshot().statusCode, 200);
  assert.equal(runtimeCalls.length, 4);
  assert.match(runtimeCalls[3]?.input?.text ?? '', /^Owner follow-up for helper agent helper-a\./);
  assert.match(runtimeCalls[3]?.input?.text ?? '', /send done or review_findings now/i);
  assert.equal(runtimeCalls[3]?.input?.probe_before_send, true);
  assert.equal(runtimeCalls[3]?.input?.rescue_submit_if_buffered, true);

  cleanup(rootDir);
});


test('dashboard conditional reads preserve history, scope and time-driven delivery changes', async () => {
  const temp = createTempStatePath('assignment-dashboard-');
  let time = 1_700_500_000_000;
  const store = createAgentAssignmentStateStore({ statePath: temp.statePath, now: () => time, log: quietLog });
  const lifecycleRuntime = { injectAgent() {} };
  const api = createAgentAssignmentApi({ store, lifecycleRuntime });
  const read = async (url, etag = null, target = api, headers = {}) => {
    const request = createRequest({ method: 'GET', url });
    Object.assign(request.headers, headers);
    if (etag) request.headers['if-none-match'] = etag;
    const response = createResponseCapture();
    assert.equal(await target.handleHttpRequest(request, response), true);
    return response.snapshot();
  };
  try {
    const input = { stream_id: 'stream-a', mission_id: 'mission-a', owner_agent_id: '__operator__', agent_id: 'helper-a', goal: 'A'.repeat(150000) };
    store.upsertAssignment(input);
    const initial = await read('/api/agent-assignments/list?view=dashboard&stream_id=stream-a');
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.headers['cache-control'], 'no-store');
    assert.equal(initial.body.state.assignments.length, 1);
    assert.equal(initial.body.state.assignments[0].goal, undefined);
    assert(initial.rawBody.length < 2000);
    const unchanged = await read('/api/agent-assignments/list?view=dashboard&stream_id=stream-a', initial.headers.etag);
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.rawBody, '');
    const full = await read('/api/agent-assignments/list?view=full&stream_id=stream-a', initial.headers.etag);
    assert.equal(full.statusCode, 200);
    assert.equal(full.body.state.assignments[0].goal, input.goal);
    assert.equal(full.body.state.assignments[0].completion_rescue_grace_ms, 10000);
    const legacy = await read('/api/agent-assignments/list?stream_id=stream-a');
    assert.equal(legacy.statusCode, 200);
    assert.deepEqual(legacy.body, full.body);
    assert(legacy.rawBody.length > 150000, 'legacy clients retain their complete history');
    assert.equal(legacy.body.state.assignments[0].goal, input.goal);
    assert.deepEqual(legacy.body.state.summary, full.body.state.summary);
    const fields = ['stream_id', 'mission_id', 'agent_id', 'delivery_state', 'last_report_kind', 'last_report_at', 'updated_at'];
    for (const field of fields) assert.deepEqual(initial.body.state.assignments[0][field], full.body.state.assignments[0][field]);
    assert.deepEqual(Object.keys(initial.body.state.assignments[0]).sort(), fields.sort());
    const unknownView = await read('/api/agent-assignments/list?view=unexpected&stream_id=stream-a');
    assert.deepEqual(unknownView.body, legacy.body, 'unknown explicit views retain the original full-history contract');
    const oldMcp = await read('/api/agent-assignments/list?stream_id=stream-a', initial.headers.etag, api, { 'user-agent': 'node' });
    assert.equal(oldMcp.statusCode, 200);
    assert.deepEqual(oldMcp.body, full.body, 'already-loaded Node MCP must keep instructions and rescue details');
    const nodeDashboard = await read('/api/agent-assignments/list?view=dashboard&stream_id=stream-a', null, api, { 'user-agent': 'node' });
    assert.deepEqual(nodeDashboard.body, initial.body, 'an explicit compact view is independent of user agent');
    const browser = await read('/api/agent-assignments/list?stream_id=stream-a', null, api, { 'user-agent': 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
    assert.deepEqual(browser.body, legacy.body, 'the old mobile browser retains complete history');
    const compressed = await read('/api/agent-assignments/list?stream_id=stream-a', null, api, { 'accept-encoding': 'br, gzip, deflate', 'user-agent': 'Mozilla/5.0' });
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.equal(compressed.headers.vary, 'Accept-Encoding');
    assert.equal(compressed.headers['content-length'], compressed.rawBytes.length);
    assert(compressed.rawBytes.length < Buffer.byteLength(legacy.rawBody));
    assert.deepEqual(compressed.body, legacy.body);
    for (const encoding of ['gzip;q=0, deflate', 'gzip;q=invalid', 'gzip;q=1.1', 'br', '']) {
      const identity = await read('/api/agent-assignments/list?stream_id=stream-a', null, api, { 'accept-encoding': encoding });
      assert.equal(identity.headers['content-encoding'], undefined);
      assert.deepEqual(identity.body, legacy.body);
    }
    const compressedNotModified = await read('/api/agent-assignments/list?view=dashboard&stream_id=stream-a', initial.headers.etag, api, { 'accept-encoding': 'GZIP; q=0.5' });
    assert.equal(compressedNotModified.statusCode, 304);
    assert.equal(compressedNotModified.rawBytes.length, 0);
    const compressedNodeDashboard = await read('/api/agent-assignments/list?view=dashboard&stream_id=stream-a', null, api, { 'user-agent': 'node', 'accept-encoding': 'GZIP; q=0.5' });
    assert.equal(compressedNodeDashboard.headers['content-encoding'], 'gzip');
    assert.deepEqual(compressedNodeDashboard.body, initial.body);
    const oldMcpGzip = await read('/api/agent-assignments/list?stream_id=stream-a', null, api, { 'user-agent': 'node', 'accept-encoding': 'gzip' });
    assert.equal(oldMcpGzip.headers['content-encoding'], 'gzip');
    assert.deepEqual(oldMcpGzip.body, full.body);
    const filteredOut = await read('/api/agent-assignments/list?stream_id=stream-a&agent_id=other&mission_id=mission-a&owner_agent_id=__operator__');
    assert.equal(filteredOut.body.state.assignments.length, 0);
    const other = await read('/api/agent-assignments/list?view=dashboard&stream_id=stream-b', initial.headers.etag);
    assert.equal(other.statusCode, 200);
    assert.equal(other.body.state.assignments.length, 0);
    store.markDeliverySent({ stream_id: 'stream-a', mission_id: 'mission-a', delivery_id: 'delivery-a', ack_timeout_ms: 1000 });
    const sent = await read('/api/agent-assignments/list?view=dashboard&stream_id=stream-a', initial.headers.etag);
    assert.equal(sent.statusCode, 200);
    assert.equal(sent.body.state.assignments[0].delivery_state, 'sent_to_tmux');
    time += 2000;
    const timeout = await read('/api/agent-assignments/list?view=dashboard&stream_id=stream-a', sent.headers.etag);
    assert.equal(timeout.statusCode, 200);
    assert.equal(timeout.body.state.assignments[0].delivery_state, 'timeout');
    const legacyTimeout = await read('/api/agent-assignments/list?stream_id=stream-a');
    assert.equal(legacyTimeout.body.state.assignments[0].delivery_state, timeout.body.state.assignments[0].delivery_state, 'legacy badges reflect time-driven delivery changes');
    assert.equal(legacyTimeout.body.state.assignments[0].goal, input.goal);
    const historyAfter = await read('/api/agent-assignments/list?view=full&stream_id=stream-a&agent_id=helper-a&mission_id=mission-a&owner_agent_id=__operator__');
    assert.equal(historyAfter.body.state.assignments[0].goal, input.goal);
    assert.equal(historyAfter.body.state.assignments[0].delivery_state, 'timeout');
    const restarted = createAgentAssignmentApi({ store, lifecycleRuntime });
    assert.equal((await read('/api/agent-assignments/list?view=dashboard&stream_id=stream-a', timeout.headers.etag, restarted)).statusCode, 200);
    assert.equal(store.getAssignmentsView().assignments.length, 1);
  } finally { cleanup(temp.rootDir); }
});
