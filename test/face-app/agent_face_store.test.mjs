import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAgentFaceRuntimeDragDelta,
  applyAgentFaceRuntimeDragToControls,
  applyPayloadToAgentFaceRuntime,
  createAgentFaceRuntime,
  resolveFaceAgentId,
  setAgentFaceRuntimeDragActive,
  stepAgentFaceRuntime
} from '../../face-app/public/agent_face_store.js';

test('resolveFaceAgentId maps helper agents then operator session', () => {
  const agents = [{ id: 'agent-a', session_id: 'session-a' }];
  assert.equal(
    resolveFaceAgentId({ session_id: 'session-a' }, agents, {
      operatorAgentId: '__operator__',
      operatorSessionId: 'default'
    }),
    'agent-a'
  );
  assert.equal(
    resolveFaceAgentId({ session_id: 'default' }, agents, {
      operatorAgentId: '__operator__',
      operatorSessionId: 'default'
    }),
    '__operator__'
  );
  assert.equal(
    resolveFaceAgentId({ agent_id: 'helper-ephemeral', session_id: 'default' }, agents, {
      operatorAgentId: '__operator__',
      operatorSessionId: 'default'
    }),
    'helper-ephemeral'
  );
  assert.equal(
    resolveFaceAgentId({ session_id: '__operator__' }, agents, {
      operatorAgentId: '__operator__',
      operatorSessionId: 'default',
      operatorAliases: ['operator', '__operator__']
    }),
    '__operator__'
  );
  assert.equal(
    resolveFaceAgentId({ agent_id: 'operator', session_id: 'different' }, agents, {
      operatorAgentId: '__operator__',
      operatorSessionId: 'default',
      operatorAliases: ['operator', '__operator__']
    }),
    '__operator__'
  );
});

test('applyPayloadToAgentFaceRuntime updates event and speech state', () => {
  const runtime = createAgentFaceRuntime({ nowMs: 100 });
  applyPayloadToAgentFaceRuntime(runtime, {
    type: 'event',
    name: 'cmd_failed',
    severity: 0.8,
    session_id: 'session-a'
  }, 200);
  assert.equal(runtime.faceState.session_id, 'session-a');
  assert.equal(runtime.faceState.last_event, 'cmd_failed');

  applyPayloadToAgentFaceRuntime(runtime, { type: 'tts_state', phase: 'play_start' }, 220);
  assert.equal(runtime.speech.active, true);

  applyPayloadToAgentFaceRuntime(runtime, { type: 'tts_mouth', open: 0.6 }, 230);
  assert.equal(runtime.speech.mouthOpen, 0.6);

  applyPayloadToAgentFaceRuntime(runtime, { type: 'tts_state', phase: 'play_stop' }, 260);
  assert.equal(runtime.speech.active, false);
  assert.equal(runtime.speech.mouthOpen, 0);
});

test('operator_prompt nudges the face runtime into needs-attention state', () => {
  const runtime = createAgentFaceRuntime({ nowMs: 100 });
  const beforeUrgency = runtime.faceState.metrics.urgency;
  applyPayloadToAgentFaceRuntime(runtime, {
    type: 'operator_prompt',
    state: 'awaiting_input',
    session_id: 'default'
  }, 200);
  assert.ok(runtime.faceState.metrics.urgency > beforeUrgency);
  assert.equal(runtime.faceState.last_event, 'needs_attention');
});

test('prompt_idle event settles the face runtime toward calm', () => {
  const runtime = createAgentFaceRuntime({ nowMs: 100 });
  applyPayloadToAgentFaceRuntime(runtime, {
    type: 'event',
    name: 'cmd_failed',
    severity: 0.8,
    session_id: 'default'
  }, 140);
  const beforeConfused = runtime.faceState.metrics.confused;
  applyPayloadToAgentFaceRuntime(runtime, {
    type: 'event',
    name: 'prompt_idle',
    severity: 0.2,
    session_id: 'default'
  }, 220);
  assert.equal(runtime.faceState.last_event, 'prompt_idle');
  assert.ok(runtime.faceState.metrics.confused < beforeConfused);
});

test('stepAgentFaceRuntime decays mouth animation over time', () => {
  const runtime = createAgentFaceRuntime({ nowMs: 100, motion: { timeOffsetMs: 1200 } });
  runtime.speech.active = true;
  runtime.speech.mouthOpen = 0.8;
  runtime.speech.updatedAt = 100;
  stepAgentFaceRuntime(runtime, 1.2, 1600);
  assert.deepEqual(runtime.motion, { timeOffsetMs: 1200 });
  assert.equal(runtime.speech.mouthOpen, 0);
  assert.equal(runtime.speech.active, false);
});

test('agent face runtime drag updates controls and confidence-oriented metrics', () => {
  const runtime = createAgentFaceRuntime({ nowMs: 100 });
  runtime.faceState.metrics.confidence = 0.88;
  applyAgentFaceRuntimeDragDelta(runtime, {
    deltaX: 16,
    deltaY: -10,
    speedPxPerSecond: 800,
    modeHint: 'confidence'
  });
  const controls = {
    head: { yaw: 0, pitch: 0, roll: 0, sway_x: 0, sway_y: 0 }
  };
  applyAgentFaceRuntimeDragToControls(runtime, controls);
  assert.notEqual(controls.head.yaw, 0);
  assert.notEqual(controls.head.pitch, 0);
  assert.ok(runtime.drag.intensity > 0);

  const beforeConfidence = runtime.faceState.metrics.confidence;
  setAgentFaceRuntimeDragActive(runtime, false);
  stepAgentFaceRuntime(runtime, 0.6, 700);
  assert.ok(runtime.faceState.metrics.confidence > beforeConfidence);
  assert.ok(runtime.drag.intensity >= 0);
});
