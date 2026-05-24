import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHookBridge } from '../../face-app/dist/hook_bridge.js';

function makeBridgeWithTemplates(templates) {
  const dir = mkdtempSync(join(tmpdir(), 'mh-hook-tpl-'));
  const templatesPath = join(dir, 'face-templates.json');
  writeFileSync(templatesPath, JSON.stringify(templates), 'utf8');
  const bridge = createHookBridge({ log: { warn: () => {} }, templatesPath });
  return { bridge, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('language detection picks ja from prior japanese face_say history', () => {
  const bridge = createHookBridge({ log: { warn: () => {} }, templatesPath: '/nonexistent/path.json' });
  bridge.observePayload({ type: 'say', agent_id: 'helper-1', text: 'こんにちは。' });
  assert.equal(bridge._internal.detectLanguage('helper-1'), 'ja');
});

test('language detection picks en from prior english face_say history', () => {
  const bridge = createHookBridge({ log: { warn: () => {} }, templatesPath: '/nonexistent/path.json' });
  bridge.observePayload({ type: 'say', agent_id: 'helper-1', text: 'Hello world.' });
  assert.equal(bridge._internal.detectLanguage('helper-1'), 'en');
});

test('language detection falls back to en when no history exists', () => {
  const bridge = createHookBridge({ log: { warn: () => {} }, templatesPath: '/nonexistent/path.json' });
  assert.equal(bridge._internal.detectLanguage('unknown-agent'), 'en');
});

test('handleHook emits broadcast event + say payloads for permission_required', async () => {
  const { bridge, cleanup } = makeBridgeWithTemplates({
    permission_required: { en: ['Approval needed.'], ja: ['承認をお願いします。'] },
    idle_after_response: { en: ['Idle.'], ja: ['アイドルです。'] }
  });
  const broadcasted = [];
  const server = { broadcast: (p) => broadcasted.push(p) };

  const result = await bridge.handleHook({
    payload: { type: 'hook', agent_id: 'helper-1', event: 'permission_required', runtime: 'claude' },
    server
  });

  assert.equal(result.ok, true);
  assert.equal(result.event, 'permission_required');
  assert.equal(result.lang, 'en');
  assert.equal(result.text, 'Approval needed.');
  assert.equal(broadcasted.length, 2);
  assert.equal(broadcasted[0].type, 'event');
  assert.equal(broadcasted[0].name, 'permission_required');
  assert.equal(broadcasted[0].severity, 0.9);
  assert.equal(broadcasted[1].type, 'say');
  assert.equal(broadcasted[1].priority, 3);
  assert.equal(broadcasted[1].policy, 'interrupt');
  assert.equal(broadcasted[1].text, 'Approval needed.');

  cleanup();
});

test('handleHook emits deferred low-priority say payload for idle_after_response', async () => {
  const { bridge, cleanup } = makeBridgeWithTemplates({
    permission_required: { en: ['Approval needed.'], ja: ['承認をお願いします。'] },
    idle_after_response: { en: ['Idle.'], ja: ['アイドルです。'] }
  });
  const broadcasted = [];
  const server = { broadcast: (p) => broadcasted.push(p) };

  const result = await bridge.handleHook({
    payload: { type: 'hook', agent_id: 'helper-1', event: 'idle_after_response', runtime: 'codex' },
    server
  });

  assert.equal(result.ok, true);
  assert.equal(result.event, 'idle_after_response');
  assert.equal(broadcasted.length, 2);
  assert.equal(broadcasted[0].type, 'event');
  assert.equal(broadcasted[0].name, 'idle_after_response');
  assert.equal(broadcasted[1].type, 'say');
  assert.equal(broadcasted[1].priority, 1);
  assert.equal(broadcasted[1].policy, 'replace');
  assert.equal(broadcasted[1].ttl_ms, 8000);
  assert.equal(broadcasted[1].defer_until_idle, true);
  assert.equal(broadcasted[1].notification_event, 'idle_after_response');
  assert.equal(broadcasted[1].text, 'Idle.');

  cleanup();
});

test('handleHook rejects unknown event names', async () => {
  const bridge = createHookBridge({ log: { warn: () => {} }, templatesPath: '/nonexistent/path.json' });
  const result = await bridge.handleHook({
    payload: { type: 'hook', agent_id: 'helper-1', event: 'bogus' },
    server: { broadcast: () => {} }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown_event');
});

test('handleHook rejects missing agent_id', async () => {
  const bridge = createHookBridge({ log: { warn: () => {} }, templatesPath: '/nonexistent/path.json' });
  const result = await bridge.handleHook({
    payload: { type: 'hook', event: 'permission_required' },
    server: { broadcast: () => {} }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_agent_id');
});

test('handleHook posts owner inbox entry when assignment exists', async () => {
  const bridge = createHookBridge({ log: { warn: () => {} }, templatesPath: '/nonexistent/path.json' });
  const inboxCalls = [];
  const assignmentStore = {
    listAssignments: () => [{
      stream_id: 's1', mission_id: 'm1', owner_agent_id: '__operator__', agent_id: 'helper-1', delivery_state: 'acked'
    }]
  };
  const ownerInboxStore = {
    submitReport: (input) => {
      inboxCalls.push(input);
      return { ok: true, transport_state: 'accepted', report: { ...input, report_id: 'r-1' } };
    }
  };

  const result = await bridge.handleHook({
    payload: { type: 'hook', agent_id: 'helper-1', event: 'idle_after_response', runtime: 'claude' },
    server: { broadcast: () => {} },
    ownerInboxStore,
    assignmentStore
  });

  assert.equal(result.ok, true);
  assert.equal(result.inbox_posted, true);
  assert.equal(inboxCalls.length, 1);
  assert.equal(inboxCalls[0].kind, 'done');
  assert.equal(inboxCalls[0].owner_agent_id, '__operator__');
  assert.equal(inboxCalls[0].from_agent_id, 'helper-1');
  assert.match(inboxCalls[0].detail, /source=mh_hook/);
});

test('handleHook does not post inbox when no assignment matches', async () => {
  const bridge = createHookBridge({ log: { warn: () => {} }, templatesPath: '/nonexistent/path.json' });
  const inboxCalls = [];
  const result = await bridge.handleHook({
    payload: { type: 'hook', agent_id: 'helper-1', event: 'permission_required' },
    server: { broadcast: () => {} },
    ownerInboxStore: { submitReport: (i) => { inboxCalls.push(i); return { transport_state: 'accepted' }; } },
    assignmentStore: { listAssignments: () => [] }
  });
  assert.equal(result.ok, true);
  assert.equal(result.inbox_posted, false);
  assert.equal(inboxCalls.length, 0);
});

test('pickLine avoids repeating the same variant in succession for the same (agent, event)', () => {
  const { bridge, cleanup } = makeBridgeWithTemplates({
    permission_required: { en: ['A.', 'B.'], ja: ['あ。', 'い。'] },
    idle_after_response: { en: ['Idle.'], ja: ['アイドル。'] }
  });
  const first = bridge._internal.pickLine('permission_required', 'en', 'helper-1');
  const second = bridge._internal.pickLine('permission_required', 'en', 'helper-1');
  assert.notEqual(first, second);
  cleanup();
});
