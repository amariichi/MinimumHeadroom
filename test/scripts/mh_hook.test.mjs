import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { detectCanonicalEvent, parseArgs, parseStdinPayload, runHookCli } from '../../scripts/mh-hook.mjs';

function makeStdin(text) {
  if (text === null || text === undefined) {
    return Readable.from([]);
  }
  return Readable.from([Buffer.from(text, 'utf8')]);
}

function makeStderr() {
  const lines = [];
  return {
    write(chunk) {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    },
    text() {
      return lines.join('');
    }
  };
}

function makeStdout() {
  const lines = [];
  return {
    write(chunk) {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    },
    text() {
      return lines.join('');
    }
  };
}

test('parseArgs reads --runtime and --event in both forms', () => {
  assert.deepEqual(parseArgs(['--runtime', 'claude', '--event', 'permission_required']), {
    runtime: 'claude',
    event: 'permission_required',
    stdoutMode: null
  });
  assert.deepEqual(parseArgs(['--runtime=antigravity', '--event=idle_after_response', '--stdout-mode=silent']), {
    runtime: 'antigravity',
    event: 'idle_after_response',
    stdoutMode: 'silent'
  });
});

test('parseStdinPayload parses JSON and tolerates noise', () => {
  assert.deepEqual(parseStdinPayload('{"hook_event_name":"Notification"}'), { hook_event_name: 'Notification' });
  assert.equal(parseStdinPayload(''), null);
  assert.equal(parseStdinPayload('not json'), null);
});

test('detectCanonicalEvent maps Claude Notification → permission_required', () => {
  const detection = detectCanonicalEvent({ payload: { hook_event_name: 'Notification' }, explicitEvent: null });
  assert.equal(detection.event, 'permission_required');
  assert.equal(detection.source, 'hook_event_name');
});

test('detectCanonicalEvent maps Claude Stop → idle_after_response', () => {
  const detection = detectCanonicalEvent({ payload: { hook_event_name: 'Stop' }, explicitEvent: null });
  assert.equal(detection.event, 'idle_after_response');
});

test('detectCanonicalEvent maps Codex PermissionRequest → permission_required', () => {
  const detection = detectCanonicalEvent({ payload: { hook_event_name: 'PermissionRequest' }, explicitEvent: null });
  assert.equal(detection.event, 'permission_required');
});

test('detectCanonicalEvent maps Antigravity Stop → idle_after_response', () => {
  const detection = detectCanonicalEvent({ payload: { hook_event_name: 'Stop' }, explicitEvent: null });
  assert.equal(detection.event, 'idle_after_response');
});

test('detectCanonicalEvent maps legacy Codex agent-turn-complete', () => {
  const detection = detectCanonicalEvent({ payload: { event: 'agent-turn-complete' }, explicitEvent: null });
  assert.equal(detection.event, 'idle_after_response');
  assert.equal(detection.source, 'legacy_notify');
});

test('detectCanonicalEvent honors explicit --event override', () => {
  const detection = detectCanonicalEvent({ payload: { hook_event_name: 'BeforeTool' }, explicitEvent: 'permission_required' });
  assert.equal(detection.event, 'permission_required');
  assert.equal(detection.source, 'argv');
});

test('detectCanonicalEvent returns null for unknown native event', () => {
  const detection = detectCanonicalEvent({ payload: { hook_event_name: 'BeforeTool' }, explicitEvent: null });
  assert.equal(detection.event, null);
});

test('runHookCli sends a hook payload when MH_FACE_AGENT_ID is set and event is detected', async () => {
  const sent = [];
  const stderr = makeStderr();
  const stdout = makeStdout();
  const result = await runHookCli({
    argv: ['--runtime', 'antigravity'],
    env: { MH_FACE_AGENT_ID: 'helper-1', FACE_WS_URL: 'ws://ignored/ws' },
    stdin: makeStdin(JSON.stringify({ hook_event_name: 'Notification', session_id: 'sess-A' })),
    stderr,
    stdout,
    now: () => 1000,
    send: async (url, payload) => {
      sent.push({ url, payload });
    }
  });

  assert.equal(result.delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'ws://ignored/ws');
  assert.equal(stdout.text(), '{"decision":"ask"}\n');
  assert.deepEqual(sent[0].payload, {
    v: 1,
    type: 'hook',
    session_id: 'sess-A',
    agent_id: 'helper-1',
    ts: 1000,
    event: 'permission_required',
    runtime: 'antigravity',
    meta: { source: 'mh_hook' }
  });
});

