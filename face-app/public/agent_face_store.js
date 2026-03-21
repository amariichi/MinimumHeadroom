import { matchesOperatorIdentity, resolveAgentIdForPayload } from './agent_dashboard_feed.js';
import { applyDragEmotionBias, applyEventToFaceState, createInitialFaceState, stepFaceState } from './state_engine.js';

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function blend(current, target, factor) {
  return current + (target - current) * clamp(factor, 0, 1);
}

const AGENT_FACE_DRAG_YAW_PER_PX = 0.0062;
const AGENT_FACE_DRAG_PITCH_PER_PX = 0.0062;
const AGENT_FACE_DRAG_ROLL_FROM_YAW = 0.18;
const AGENT_FACE_DRAG_OFFSET_MAX = 0.54;
const AGENT_FACE_DRAG_OFFSET_DECAY_PER_SECOND = 6.8;
const AGENT_FACE_DRAG_INTENSITY_DECAY_PER_SECOND = 8.4;
const AGENT_FACE_DRAG_SPEED_FOR_FULL_INTENSITY_PX_PER_SEC = 720;

function createDragState() {
  return {
    active: false,
    yawOffset: 0,
    pitchOffset: 0,
    intensity: 0,
    modeHint: null
  };
}

export function createAgentFaceRuntime(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  return {
    appearance: options.appearance ?? null,
    motion: options.motion ?? null,
    faceState: createInitialFaceState(nowMs),
    speech: {
      active: false,
      mouthOpen: 0,
      updatedAt: nowMs
    },
    drag: createDragState()
  };
}

export function resolveFaceAgentId(payload, agents = [], options = {}) {
  const mappedAgentId = resolveAgentIdForPayload(payload, agents, {
    operatorAgentId: options.operatorAgentId,
    operatorSessionId: options.operatorSessionId,
    operatorAliases: options.operatorAliases
  });
  if (mappedAgentId) {
    return mappedAgentId;
  }

  const payloadSessionId = asNonEmptyString(payload?.session_id);
  if (matchesOperatorIdentity(payloadSessionId, {
    operatorAgentId: options.operatorAgentId,
    operatorSessionId: options.operatorSessionId,
    operatorAliases: options.operatorAliases
  })) {
    return options.operatorAgentId ?? '__operator__';
  }

  // Unmatched payloads fall back to operator so speech bubbles and mouth sync always work
  if (options.operatorAgentId) {
    return options.operatorAgentId;
  }

  return null;
}

export function applyPayloadToAgentFaceRuntime(runtime, payload, nowMs = Date.now()) {
  if (!runtime || !payload || typeof payload !== 'object') {
    return runtime;
  }

  if (payload.type === 'event') {
    runtime.faceState = applyEventToFaceState(runtime.faceState, payload, nowMs);
    return runtime;
  }

  if (payload.type === 'operator_prompt') {
    runtime.faceState = applyEventToFaceState(
      runtime.faceState,
      {
        type: 'event',
        name: 'needs_attention',
        severity: payload.state === 'awaiting_approval' ? 0.85 : 0.55,
        session_id: payload.session_id
      },
      nowMs
    );
    return runtime;
  }

  if (payload.type === 'tts_state') {
    if (payload.phase === 'play_start') {
      runtime.speech.active = true;
    } else if (
      payload.phase === 'play_stop' ||
      payload.phase === 'interrupt_requested' ||
      payload.phase === 'dropped' ||
      payload.phase === 'error'
    ) {
      runtime.speech.active = false;
      runtime.speech.mouthOpen = 0;
    }
    runtime.speech.updatedAt = nowMs;
    return runtime;
  }

  if (payload.type === 'tts_mouth' && Number.isFinite(payload.open)) {
    runtime.speech.mouthOpen = clamp(Number(payload.open), 0, 1);
    if (runtime.speech.mouthOpen > 0.02) {
      runtime.speech.active = true;
    }
    runtime.speech.updatedAt = nowMs;
  }

  return runtime;
}

