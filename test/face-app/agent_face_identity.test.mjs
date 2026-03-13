import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveAgentFaceIdentity, faceAccentCss } from '../../face-app/public/agent_face_identity.js';

test('deriveAgentFaceIdentity is stable for the same agent', () => {
  const first = deriveAgentFaceIdentity({ id: 'agent-a', session_id: 'session-a' });
  const second = deriveAgentFaceIdentity({ id: 'agent-a', session_id: 'session-a' });
  assert.deepEqual(first, second);
});

test('deriveAgentFaceIdentity varies across different agents', () => {
  const first = deriveAgentFaceIdentity({ id: 'agent-a', session_id: 'session-a' });
  const second = deriveAgentFaceIdentity({ id: 'agent-b', session_id: 'session-b' });
  assert.notEqual(first.seed, second.seed);
  assert.notDeepEqual(first.appearance, second.appearance);
  assert.notDeepEqual(first.motion, second.motion);
});

test('deriveAgentFaceIdentity reserves a stable operator identity', () => {
  const identity = deriveAgentFaceIdentity({ id: '__operator__', session_id: 'default' });
  assert.equal(faceAccentCss(identity), '#7bf5b8');
  assert.equal(identity.seed, 'operator');
  assert.ok(identity.motion);
});
