import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AXIS_CONVENTION,
  FEATURE_ANCHORS,
  applyDragEmotionBias,
  applyEventToFaceState,
  createInitialFaceState,
  deriveFaceControls,
  stepFaceState,
  validateFeatureAnchors,
  validateFeatureDepth
} from '../../face-app/public/state_engine.js';

test('feature anchors keep left and right separated around center line', () => {
  assert.equal(validateFeatureAnchors(FEATURE_ANCHORS), true);
  assert.equal(validateFeatureDepth(FEATURE_ANCHORS), true);
  assert.equal(AXIS_CONVENTION.positive_x, 'right');
  assert.equal(AXIS_CONVENTION.positive_y, 'up');
  assert.equal(AXIS_CONVENTION.positive_z, 'toward_viewer');
  assert.ok(FEATURE_ANCHORS.brow_l.x < 0);
  assert.ok(FEATURE_ANCHORS.eye_l.x < 0);
  assert.ok(FEATURE_ANCHORS.brow_r.x > 0);
  assert.ok(FEATURE_ANCHORS.eye_r.x > 0);
  assert.ok(FEATURE_ANCHORS.eye_l.z > 1);
  assert.ok(FEATURE_ANCHORS.mouth.z > 1);
});

test('cmd_failed event increases fail streak and negative emotion metrics', () => {
  let state = createInitialFaceState(1_000);
  state = applyEventToFaceState(
    state,
    { type: 'event', session_id: 'phase2#test', name: 'cmd_failed', severity: 0.8 },
    1_100
  );

  assert.equal(state.session_id, 'phase2#test');
  assert.equal(state.metrics.fail_streak, 1);
  assert.ok(state.metrics.confused > 0.1);
  assert.ok(state.metrics.frustration > 0);
  assert.ok(state.metrics.confidence < 0.5);
  assert.equal(state.gesture.type, 'tilt');

  state = applyEventToFaceState(state, { type: 'event', session_id: 'phase2#test', name: 'cmd_failed', severity: 0.9 }, 1_200);
  assert.equal(state.metrics.fail_streak, 2);
  assert.equal(state.gesture.type, 'shake');
});

test('cmd_succeeded resets fail streak and starts nod gesture', () => {
  let state = createInitialFaceState(10);
  state.metrics.fail_streak = 4;
  state.metrics.confused = 0.8;
  state.metrics.frustration = 0.6;
  state.metrics.confidence = 0.2;

  state = applyEventToFaceState(state, { type: 'event', session_id: 'phase2#test', name: 'cmd_succeeded', severity: 0.5 }, 100);

  assert.equal(state.metrics.fail_streak, 0);
  assert.ok(state.metrics.confused < 0.8);
  assert.ok(state.metrics.frustration < 0.6);
  assert.ok(state.metrics.confidence > 0.2);
  assert.equal(state.gesture.type, 'nod');
});

test('step decay and control derivation follow expected bounds', () => {
  const state = createInitialFaceState(1_000);
  state.metrics.confused = 0.9;
  state.metrics.frustration = 0.8;
  state.metrics.confidence = 0.1;
  state.metrics.urgency = 0.7;
  state.metrics.stuckness = 0.6;
  state.metrics.fail_streak = 3;

  const stepped = stepFaceState(state, 6, 7_000);
  assert.ok(stepped.metrics.confused < state.metrics.confused);
  assert.ok(stepped.metrics.frustration < state.metrics.frustration);
  assert.ok(stepped.metrics.urgency < state.metrics.urgency);
  assert.ok(stepped.metrics.stuckness < state.metrics.stuckness);
  assert.ok(stepped.metrics.confidence > state.metrics.confidence);

  const controls = deriveFaceControls(stepped, 7_020);
  assert.ok(controls.brows.left.raise >= 0 && controls.brows.left.raise <= 1);
  assert.ok(controls.brows.right.raise >= 0 && controls.brows.right.raise <= 1);
  assert.ok(controls.eyes.left.open >= 0 && controls.eyes.left.open <= 1);
  assert.ok(controls.eyes.right.open >= 0 && controls.eyes.right.open <= 1);
  assert.ok(controls.head.yaw >= -1 && controls.head.yaw <= 1);
  assert.ok(controls.head.pitch >= -1 && controls.head.pitch <= 1);
  assert.ok(controls.head.roll >= -1 && controls.head.roll <= 1);
});