test('runHookCli exits cleanly without sending when MH_FACE_AGENT_ID is missing', async () => {
  const sent = [];
  const stderr = makeStderr();
  const result = await runHookCli({
    argv: ['--runtime', 'claude'],
    env: {},
    stdin: makeStdin(JSON.stringify({ hook_event_name: 'Notification' })),
    stderr,
    send: async (...args) => {
      sent.push(args);
    }
  });

  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'missing_agent_id');
  assert.equal(sent.length, 0);
  assert.match(stderr.text(), /MH_FACE_AGENT_ID/);
});

test('runHookCli exits cleanly when stdin payload has no recognizable event', async () => {
  const sent = [];
  const stderr = makeStderr();
  const result = await runHookCli({
    argv: ['--runtime', 'codex'],
    env: { MH_FACE_AGENT_ID: 'helper-1' },
    stdin: makeStdin('not json'),
    stderr,
    send: async (...args) => {
      sent.push(args);
    }
  });

  assert.equal(result.delivered, false);
  assert.equal(sent.length, 0);
});

test('runHookCli supports silent Antigravity settings hooks without legacy runtime names', async () => {
  const sent = [];
  const stderr = makeStderr();
  const stdout = makeStdout();
  const result = await runHookCli({
    argv: ['--runtime', 'antigravity', '--stdout-mode', 'silent', '--event', 'permission_required'],
    env: { MH_FACE_AGENT_ID: '__operator__' },
    stdin: makeStdin(''),
    stderr,
    stdout,
    send: async (url, payload) => {
      sent.push({ url, payload });
    }
  });

  assert.equal(result.delivered, true);
  assert.equal(sent[0].payload.runtime, 'antigravity');
  assert.equal(stdout.text(), '');
  assert.doesNotMatch(stderr.text(), /unknown runtime/);
});

test('runHookCli suppresses events listed in MH_HOOK_SUPPRESS_EVENTS but still emits runtime stdout', async () => {
  const sent = [];
  const stderr = makeStderr();
  const stdout = makeStdout();
  const result = await runHookCli({
    argv: ['--runtime', 'antigravity', '--event', 'idle_after_response'],
    env: {
      MH_FACE_AGENT_ID: '__operator__',
      MH_HOOK_SUPPRESS_EVENTS: 'idle_after_response'
    },
    stdin: makeStdin(''),
    stderr,
    stdout,
    send: async (...args) => {
      sent.push(args);
    }
  });

  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'suppressed_by_env');
  assert.equal(sent.length, 0);
  assert.equal(stdout.text(), '{"decision":""}\n');
  assert.match(stderr.text(), /suppressed/);
});

test('runHookCli still sends events not listed in MH_HOOK_SUPPRESS_EVENTS', async () => {
  const sent = [];
  const stderr = makeStderr();
  const result = await runHookCli({
    argv: ['--runtime', 'claude', '--event', 'permission_required'],
    env: {
      MH_FACE_AGENT_ID: '__operator__',
      MH_HOOK_SUPPRESS_EVENTS: 'idle_after_response'
    },
    stdin: makeStdin(''),
    stderr,
    send: async (url, payload) => {
      sent.push({ url, payload });
    }
  });

  assert.equal(result.delivered, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.event, 'permission_required');
});

test('runHookCli forwards send errors as a clean reason and never throws', async () => {
  const stderr = makeStderr();
  const result = await runHookCli({
    argv: ['--runtime', 'claude'],
    env: { MH_FACE_AGENT_ID: 'helper-1' },
    stdin: makeStdin(JSON.stringify({ hook_event_name: 'Notification' })),
    stderr,
    send: async () => {
      throw new Error('connection refused');
    }
  });

  assert.equal(result.delivered, false);
  assert.equal(result.reason, 'send_failed');
  assert.match(stderr.text(), /connection refused/);
});
