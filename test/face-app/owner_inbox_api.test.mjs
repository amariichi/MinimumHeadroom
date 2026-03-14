import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createAgentAssignmentStateStore } from '../../face-app/dist/agent_assignment_state.js';
import { createOwnerInboxStateStore } from '../../face-app/dist/owner_inbox_state.js';
import { createOwnerInboxApi } from '../../face-app/dist/owner_inbox_api.js';

const quietLog = {
  info() {},
  warn() {},
  error() {}
};

function createTempStatePath(prefix) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    rootDir,
    statePath: path.join(rootDir, '.agent/runtime/owner-inbox-state.json')
  };
}

function createClock(start = 1_700_200_000_000) {
  let tick = start;
  return () => {
    tick += 19;
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

test('owner inbox api handles submit, list, and resolve flows', async () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-api-');
  const store = createOwnerInboxStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();
  const api = createOwnerInboxApi({ store });

  const submitRequest = createRequest({
    method: 'POST',
    url: '/api/owner-inbox/report',
    body: {
      stream_id: 'operator-default',
      mission_id: 'helper-a',
      owner_agent_id: '__operator__',
      from_agent_id: 'helper-a',
      kind: 'blocked',
      summary: 'Need approval',
      report_id: 'rpt-1'
    }
  });
  const submitResponse = createResponseCapture();
  const submitHandled = await api.handleHttpRequest(submitRequest, submitResponse);
  assert.equal(submitHandled, true);
  assert.equal(submitResponse.snapshot().statusCode, 200);
  assert.equal(submitResponse.snapshot().body?.result?.transport_state, 'accepted');

  const listRequest = createRequest({
    method: 'GET',
    url: '/api/owner-inbox/list?owner_agent_id=__operator__'
  });
  const listResponse = createResponseCapture();
  const listHandled = await api.handleHttpRequest(listRequest, listResponse);
  assert.equal(listHandled, true);
  assert.equal(listResponse.snapshot().statusCode, 200);
  assert.equal(listResponse.snapshot().body?.state?.summary?.unresolved_count, 1);

  const resolveRequest = createRequest({
    method: 'POST',
    url: '/api/owner-inbox/resolve',
    body: {
      stream_id: 'operator-default',
      report_id: 'rpt-1',
      action: 'resolved'
    }
  });
  const resolveResponse = createResponseCapture();
  const resolveHandled = await api.handleHttpRequest(resolveRequest, resolveResponse);
  assert.equal(resolveHandled, true);
  assert.equal(resolveResponse.snapshot().statusCode, 200);
  assert.equal(resolveResponse.snapshot().body?.result?.report?.lifecycle_state, 'resolved');

  cleanup(rootDir);
});

test('owner inbox api rejects unsupported methods cleanly', async () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-api-method-');
  const store = createOwnerInboxStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  store.load();
  const api = createOwnerInboxApi({ store });

  const request = createRequest({
    method: 'POST',
    url: '/api/owner-inbox/list'
  });
  const response = createResponseCapture();
  const handled = await api.handleHttpRequest(request, response);
  assert.equal(handled, true);
  assert.equal(response.snapshot().statusCode, 405);

  cleanup(rootDir);
});

test('owner inbox api can acknowledge assignment delivery through submit callback', async () => {
  const { rootDir, statePath } = createTempStatePath('mh-owner-inbox-api-ack-');
  const assignmentStatePath = path.join(rootDir, '.agent/runtime/agent-assignment-state.json');
  const ownerInboxStore = createOwnerInboxStateStore({
    statePath,
    now: createClock(),
    log: quietLog
  });
  ownerInboxStore.load();
  const assignmentStore = createAgentAssignmentStateStore({
    statePath: assignmentStatePath,
    now: createClock(1_700_210_000_000),
    log: quietLog
  });
  assignmentStore.load();
  assignmentStore.upsertAssignment({
    stream_id: 'operator-default',
    mission_id: 'helper-a',
    owner_agent_id: '__operator__',
    agent_id: 'helper-a',
    goal: 'Acknowledge the mission'
  });
  assignmentStore.markDeliverySent({
    stream_id: 'operator-default',
    mission_id: 'helper-a',
    agent_id: 'helper-a',
    ack_timeout_ms: 5000
  });

  const api = createOwnerInboxApi({
    store: ownerInboxStore,
    async onSubmitReport({ result }) {
      if (result?.report) {
        assignmentStore.noteReport(result.report);
      }
    }
  });

  const submitRequest = createRequest({
    method: 'POST',
    url: '/api/owner-inbox/report',
    body: {
      stream_id: 'operator-default',
      mission_id: 'helper-a',
      owner_agent_id: '__operator__',
      from_agent_id: 'helper-a',
      kind: 'progress',
      summary: 'Mission accepted',
      report_id: 'rpt-ack'
    }
  });
  const submitResponse = createResponseCapture();
  await api.handleHttpRequest(submitRequest, submitResponse);

  const assignment = assignmentStore.getAssignment({
    stream_id: 'operator-default',
    mission_id: 'helper-a',
    agent_id: 'helper-a'
  });
  assert.equal(submitResponse.snapshot().statusCode, 200);
  assert.equal(assignment?.delivery_state, 'acked');
  assert.equal(assignment?.last_report_id, 'rpt-ack');

  cleanup(rootDir);
});