test('drag interaction in confidence mode amplifies confidence and damps negative metrics', () => {
  const nowMs = 8_000;
  const state = createInitialFaceState(nowMs);
  state.metrics.confidence = 0.72;
  state.metrics.confused = 0.26;
  state.metrics.frustration = 0.24;
  state.metrics.stuckness = 0.22;

  const next = applyDragEmotionBias(
    state,
    {
      intensity: 0.9,
      modeHint: 'confidence'
    },
    1.4,
    nowMs + 1_400
  );

  assert.ok(next.metrics.confidence > state.metrics.confidence);
  assert.ok(next.metrics.confused < state.metrics.confused);
  assert.ok(next.metrics.frustration < state.metrics.frustration);
  assert.ok(next.metrics.stuckness < state.metrics.stuckness);
});

test('drag interaction in negative mode amplifies that negative metric and lowers confidence', () => {
  const nowMs = 9_000;
  const state = createInitialFaceState(nowMs);
  state.metrics.confidence = 0.68;
  state.metrics.confused = 0.22;
  state.metrics.frustration = 0.3;
  state.metrics.stuckness = 0.21;

  const next = applyDragEmotionBias(
    state,
    {
      intensity: 0.85,
      modeHint: 'frustration'
    },
    1.3,
    nowMs + 1_300
  );

  assert.ok(next.metrics.frustration > state.metrics.frustration);
  assert.ok(next.metrics.stuckness > state.metrics.stuckness);
  assert.ok(next.metrics.confidence < state.metrics.confidence);
});

test('deriveFaceControls produces distinct facial signatures per dominant state', () => {
  const nowMs = 42_000;

  const neutral = createInitialFaceState(nowMs);

  const confused = createInitialFaceState(nowMs);
  confused.metrics.confused = 0.86;
  confused.metrics.confidence = 0.28;

  const frustration = createInitialFaceState(nowMs);
  frustration.metrics.frustration = 0.88;
  frustration.metrics.confidence = 0.24;

  const confidence = createInitialFaceState(nowMs);
  confidence.metrics.confidence = 0.94;
  confidence.metrics.confused = 0.08;

  const urgency = createInitialFaceState(nowMs);
  urgency.metrics.urgency = 0.92;
  urgency.metrics.confidence = 0.4;

  const stuckness = createInitialFaceState(nowMs);
  stuckness.metrics.stuckness = 0.91;
  stuckness.metrics.confidence = 0.3;

  const neutralControls = deriveFaceControls(neutral, nowMs);
  const confusedControls = deriveFaceControls(confused, nowMs);
  const frustrationControls = deriveFaceControls(frustration, nowMs);
  const confidenceControls = deriveFaceControls(confidence, nowMs);
  const urgencyControls = deriveFaceControls(urgency, nowMs);
  const stuckControls = deriveFaceControls(stuckness, nowMs);

  assert.equal(confusedControls.debug.mode, 'confused');
  assert.equal(frustrationControls.debug.mode, 'frustration');
  assert.equal(confidenceControls.debug.mode, 'confidence');
  assert.equal(urgencyControls.debug.mode, 'urgency');
  assert.equal(stuckControls.debug.mode, 'stuckness');

  assert.ok(frustrationControls.brows.furrow > confidenceControls.brows.furrow);
  assert.ok(confidenceControls.mouth.wide > frustrationControls.mouth.wide);
  assert.ok(urgencyControls.mouth.open > confidenceControls.mouth.open);
  assert.ok(stuckControls.eyes.gaze_y < confidenceControls.eyes.gaze_y);
  assert.ok(Math.abs(confusedControls.eyes.gaze_x) > Math.abs(neutralControls.eyes.gaze_x));
  assert.ok(frustrationControls.head.pitch < confidenceControls.head.pitch);
});