export function stepAgentFaceRuntime(runtime, dtSeconds, nowMs = Date.now()) {
  if (!runtime) {
    return runtime;
  }
  runtime.faceState = stepFaceState(runtime.faceState, dtSeconds, nowMs);
  if (runtime.drag?.intensity > 0.01) {
    runtime.faceState = applyDragEmotionBias(runtime.faceState, runtime.drag, dtSeconds, nowMs);
  }
  if (runtime.drag && runtime.drag.active !== true) {
    const offsetDecay = Math.exp(-AGENT_FACE_DRAG_OFFSET_DECAY_PER_SECOND * dtSeconds);
    const intensityDecay = Math.exp(-AGENT_FACE_DRAG_INTENSITY_DECAY_PER_SECOND * dtSeconds);
    runtime.drag.yawOffset *= offsetDecay;
    runtime.drag.pitchOffset *= offsetDecay;
    runtime.drag.intensity *= intensityDecay;
    if (Math.abs(runtime.drag.yawOffset) < 0.0006) {
      runtime.drag.yawOffset = 0;
    }
    if (Math.abs(runtime.drag.pitchOffset) < 0.0006) {
      runtime.drag.pitchOffset = 0;
    }
    if (runtime.drag.intensity < 0.004) {
      runtime.drag.intensity = 0;
    }
  }
  runtime.speech.mouthOpen = Math.max(0, runtime.speech.mouthOpen - dtSeconds * 1.2);
  if (runtime.speech.mouthOpen <= 0.01) {
    runtime.speech.mouthOpen = 0;
    if (nowMs - runtime.speech.updatedAt > 1200) {
      runtime.speech.active = false;
    }
  }
  return runtime;
}

export function applyAgentFaceRuntimeDragDelta(runtime, options = {}) {
  if (!runtime) {
    return runtime;
  }
  if (!runtime.drag) {
    runtime.drag = createDragState();
  }
  const deltaX = Number.isFinite(options.deltaX) ? Number(options.deltaX) : 0;
  const deltaY = Number.isFinite(options.deltaY) ? Number(options.deltaY) : 0;
  const speedPxPerSecond = Number.isFinite(options.speedPxPerSecond) ? Math.max(0, Number(options.speedPxPerSecond)) : 0;
  if (deltaX === 0 && deltaY === 0 && speedPxPerSecond === 0) {
    return runtime;
  }
  if (typeof options.modeHint === 'string' && options.modeHint.trim() !== '') {
    runtime.drag.modeHint = options.modeHint.trim();
  }
  runtime.drag.active = true;
  runtime.drag.yawOffset = clamp(
    runtime.drag.yawOffset + deltaX * AGENT_FACE_DRAG_YAW_PER_PX,
    -AGENT_FACE_DRAG_OFFSET_MAX,
    AGENT_FACE_DRAG_OFFSET_MAX
  );
  runtime.drag.pitchOffset = clamp(
    runtime.drag.pitchOffset + deltaY * AGENT_FACE_DRAG_PITCH_PER_PX,
    -AGENT_FACE_DRAG_OFFSET_MAX,
    AGENT_FACE_DRAG_OFFSET_MAX
  );
  const speedIntensity = clamp(speedPxPerSecond / AGENT_FACE_DRAG_SPEED_FOR_FULL_INTENSITY_PX_PER_SEC, 0, 1);
  const offsetIntensity = clamp(
    Math.hypot(runtime.drag.yawOffset, runtime.drag.pitchOffset) / AGENT_FACE_DRAG_OFFSET_MAX,
    0,
    1
  );
  const targetIntensity = Math.max(speedIntensity, offsetIntensity * 0.88);
  runtime.drag.intensity = blend(runtime.drag.intensity, targetIntensity, 0.42);
  return runtime;
}

export function setAgentFaceRuntimeDragActive(runtime, active) {
  if (!runtime) {
    return runtime;
  }
  if (!runtime.drag) {
    runtime.drag = createDragState();
  }
  runtime.drag.active = active === true;
  return runtime;
}

export function applyAgentFaceRuntimeDragToControls(runtime, controls) {
  if (!runtime?.drag || !controls?.head) {
    return controls;
  }
  controls.head.yaw = clamp(controls.head.yaw + runtime.drag.yawOffset, -1, 1);
  controls.head.pitch = clamp(controls.head.pitch + runtime.drag.pitchOffset, -1, 1);
  controls.head.roll = clamp(controls.head.roll + runtime.drag.yawOffset * AGENT_FACE_DRAG_ROLL_FROM_YAW, -1, 1);
  controls.head.sway_x = clamp(controls.head.sway_x + runtime.drag.yawOffset * 0.36, -1, 1);
  controls.head.sway_y = clamp(controls.head.sway_y + runtime.drag.pitchOffset * 0.32, -1, 1);
  return controls;
}
