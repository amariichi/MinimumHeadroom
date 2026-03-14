import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
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
  let rawBody = '';

  return {
    writableEnded: false,
    writeHead(nextStatusCode, nextHeaders) {
      statusCode = nextStatusCode;
      headers = nextHeaders;
    },
    end(chunk = '') {
      rawBody += String(chunk ?? '');
      this.writableEnded = true;
    },
    snapshot() {
      return {
        statusCode,
        headers,
        rawBody,
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

  assert.match(prompt, /Bootstrap protocol \(follow in order\):/);
  assert.match(prompt, /Before reading repo files, skills, or running broad exploration/);
  assert.match(prompt, /kind=progress, summary='Mission accepted'/);
  assert.match(prompt, /After the first report succeeds, use the minimum-headroom-ops skill/);
  assert.match(prompt, /inspect the target paths before optional skill lookup, slash commands, or unrelated repo exploration/);
  assert.match(prompt, /When the work is complete, send done or review_findings/);
  assert.match(prompt, /send the final done\/review_findings report before any further prompts, \/skills, or extra exploration/);
  assert.match(prompt, /Stream root: \/tmp\/target/);
  assert.match(prompt, /Target paths \(stream-root anchored\): \/tmp\/target\/README\.md, \/tmp\/target\/doc\/examples\/AGENT_RULES\.md/);
  assert.match(prompt, /Completion criteria: Return one finding or done\./);
  assert.match(prompt, /Timebox minutes: 3/);
  assert.match(prompt, /Max findings this pass: 1/);
  assert.match(prompt, /Prefer returning one concrete result quickly/);
  assert.match(prompt, /outside your helper worktree but under the stream root/);
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
  assert.match(prompt, /Bootstrap protocol \(follow in order\):/);
  assert.match(prompt, /After the first report succeeds, use the minimum-headroom-ops skill/);
  assert.match(prompt, /Keep the first pass narrow/);
  assert.match(prompt, /inspect the target paths before optional skill lookup, slash commands, or unrelated repo exploration/);
  assert.match(prompt, /send the final done\/review_findings report before any further prompts, \/skills, or extra exploration/);
  assert.match(prompt, /If the scope is still ambiguous after the first report, send question/);
  assert.match(prompt, /Stream root for this mission: \/tmp\/target\./);
  assert.match(prompt, /Mission body:/);
  assert.match(prompt, /Investigate the failure and patch the bug\./);
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
  assert.match(runtimeCalls[0]?.input?.text ?? '', /Timebox minutes: 5/);
  assert.match(runtimeCalls[0]?.input?.text ?? '', /outside your helper worktree but under the stream root/);
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
  assert.equal(runtimeCalls[1]?.input?.probe_timeout_ms, 1200);
  assert.equal(runtimeCalls[1]?.input?.probe_poll_ms, 50);

  cleanup(rootDir);
});