test('confidence mode adds short eyebrow bobbing during nod gesture', () => {
  const nowMs = 10_000;

  const base = createInitialFaceState(nowMs);
  base.metrics.confidence = 0.72;
  base.metrics.confused = 0.04;
  base.metrics.frustration = 0.02;
  base.gesture = {
    type: 'none',
    started_at: nowMs,
    duration_ms: 0,
    amplitude: 0,
    polarity: 1
  };

  const baseline = deriveFaceControls(base, nowMs + 120);

  const withNod = createInitialFaceState(nowMs);
  withNod.metrics.confidence = 0.72;
  withNod.metrics.confused = 0.04;
  withNod.metrics.frustration = 0.02;
  withNod.gesture = {
    type: 'nod',
    started_at: nowMs,
    duration_ms: 1_000,
    amplitude: 0.8,
    polarity: 1
  };

  const pulseA = deriveFaceControls(withNod, nowMs + 80);
  const pulseB = deriveFaceControls(withNod, nowMs + 360);

  assert.equal(pulseA.debug.mode, 'confidence');
  assert.ok(pulseA.brows.left.raise > baseline.brows.left.raise);
  assert.ok(pulseA.brows.right.raise > baseline.brows.right.raise);
  assert.ok(Math.abs(pulseA.brows.left.raise - pulseB.brows.left.raise) > 0.02);
});

test('event posture semantics separate confidence and stuckness head direction', () => {
  const nowMs = 24_000;

  const successState = applyEventToFaceState(
    createInitialFaceState(nowMs),
    { type: 'event', session_id: 'phase3#pose', name: 'tests_passed', severity: 1 },
    nowMs + 10
  );
  const successControls = deriveFaceControls(successState, nowMs + 80);
  assert.equal(successControls.debug.mode, 'confidence');
  assert.ok(Math.abs(successControls.head.pitch) > 0.2);

  const stuckState = applyEventToFaceState(
    createInitialFaceState(nowMs),
    { type: 'event', session_id: 'phase3#pose', name: 'tests_failed', severity: 1 },
    nowMs + 10
  );
  const stuckControls = deriveFaceControls(stuckState, nowMs + 80);
  assert.equal(stuckControls.debug.mode, 'stuckness');
  assert.ok(stuckControls.head.pitch < -0.2);
  assert.ok(stuckControls.brows.tilt > 0.28);
  assert.ok(successControls.head.pitch > stuckControls.head.pitch);

  const confusedState = applyEventToFaceState(
    createInitialFaceState(nowMs),
    { type: 'event', session_id: 'phase3#pose', name: 'cmd_failed', severity: 0.9 },
    nowMs + 10
  );
  const confusedControls = deriveFaceControls(confusedState, nowMs + 80);
  assert.equal(confusedControls.debug.mode, 'confused');
  assert.ok(confusedControls.head.pitch > 0.08);
});

test('idle event quickly recenters confidence and clears active gesture', () => {
  const nowMs = 52_000;
  const state = createInitialFaceState(nowMs);
  state.metrics.confidence = 0.9;
  state.metrics.urgency = 0.6;
  state.metrics.confused = 0.4;
  state.gesture = {
    type: 'nod',
    started_at: nowMs - 200,
    duration_ms: 1_400,
    amplitude: 0.8,
    polarity: 1
  };

  const idled = applyEventToFaceState(state, { type: 'event', session_id: 'phase3#neutral', name: 'idle', severity: 0 }, nowMs + 20);
  assert.equal(idled.gesture.type, 'none');
  assert.ok(idled.metrics.confidence < 0.56);

  const controls = deriveFaceControls(idled, nowMs + 120);
  assert.equal(controls.debug.mode, 'neutral');

  const stepped = stepFaceState(idled, 1.2, nowMs + 1_220);
  assert.ok(Math.abs(stepped.metrics.confidence - 0.5) < Math.abs(idled.metrics.confidence - 0.5));
});
