const EPSILON = 1e-9;

export const AXIS_CONVENTION = Object.freeze({
  positive_x: 'right',
  positive_y: 'up',
  positive_z: 'toward_viewer'
});

export const FEATURE_ANCHORS = Object.freeze({
  brow_l: Object.freeze({ x: -0.54, y: 0.62, z: 1.08 }),
  brow_r: Object.freeze({ x: 0.54, y: 0.62, z: 1.08 }),
  eye_l: Object.freeze({ x: -0.42, y: 0.32, z: 1.14 }),
  eye_r: Object.freeze({ x: 0.42, y: 0.32, z: 1.14 }),
  nose: Object.freeze({ x: 0, y: 0.04, z: 1.22 }),
  mouth: Object.freeze({ x: 0, y: -0.5, z: 1.14 }),
  neck: Object.freeze({ x: 0, y: -1.12, z: 0.28 })
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function copyMetrics(metrics) {
  return {
    confused: metrics.confused,
    frustration: metrics.frustration,
    confidence: metrics.confidence,
    urgency: metrics.urgency,
    stuckness: metrics.stuckness,
    fail_streak: metrics.fail_streak
  };
}

function normalizeState(state, nowMs) {
  const normalized = {
    session_id: state.session_id ?? null,
    updated_at: nowMs,
    last_event: state.last_event ?? null,
    metrics: {
      confused: clamp(state.metrics.confused, 0, 1),
      frustration: clamp(state.metrics.frustration, 0, 1),
      confidence: clamp(state.metrics.confidence, 0, 1),
      urgency: clamp(state.metrics.urgency, 0, 1),
      stuckness: clamp(state.metrics.stuckness, 0, 1),
      fail_streak: Math.max(0, Math.floor(state.metrics.fail_streak))
    },
    gesture: {
      type: state.gesture.type,
      started_at: state.gesture.started_at,
      duration_ms: state.gesture.duration_ms,
      amplitude: state.gesture.amplitude,
      polarity: state.gesture.polarity
    }
  };

  if (nowMs - normalized.gesture.started_at > normalized.gesture.duration_ms) {
    normalized.gesture = {
      type: 'none',
      started_at: nowMs,
      duration_ms: 0,
      amplitude: 0,
      polarity: 1
    };
  }

  return normalized;
}

function safeSeverity(raw) {
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    return 0.5;
  }
  return clamp(raw, 0, 1);
}

function noise(nowMs, phase, speed = 0.0027) {
  const t = nowMs * speed;
  return Math.sin(t + phase) * 0.6 + Math.sin(t * 0.53 + phase * 1.73) * 0.4;
}

function blinkPulse(nowMs, phase, frequencyHz, widthRatio = 0.1) {
  const safeFrequency = Math.max(0.05, frequencyHz);
  const cycleMs = 1000 / safeFrequency;
  const shifted = (nowMs + phase * 137) % cycleMs;
  const center = cycleMs * 0.5;
  const halfWidth = Math.max(1, cycleMs * widthRatio * 0.5);
  const normalized = 1 - clamp(Math.abs(shifted - center) / halfWidth, 0, 1);
  return normalized * normalized;
}

function startGesture(next, type, nowMs, amplitude, durationMs, polarity = 1) {
  next.gesture = {
    type,
    started_at: nowMs,
    duration_ms: durationMs,
    amplitude,
    polarity
  };
}

function clearGesture(next, nowMs) {
  next.gesture = {
    type: 'none',
    started_at: nowMs,
    duration_ms: 0,
    amplitude: 0,
    polarity: 1
  };
}

export function validateFeatureAnchors(anchors = FEATURE_ANCHORS) {
  return (
    anchors.brow_l.x < -EPSILON &&
    anchors.eye_l.x < -EPSILON &&
    anchors.brow_r.x > EPSILON &&
    anchors.eye_r.x > EPSILON
  );
}

export function validateFeatureDepth(anchors = FEATURE_ANCHORS) {
  return anchors.brow_l.z > 1.02 && anchors.brow_r.z > 1.02 && anchors.eye_l.z > 1.06 && anchors.eye_r.z > 1.06 && anchors.nose.z > 1.14 && anchors.mouth.z > 1.05;
}

export function createInitialFaceState(nowMs = Date.now()) {
  return {
    session_id: null,
    updated_at: nowMs,
    last_event: null,
    metrics: {
      confused: 0,
      frustration: 0,
      confidence: 0.5,
      urgency: 0,
      stuckness: 0,
      fail_streak: 0
    },
    gesture: {
      type: 'none',
      started_at: nowMs,
      duration_ms: 0,
      amplitude: 0,
      polarity: 1
    }
  };
}

export function applyEventToFaceState(previousState, payload, nowMs = Date.now()) {
  const base = previousState ?? createInitialFaceState(nowMs);
  const next = {
    session_id: payload?.session_id ?? base.session_id,
    updated_at: nowMs,
    last_event: base.last_event,
    metrics: copyMetrics(base.metrics),
    gesture: { ...base.gesture }
  };

  if (!payload || payload.type !== 'event') {
    return normalizeState(next, nowMs);
  }

  const severity = safeSeverity(payload.severity);
  const name = typeof payload.name === 'string' ? payload.name : 'idle';
  next.last_event = name;

  if (name === 'cmd_started') {
    next.metrics.urgency += 0.1 * severity;
  } else if (name === 'cmd_failed') {
    next.metrics.fail_streak += 1;
    next.metrics.confused += 0.2 * severity + Math.min(0.08 * next.metrics.fail_streak, 0.34);
    next.metrics.frustration += 0.16 * severity;
    next.metrics.confidence -= 0.16 * severity;

    if (next.metrics.fail_streak >= 2 || next.metrics.frustration > 0.45) {
      startGesture(next, 'shake', nowMs, 0.56 + 0.46 * next.metrics.frustration, 1220);
    } else {
      const polarity = next.metrics.fail_streak % 2 === 0 ? -1 : 1;
      startGesture(next, 'tilt', nowMs, 0.36 + 0.45 * next.metrics.confused, 1650, polarity);
    }
  } else if (name === 'cmd_succeeded') {
    next.metrics.fail_streak = 0;
    next.metrics.confused *= 0.36;
    next.metrics.frustration *= 0.45;
    next.metrics.stuckness *= 0.52;
    next.metrics.urgency *= 0.72;
    next.metrics.confidence = Math.max(next.metrics.confidence + 0.26, 0.74);
    {
      const confidenceBoost = clamp((next.metrics.confidence - 0.62) / 0.3, 0, 1);
      startGesture(next, 'nod', nowMs, 0.54 + 0.3 * next.metrics.confidence + 0.12 * confidenceBoost, 1180 + confidenceBoost * 820);
    }
  } else if (name === 'tests_failed') {
    next.metrics.stuckness += 0.3 + 0.16 * severity;
    next.metrics.fail_streak += 1;
    next.metrics.confused += 0.14 * severity;
    next.metrics.frustration += 0.08 * severity;
    startGesture(next, 'shake', nowMs, 0.62 + 0.32 * next.metrics.stuckness, 1280);
  } else if (name === 'tests_passed') {
    next.metrics.confused *= 0.32;
    next.metrics.stuckness *= 0.24;
    next.metrics.fail_streak = 0;
    next.metrics.frustration *= 0.5;
    next.metrics.urgency *= 0.62;
    next.metrics.confidence = Math.max(next.metrics.confidence + 0.3, 0.82);
    {
      const confidenceBoost = clamp((next.metrics.confidence - 0.6) / 0.34, 0, 1);
      startGesture(next, 'nod', nowMs, 0.56 + 0.32 * next.metrics.confidence + 0.14 * confidenceBoost, 1260 + confidenceBoost * 900);
    }
  } else if (name === 'permission_required') {
    next.metrics.urgency += 0.55;
    next.metrics.confidence -= 0.18;
    next.metrics.confused += 0.12;
    startGesture(next, 'tilt', nowMs, 0.56 + 0.32 * next.metrics.confused, 1800, 1);
  } else if (name === 'retrying') {
    next.metrics.urgency += 0.13;
    next.metrics.confused *= 0.86;
  } else if (name === 'idle') {
    next.metrics.urgency *= 0.18;
    next.metrics.confused *= 0.24;
    next.metrics.frustration *= 0.3;
    next.metrics.stuckness *= 0.22;
    // Return to neutral quickly after explicit idle signal.
    next.metrics.confidence = 0.5 + (next.metrics.confidence - 0.5) * 0.08;
    clearGesture(next, nowMs);
  }

  return normalizeState(next, nowMs);
}

export function stepFaceState(previousState, dtSeconds, nowMs = Date.now()) {
  const state = previousState ?? createInitialFaceState(nowMs);
  const dt = Math.max(0, Number.isFinite(dtSeconds) ? dtSeconds : 0);

  if (dt <= 0) {
    return normalizeState({ ...state, updated_at: nowMs }, nowMs);
  }

  const next = {
    session_id: state.session_id,
    updated_at: nowMs,
    last_event: state.last_event,
    metrics: copyMetrics(state.metrics),
    gesture: { ...state.gesture }
  };

  next.metrics.confused *= Math.exp(-dt / 12);
  next.metrics.frustration *= Math.exp(-dt / 20);
  next.metrics.urgency *= Math.exp(-dt / 18);
  next.metrics.stuckness *= Math.exp(-dt / 25);
  const confidenceTauSeconds = state.last_event === 'idle' ? 5 : 30;
  const confidenceBlend = clamp(dt / confidenceTauSeconds, 0, 1);
  next.metrics.confidence += (0.5 - next.metrics.confidence) * confidenceBlend;

  return normalizeState(next, nowMs);
}

function gestureContribution(gesture, nowMs) {
  if (!gesture || gesture.type === 'none' || gesture.duration_ms <= 0) {
    return { yaw: 0, pitch: 0, roll: 0 };
  }

  const elapsed = nowMs - gesture.started_at;
  if (elapsed <= 0 || elapsed > gesture.duration_ms) {
    return { yaw: 0, pitch: 0, roll: 0 };
  }

  const progress = clamp(elapsed / gesture.duration_ms, 0, 1);
  const damping = 1 - progress;

  if (gesture.type === 'nod') {
    return {
      yaw: 0,
      pitch: Math.sin(progress * Math.PI * 3.3) * gesture.amplitude * damping,
      roll: 0
    };
  }

  if (gesture.type === 'tilt') {
    const shape = progress < 0.25 ? progress / 0.25 : progress < 0.75 ? 1 : (1 - progress) / 0.25;
    return {
      yaw: 0,
      pitch: -0.08 * gesture.amplitude * shape,
      roll: gesture.polarity * gesture.amplitude * shape
    };
  }

  if (gesture.type === 'shake') {
    return {
      yaw: Math.sin(progress * Math.PI * 7.2) * gesture.amplitude * (0.7 + damping * 0.3),
      pitch: 0,
      roll: 0
    };
  }

  return { yaw: 0, pitch: 0, roll: 0 };
}

function confidenceBrowPulse(gesture, nowMs, intensity) {
  if (!gesture || gesture.type !== 'nod' || gesture.duration_ms <= 0) {
    return 0;
  }

  const elapsed = nowMs - gesture.started_at;
  if (elapsed <= 0 || elapsed >= gesture.duration_ms) {
    return 0;
  }

  const progress = clamp(elapsed / gesture.duration_ms, 0, 1);
  const envelope = 1 - progress;
  const wave = Math.max(0, Math.sin(progress * Math.PI * 7.2));
  return wave * envelope * intensity * 0.34;
}

function confidenceHeadPulse(gesture, nowMs, intensity) {
  if (!gesture || gesture.type !== 'nod' || gesture.duration_ms <= 0) {
    return 0;
  }

  const elapsed = nowMs - gesture.started_at;
  if (elapsed <= 0 || elapsed >= gesture.duration_ms) {
    return 0;
  }

  const progress = clamp(elapsed / gesture.duration_ms, 0, 1);
  const envelope = 1 - progress;
  const wave = Math.sin(progress * Math.PI * 4.4);
  const bias = 0.38;
  return -(bias + wave * 0.34) * envelope * intensity * 0.54;
}

function deriveModeIntensities(metrics) {
  return {
    confused: clamp(metrics.confused * 1.45 - 0.1, 0, 1),
    frustration: clamp(metrics.frustration * 1.55 - 0.08, 0, 1),
    confidence: clamp((metrics.confidence - 0.47) * 2.2, 0, 1),
    urgency: clamp(metrics.urgency * 1.65 - 0.06, 0, 1),
    stuckness: clamp(metrics.stuckness * 1.55 - 0.06, 0, 1)
  };
}

function pickDominantMode(intensity) {
  let dominant = 'neutral';
  let score = 0.16;
  for (const [mode, value] of Object.entries(intensity)) {
    if (value > score) {
      dominant = mode;
      score = value;
    }
  }
  return dominant;
}

export function deriveFaceControls(state, nowMs = Date.now()) {
  const activeState = state ?? createInitialFaceState(nowMs);
  const metrics = activeState.metrics;
  const intensity = deriveModeIntensities(metrics);
  const dominantMode = pickDominantMode(intensity);

  const jank = clamp(0.18 + 0.6 * metrics.confused + 0.28 * metrics.frustration + 0.14 * metrics.urgency, 0, 1);
  const activity = clamp(
    0.05 +
      0.62 * metrics.confused +
      0.62 * metrics.urgency +
      0.54 * metrics.frustration +
      0.44 * metrics.stuckness -
      0.22 * intensity.confidence,
    0,
    1
  );
  const blinkRateHz = 0.22 + 0.3 * jank + 0.16 * metrics.urgency;
  const blinkPrimary = blinkPulse(nowMs, 0.7, blinkRateHz, 0.1);
  const blinkLeft = clamp(blinkPrimary + blinkPulse(nowMs, 2.2, blinkRateHz * 0.68, 0.08) * 0.3, 0, 1);
  const blinkRight = clamp(blinkPrimary + blinkPulse(nowMs, 5.1, blinkRateHz * 0.65, 0.08) * 0.32, 0, 1);

  const browRaiseL = clamp(
    0.42 +
      0.38 * metrics.confidence -
      0.42 * metrics.frustration -
      0.22 * metrics.stuckness +
      noise(nowMs, 0.1, 0.0032) * 0.12 * jank,
    0,
    1
  );
  const browRaiseR = clamp(
    0.41 +
      0.39 * metrics.confidence -
      0.4 * metrics.frustration -
      0.2 * metrics.stuckness +
      noise(nowMs, 1.2, 0.0033) * 0.12 * jank,
    0,
    1
  );

  const browTilt = clamp(
    (metrics.confused * 0.46 - metrics.confidence * 0.18 - metrics.frustration * 0.08) + noise(nowMs, 2.2, 0.0028) * 0.12 * jank,
    -0.55,
    0.55
  );
  const browFurrow = clamp(0.03 + 0.62 * metrics.frustration + 0.36 * metrics.stuckness + 0.11 * metrics.urgency, 0, 1);

  const eyeOpenLBase = clamp(
    0.86 -
      0.5 * metrics.confused -
      0.4 * metrics.frustration +
      0.24 * metrics.confidence -
      0.12 * metrics.stuckness +
      noise(nowMs, 1.9, 0.0036) * 0.08 * jank,
    0.03,
    1
  );
  const eyeOpenRBase = clamp(
    0.85 -
      0.48 * metrics.confused -
      0.42 * metrics.frustration +
      0.25 * metrics.confidence -
      0.11 * metrics.stuckness +
      noise(nowMs, 3.1, 0.0034) * 0.08 * jank,
    0.03,
    1
  );
  const eyeOpenL = clamp(eyeOpenLBase * (1 - 0.94 * blinkLeft), 0.02, 1);
  const eyeOpenR = clamp(eyeOpenRBase * (1 - 0.94 * blinkRight), 0.02, 1);

  const orbitalX = Math.sin(nowMs * 0.0025 + metrics.confused * 1.2) * (0.04 + 0.24 * activity);
  const orbitalY = Math.cos(nowMs * 0.0023 + metrics.urgency * 1.1) * (0.03 + 0.19 * activity);
  const saccadeX = noise(nowMs, 4.4, 0.0032) * (0.03 + 0.2 * activity);
  const saccadeY = noise(nowMs, 5.2, 0.003) * (0.025 + 0.14 * activity);
  const gazeX = clamp(orbitalX + saccadeX + (metrics.urgency - 0.3) * 0.06, -1, 1);
  const gazeY = clamp(-0.04 - 0.22 * metrics.stuckness + orbitalY + saccadeY, -1, 1);

  const mouthOpen = clamp(
    0.07 +
      0.5 * metrics.urgency +
      0.34 * metrics.stuckness +
      0.24 * metrics.frustration -
      0.14 * metrics.confidence +
      noise(nowMs, 5.9, 0.0032) * 0.08 * jank,
    0,
    1
  );
  const mouthWide = clamp(0.34 + 0.35 * metrics.confidence - 0.18 * metrics.stuckness + 0.22 * metrics.urgency, 0, 1);

  const gesture = gestureContribution(activeState.gesture, nowMs);

  let yaw = clamp(
    (metrics.confused * 0.34 + metrics.urgency * 0.14 - metrics.confidence * 0.08) +
      noise(nowMs, 6.2, 0.0021) * 0.08 * activity +
      gazeX * 0.08 +
      gesture.yaw,
    -1,
    1
  );
  let pitch = clamp(
    -0.06 +
      metrics.confidence * 0.24 -
      metrics.frustration * 0.32 -
      metrics.stuckness * 0.18 +
      metrics.urgency * 0.08 +
      noise(nowMs, 7.7, 0.0023) * 0.08 * activity +
      gesture.pitch,
    -1,
    1
  );
  let roll = clamp(browTilt * 0.24 + noise(nowMs, 8.7, 0.0024) * 0.06 * activity + gesture.roll, -1, 1);
  let gazeXMode = gazeX;
  let gazeYMode = gazeY;
  let mouthOpenMode = mouthOpen;
  let mouthWideMode = mouthWide;
  let browRaiseLMode = browRaiseL;
  let browRaiseRMode = browRaiseR;
  let browTiltMode = browTilt;
  let browFurrowMode = browFurrow;
  let eyeOpenLMode = eyeOpenL;
  let eyeOpenRMode = eyeOpenR;

  if (dominantMode === 'confidence') {
    const browPulse = confidenceBrowPulse(activeState.gesture, nowMs, intensity.confidence);
    const headPulse = confidenceHeadPulse(activeState.gesture, nowMs, intensity.confidence);
    browRaiseLMode += 0.18 * intensity.confidence;
    browRaiseRMode += 0.18 * intensity.confidence;
    browRaiseLMode += browPulse;
    browRaiseRMode += browPulse;
    browTiltMode -= 0.66 * intensity.confidence;
    browFurrowMode -= 0.42 * intensity.confidence;
    eyeOpenLMode += 0.12 * intensity.confidence;
    eyeOpenRMode += 0.12 * intensity.confidence;
    gazeXMode *= 0.42;
    gazeYMode += 0.08 * intensity.confidence;
    mouthWideMode += 0.36 * intensity.confidence;
    mouthOpenMode -= 0.11 * intensity.confidence;
    pitch -= 0.72 * intensity.confidence;
    pitch += headPulse;
    pitch = Math.min(pitch, -0.28 - 0.34 * intensity.confidence);
    yaw *= 0.5;
    roll *= 0.4;
  } else if (dominantMode === 'frustration') {
    browRaiseLMode -= 0.18 * intensity.frustration;
    browRaiseRMode -= 0.18 * intensity.frustration;
    browTiltMode -= 0.58 * intensity.frustration;
    browFurrowMode += 0.34 * intensity.frustration;
    eyeOpenLMode -= 0.24 * intensity.frustration;
    eyeOpenRMode -= 0.24 * intensity.frustration;
    mouthWideMode -= 0.22 * intensity.frustration;
    mouthOpenMode += 0.16 * intensity.frustration;
    pitch -= 0.42 * intensity.frustration;
    yaw += Math.sin(nowMs * 0.0054 + 0.7) * 0.46 * intensity.frustration;
    roll += noise(nowMs, 12.1, 0.0032) * 0.1 * intensity.frustration;
  } else if (dominantMode === 'confused') {
    const upScan = Math.sin(nowMs * 0.0036 + 0.4);
    browTiltMode += 0.74 * intensity.confused;
    browRaiseLMode += 0.07 * intensity.confused;
    browRaiseRMode -= 0.07 * intensity.confused;
    gazeXMode += (0.16 + upScan * 0.22) * intensity.confused + noise(nowMs, 13.3, 0.0037) * 0.18 * intensity.confused;
    gazeYMode += 0.36 * intensity.confused + noise(nowMs, 13.9, 0.0031) * 0.12 * intensity.confused;
    mouthOpenMode += 0.1 * intensity.confused;
    pitch += 0.94 * intensity.confused;
    yaw += Math.sin(nowMs * 0.006 + 1.2) * 0.34 * intensity.confused;
    roll += noise(nowMs, 14.7, 0.0031) * 0.1 * intensity.confused;
  } else if (dominantMode === 'urgency') {
    browRaiseLMode += 0.15 * intensity.urgency;
    browRaiseRMode += 0.15 * intensity.urgency;
    eyeOpenLMode += 0.2 * intensity.urgency;
    eyeOpenRMode += 0.2 * intensity.urgency;
    gazeXMode += noise(nowMs, 15.2, 0.0045) * 0.22 * intensity.urgency;
    gazeYMode += 0.12 * intensity.urgency;
    mouthOpenMode += 0.2 * intensity.urgency;
    mouthWideMode += 0.1 * intensity.urgency;
    yaw += noise(nowMs, 16.1, 0.0038) * 0.16 * intensity.urgency;
    pitch += 0.24 * intensity.urgency;
  } else if (dominantMode === 'stuckness') {
    browRaiseLMode -= 0.1 * intensity.stuckness;
    browRaiseRMode -= 0.1 * intensity.stuckness;
    // Strong "へ" shape for stuck: inner brow up, outer brow down.
    browTiltMode += 0.86 * intensity.stuckness;
    browFurrowMode += 0.2 * intensity.stuckness;
    eyeOpenLMode -= 0.14 * intensity.stuckness;
    eyeOpenRMode -= 0.14 * intensity.stuckness;
    gazeYMode -= 0.28 * intensity.stuckness;
    mouthOpenMode += 0.14 * intensity.stuckness;
    mouthWideMode -= 0.26 * intensity.stuckness;
    pitch -= 0.84 * intensity.stuckness;
    yaw += Math.sin(nowMs * 0.0049 + 2.3) * 0.28 * intensity.stuckness;
    roll -= 0.08 * intensity.stuckness;
  } else {
    const calm = clamp(1 - activity * 1.25, 0, 1);
    gazeXMode *= 1 - 0.72 * calm;
    gazeYMode *= 1 - 0.52 * calm;
    yaw *= 1 - 0.54 * calm;
    pitch *= 1 - 0.72 * calm;
    roll *= 1 - 0.58 * calm;
    mouthOpenMode *= 1 - 0.34 * calm;
    browFurrowMode *= 1 - 0.35 * calm;
  }

  const yawFinal = clamp(yaw, -1, 1);
  const pitchFinal = clamp(pitch, -1, 1);
  const rollFinal = clamp(roll, -1, 1);

  const swayX = clamp(gazeXMode * 0.24 + yawFinal * 0.36 + gesture.yaw * 0.2, -1, 1);
  const swayY = clamp(-0.07 + pitchFinal * 0.44 + gesture.pitch * 0.24 + noise(nowMs, 9.9, 0.0017) * 0.08 * activity, -1, 1);
  const pushZ = clamp(
    0.1 + metrics.urgency * 0.2 - metrics.stuckness * 0.15 + mouthOpenMode * 0.12 + noise(nowMs, 10.5, 0.0016) * 0.05 * activity,
    -1,
    1
  );

  const browRaiseLFinal = clamp(browRaiseLMode, 0, 1);
  const browRaiseRFinal = clamp(browRaiseRMode, 0, 1);
  const browTiltFinal = clamp(browTiltMode, -1, 1);
  const browFurrowFinal = clamp(browFurrowMode, 0, 1);
  const eyeOpenLFinal = clamp(eyeOpenLMode, 0.02, 1);
  const eyeOpenRFinal = clamp(eyeOpenRMode, 0.02, 1);
  const gazeXFinal = clamp(gazeXMode, -1, 1);
  const gazeYFinal = clamp(gazeYMode, -1, 1);
  const mouthOpenFinal = clamp(mouthOpenMode, 0, 1);
  const mouthWideFinal = clamp(mouthWideMode, 0, 1);

  return {
    head: { yaw: yawFinal, pitch: pitchFinal, roll: rollFinal, sway_x: swayX, sway_y: swayY, push_z: pushZ },
    brows: {
      left: { raise: browRaiseLFinal },
      right: { raise: browRaiseRFinal },
      tilt: browTiltFinal,
      furrow: browFurrowFinal
    },
    eyes: {
      left: { open: eyeOpenLFinal },
      right: { open: eyeOpenRFinal },
      gaze_x: gazeXFinal,
      gaze_y: gazeYFinal
    },
    mouth: {
      open: mouthOpenFinal,
      wide: mouthWideFinal
    },
    debug: {
      jank,
      mode: dominantMode,
      brow_l: browRaiseLFinal,
      brow_r: browRaiseRFinal,
      eye_l: eyeOpenLFinal,
      eye_r: eyeOpenRFinal,
      blink_l: blinkLeft,
      blink_r: blinkRight,
      gaze_x: gazeXFinal,
      gaze_y: gazeYFinal,
      fail_streak: metrics.fail_streak
    }
  };
}
