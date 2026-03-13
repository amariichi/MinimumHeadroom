function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashString(value) {
  const text = typeof value === 'string' && value.trim() !== '' ? value.trim() : 'agent';
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalized(seed, shift) {
  return ((seed >>> shift) & 0xff) / 255;
}

export function createFaceIdleMotionProfile(seedText = 'agent') {
  const seed = hashString(seedText);
  return {
    seed: seedText,
    timeOffsetMs: seed % 17_000,
    headAmplitude: 0.38 + normalized(seed, 4) * 0.38,
    gazeAmplitude: 0.32 + normalized(seed, 12) * 0.34,
    browAmplitude: 0.18 + normalized(seed, 20) * 0.2,
    blinkBias: normalized(seed, 24) * 0.18,
    pace: 0.84 + normalized(seed, 8) * 0.46
  };
}

export function applyIdleMotionToControls(controls, nowMs, profile, options = {}) {
  if (!controls || !profile) {
    return controls;
  }
  const strength = clamp(Number.isFinite(options.strength) ? options.strength : 1, 0, 2);
  const pace = profile.pace ?? 1;
  const t = ((nowMs ?? Date.now()) + (profile.timeOffsetMs ?? 0)) * 0.001 * pace;

  const headWave = Math.sin(t * 0.92 + 0.6) * 0.6 + Math.sin(t * 0.37 + 1.7) * 0.4;
  const driftWave = Math.sin(t * 0.73 + 2.3) * 0.58 + Math.sin(t * 0.29 + 0.2) * 0.42;
  const browWave = Math.sin(t * 1.17 + 0.8) * 0.56 + Math.sin(t * 0.41 + 1.9) * 0.44;
  const blinkBias = profile.blinkBias ?? 0;

  controls.head.sway_x = clamp(controls.head.sway_x + driftWave * 0.14 * profile.headAmplitude * strength, -1, 1);
  controls.head.sway_y = clamp(controls.head.sway_y + headWave * 0.12 * profile.headAmplitude * strength, -1, 1);
  controls.head.roll = clamp(controls.head.roll + driftWave * 0.08 * profile.headAmplitude * strength, -1, 1);

  controls.eyes.gaze_x = clamp(controls.eyes.gaze_x + driftWave * 0.22 * profile.gazeAmplitude * strength, -1, 1);
  controls.eyes.gaze_y = clamp(controls.eyes.gaze_y + headWave * 0.18 * profile.gazeAmplitude * strength, -1, 1);

  controls.brows.left.raise = clamp(controls.brows.left.raise + browWave * 0.12 * profile.browAmplitude * strength + blinkBias * 0.03, 0, 1);
  controls.brows.right.raise = clamp(controls.brows.right.raise - browWave * 0.12 * profile.browAmplitude * strength + blinkBias * 0.03, 0, 1);

  return controls;
}
