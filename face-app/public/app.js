import * as THREE from 'three';
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
} from './state_engine.js';
import { createDoubleTapTracker, shouldIgnoreToggleTarget } from './gesture_controls.js';

const canvas = document.getElementById('face-canvas');
const stageEl = document.getElementById('stage');
const wsStatusEl = document.getElementById('ws-status');
const renderModeEl = document.getElementById('render-mode');
const lgStatusEl = document.getElementById('lg-status');
const ttsStatusEl = document.getElementById('tts-status');
const ttsPhaseEl = document.getElementById('tts-phase');
const sessionIdEl = document.getElementById('session-id');
const viewportSizeEl = document.getElementById('viewport-size');
const anchorStatusEl = document.getElementById('anchor-status');
const stateValuesEl = document.getElementById('state-values');
const debugValuesEl = document.getElementById('debug-values');
const eventLogEl = document.getElementById('event-log');
const utteranceEl = document.getElementById('utterance');
const lgEnabledInput = document.getElementById('lg-enabled');
const lgApplyButton = document.getElementById('lg-apply');
const xrButtonSlot = document.getElementById('xr-button-slot');
const uiHiddenHintEl = document.getElementById('ui-hidden-hint');
const audioReplayButtonEl = document.getElementById('audio-replay');
const uiPanels = Array.from(document.querySelectorAll('.panel'));

const LOOKING_GLASS_ENABLED_KEY = 'mh_lg_webxr_enabled';
const HEAD_LIMITS = {
  yaw: (28 * Math.PI) / 180,
  pitch: (38 * Math.PI) / 180,
  roll: (23 * Math.PI) / 180
};
const XR_SESSION_TYPE = 'immersive-vr';
const LG_POLYFILL_SOURCES = [
  'https://unpkg.com/@lookingglass/webxr@0.6.0/dist/bundle/webxr.js',
  'https://cdn.jsdelivr.net/npm/@lookingglass/webxr@0.6.0/dist/bundle/webxr.js',
  'https://unpkg.com/@lookingglass/webxr@0.6.0/dist/@lookingglass/bundle/webxr.js',
  'https://cdn.jsdelivr.net/npm/@lookingglass/webxr@0.6.0/dist/@lookingglass/bundle/webxr.js'
];
const SILENT_WAV_SAMPLE_RATE = 24_000;
const SILENT_WAV_DURATION_MS = 60;
const UNLOCK_TIMEOUT_MS = 1200;
const DOUBLE_TAP_MAX_INTERVAL_MS = 520;
const DOUBLE_TAP_MAX_DISTANCE_PX = 44;
const DRAG_START_THRESHOLD_PX = 10;
const DRAG_YAW_PER_PX = 0.0084;
const DRAG_PITCH_PER_PX = 0.0084;
const DRAG_ROLL_FROM_YAW = 0.18;
const DRAG_OFFSET_MAX = 0.8;
const DRAG_OFFSET_DECAY_PER_SECOND = 6;
const DRAG_INTENSITY_DECAY_PER_SECOND = 7.5;
const DRAG_SPEED_FOR_FULL_INTENSITY_PX_PER_SEC = 780;
const FACE_ROOT_BASE_Y = 0.56;

function toneColor(tone) {
  if (tone === 'ok') {
    return 'var(--accent-ok)';
  }
  if (tone === 'warn') {
    return 'var(--accent-hot)';
  }
  return 'var(--accent-cold)';
}

function formatValue(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '-';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setMetricValue(element, text, tone = 'default') {
  element.textContent = text;
  element.style.color = toneColor(tone);
}

function setWsStatus(label, tone) {
  setMetricValue(wsStatusEl, label, tone);
}

function setLgStatus(label, tone = 'default', details = null) {
  setMetricValue(lgStatusEl, label, tone);
  if (details) {
    stateValuesEl.textContent = details;
  }
}

function setTtsStatus(label, tone = 'default') {
  setMetricValue(ttsStatusEl, label, tone);
}

function setTtsPhase(label, tone = 'default') {
  setMetricValue(ttsPhaseEl, label, tone);
}

function savedLookingGlassEnabled() {
  const stored = localStorage.getItem(LOOKING_GLASS_ENABLED_KEY);
  return stored !== '0';
}

function writeLookingGlassEnabled(value) {
  localStorage.setItem(LOOKING_GLASS_ENABLED_KEY, value ? '1' : '0');
}

function enforceSideX(value, side) {
  if (side === 'left') {
    return Math.min(value, -0.08);
  }
  return Math.max(value, 0.08);
}

function enforceFrontZ(value) {
  return Math.max(1.01, value);
}

function createFaceRig(scene) {
  const root = new THREE.Group();
  root.position.set(0, FACE_ROOT_BASE_Y, 0);
  root.scale.setScalar(0.8);
  scene.add(root);

  const neckPivot = new THREE.Group();
  neckPivot.position.set(0, -0.35, 0);
  root.add(neckPivot);

  const materials = {
    skin: new THREE.MeshStandardMaterial({ color: 0xc9905a, roughness: 0.56, metalness: 0.06 }),
    hair: new THREE.MeshStandardMaterial({ color: 0x2c1d16, roughness: 0.82, metalness: 0.02 }),
    brow: new THREE.MeshStandardMaterial({ color: 0x1a110c, roughness: 0.9, metalness: 0 }),
    eyeWhite: new THREE.MeshStandardMaterial({ color: 0xeef6ff, roughness: 0.2, metalness: 0 }),
    pupil: new THREE.MeshStandardMaterial({ color: 0x111722, roughness: 0.4, metalness: 0.04 }),
    nose: new THREE.MeshStandardMaterial({ color: 0x8e5933, roughness: 0.58, metalness: 0.05 }),
    mouthOuter: new THREE.MeshStandardMaterial({ color: 0x4a1b14, roughness: 0.66, metalness: 0.02 }),
    mouthInner: new THREE.MeshStandardMaterial({ color: 0xe37f62, roughness: 0.36, metalness: 0.02 })
  };

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.31, 0.78, 18), materials.skin);
  neck.position.set(FEATURE_ANCHORS.neck.x, FEATURE_ANCHORS.neck.y + 0.28, FEATURE_ANCHORS.neck.z - 0.08);
  neck.renderOrder = 1;
  root.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(1, 52, 38), materials.skin);
  head.scale.set(1.25, 1.42, 1.08);
  head.position.set(0, 0.16, 0);
  head.renderOrder = 2;
  neckPivot.add(head);

  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.9, 40, 22, 0, Math.PI * 2, 0, Math.PI * 0.44), materials.hair);
  hair.scale.set(1.08, 0.54, 0.9);
  hair.position.set(0, 1.1, -0.04);
  hair.renderOrder = 3;
  neckPivot.add(hair);

  const browGeometry = new THREE.BoxGeometry(0.68, 0.11, 0.1);
  const browLeft = new THREE.Mesh(browGeometry, materials.brow);
  const browRight = new THREE.Mesh(browGeometry, materials.brow);
  browLeft.renderOrder = 4;
  browRight.renderOrder = 4;
  neckPivot.add(browLeft);
  neckPivot.add(browRight);

  const eyeWhiteGeometry = new THREE.SphereGeometry(0.25, 28, 20);
  const pupilGeometry = new THREE.SphereGeometry(0.094, 20, 16);

  const eyeWhiteLeft = new THREE.Mesh(eyeWhiteGeometry, materials.eyeWhite);
  const eyeWhiteRight = new THREE.Mesh(eyeWhiteGeometry, materials.eyeWhite);
  const pupilLeft = new THREE.Mesh(pupilGeometry, materials.pupil);
  const pupilRight = new THREE.Mesh(pupilGeometry, materials.pupil);

  eyeWhiteLeft.scale.set(1.45, 1, 0.8);
  eyeWhiteRight.scale.set(1.45, 1, 0.8);

  eyeWhiteLeft.renderOrder = 5;
  eyeWhiteRight.renderOrder = 5;
  pupilLeft.renderOrder = 6;
  pupilRight.renderOrder = 6;

  neckPivot.add(eyeWhiteLeft);
  neckPivot.add(eyeWhiteRight);
  neckPivot.add(pupilLeft);
  neckPivot.add(pupilRight);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.36, 4), materials.nose);
  nose.rotation.x = Math.PI / 2;
  nose.renderOrder = 6;
  neckPivot.add(nose);

  const mouthOuter = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.13, 0.12), materials.mouthOuter);
  const mouthInner = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.09, 0.1), materials.mouthInner);
  mouthOuter.renderOrder = 6;
  mouthInner.renderOrder = 7;
  neckPivot.add(mouthOuter);
  neckPivot.add(mouthInner);

  return {
    root,
    neckPivot,
    hair,
    browLeft,
    browRight,
    eyeWhiteLeft,
    eyeWhiteRight,
    pupilLeft,
    pupilRight,
    nose,
    mouthOuter,
    mouthInner
  };
}

function applyControlsToRig(rig, controls) {
  const swayX = clamp(controls.head.sway_x ?? controls.head.yaw * 0.5, -1, 1);
  const swayY = clamp(controls.head.sway_y ?? controls.head.pitch * 0.5, -1, 1);
  const pushZ = clamp(controls.head.push_z ?? 0, -1, 1);

  rig.root.position.set(swayX * 0.2, FACE_ROOT_BASE_Y + swayY * 0.33, pushZ * 0.12);
  rig.root.rotation.y = controls.head.yaw * 0.08;

  rig.neckPivot.rotation.y = controls.head.yaw * HEAD_LIMITS.yaw;
  rig.neckPivot.rotation.x = controls.head.pitch * HEAD_LIMITS.pitch;
  rig.neckPivot.rotation.z = controls.head.roll * HEAD_LIMITS.roll;

  const furrowOffset = controls.brows.furrow * 0.14;
  const browTilt = controls.brows.tilt;

  const browLeftX = enforceSideX(FEATURE_ANCHORS.brow_l.x + furrowOffset, 'left');
  const browRightX = enforceSideX(FEATURE_ANCHORS.brow_r.x - furrowOffset, 'right');
  const browZ = enforceFrontZ(FEATURE_ANCHORS.brow_l.z + 0.03 + controls.brows.furrow * 0.03);

  rig.browLeft.position.set(browLeftX, FEATURE_ANCHORS.brow_l.y + (controls.brows.left.raise - 0.5) * 0.46, browZ);
  rig.browRight.position.set(browRightX, FEATURE_ANCHORS.brow_r.y + (controls.brows.right.raise - 0.5) * 0.46, browZ);

  rig.browLeft.rotation.z = browTilt * 0.56;
  rig.browRight.rotation.z = -browTilt * 0.56;

  const browScaleBase = 1.08 + controls.brows.furrow * 0.2;
  const browThickness = 1 - controls.brows.furrow * 0.12;
  rig.browLeft.scale.set(browScaleBase, browThickness, 1);
  rig.browRight.scale.set(browScaleBase, browThickness, 1);

  const eyeOpenLeft = clamp(controls.eyes.left.open, 0.02, 1);
  const eyeOpenRight = clamp(controls.eyes.right.open, 0.02, 1);

  const eyeLeftX = enforceSideX(FEATURE_ANCHORS.eye_l.x + controls.eyes.gaze_x * 0.04, 'left');
  const eyeRightX = enforceSideX(FEATURE_ANCHORS.eye_r.x + controls.eyes.gaze_x * 0.04, 'right');
  const eyeY = FEATURE_ANCHORS.eye_l.y + controls.eyes.gaze_y * 0.045;
  const eyeZ = enforceFrontZ(FEATURE_ANCHORS.eye_l.z + controls.brows.furrow * 0.01);

  rig.eyeWhiteLeft.position.set(eyeLeftX, eyeY, eyeZ);
  rig.eyeWhiteRight.position.set(eyeRightX, eyeY, eyeZ);

  rig.eyeWhiteLeft.scale.set(1.45, Math.max(0.02, eyeOpenLeft), 0.8);
  rig.eyeWhiteRight.scale.set(1.45, Math.max(0.02, eyeOpenRight), 0.8);

  const pupilYOffset = controls.eyes.gaze_y * 0.08;
  const pupilZ = enforceFrontZ(FEATURE_ANCHORS.eye_l.z + 0.19);

  rig.pupilLeft.position.set(eyeLeftX + controls.eyes.gaze_x * 0.11, eyeY + pupilYOffset, pupilZ);
  rig.pupilRight.position.set(eyeRightX + controls.eyes.gaze_x * 0.11, eyeY + pupilYOffset, pupilZ);

  rig.nose.position.set(FEATURE_ANCHORS.nose.x, FEATURE_ANCHORS.nose.y + controls.eyes.gaze_y * 0.03, enforceFrontZ(FEATURE_ANCHORS.nose.z));

  const mouthOpen = clamp(controls.mouth.open, 0, 1);
  const mouthWide = clamp(controls.mouth.wide, 0, 1);

  rig.mouthOuter.position.set(FEATURE_ANCHORS.mouth.x, FEATURE_ANCHORS.mouth.y - mouthOpen * 0.03, enforceFrontZ(FEATURE_ANCHORS.mouth.z));
  rig.mouthInner.position.set(
    FEATURE_ANCHORS.mouth.x,
    FEATURE_ANCHORS.mouth.y + 0.01 - mouthOpen * 0.045,
    enforceFrontZ(FEATURE_ANCHORS.mouth.z + 0.02)
  );

  rig.mouthOuter.scale.set(0.86 + mouthWide * 0.78, 0.26 + mouthOpen * 2.12, 1);
  rig.mouthInner.scale.set(0.78 + mouthWide * 0.68, 0.16 + mouthOpen * 1.94, 1);

  const hairLift = 1.1 + controls.debug.jank * 0.016;
  rig.hair.position.set(0, hairLift, -0.04);
}

function createScene(renderer) {
  const scene = new THREE.Scene();

  const ambientLight = new THREE.AmbientLight(0xd8ecff, 0.64);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xfff2df, 0.95);
  keyLight.position.set(2.8, 2.7, 3.8);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x8ac9ff, 0.5);
  fillLight.position.set(-2.4, 0.4, 2.8);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xff8f58, 0.34);
  rimLight.position.set(0.7, 2.2, -2.5);
  scene.add(rimLight);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 35);
  camera.position.set(0, 0.1, 5.55);
  camera.lookAt(0, 0.3, 0);

  const rig = createFaceRig(scene);

  renderer.xr.enabled = true;
  renderer.setClearColor(0x000000, 0);

  return { scene, camera, rig };
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  powerPreference: 'high-performance'
});
renderer.outputColorSpace = THREE.SRGBColorSpace;

const { scene, camera, rig } = createScene(renderer);

const anchorSignsOk = validateFeatureAnchors(FEATURE_ANCHORS);
const anchorDepthOk = validateFeatureDepth(FEATURE_ANCHORS);
const anchorSummary = `x:${anchorSignsOk ? 'ok' : 'bad'} z:${anchorDepthOk ? 'ok' : 'bad'} (+x=${AXIS_CONVENTION.positive_x} +y=${AXIS_CONVENTION.positive_y} +z=${AXIS_CONVENTION.positive_z})`;
setMetricValue(anchorStatusEl, anchorSummary, anchorSignsOk && anchorDepthOk ? 'ok' : 'warn');

let faceState = createInitialFaceState(Date.now());
let targetControls = deriveFaceControls(faceState, performance.now());
let renderedControls = JSON.parse(JSON.stringify(targetControls));
let lastFrameMs = performance.now();
let utteranceExpiresAt = 0;
let speechMouthOpen = 0;
let speechActive = false;

const events = [];
let reconnectAttempts = 0;
let reconnectTimer = null;
let socket = null;
let xrButtonEl = null;
let panelsVisible = true;
const latestSayMetaBySession = new Map();
const latestAudioMetaBySession = new Map();
let playbackAudioEl = null;
let unlockInFlight = null;
let audioUnlocked = false;
let pendingReplayPayload = null;
let activeAudioGeneration = null;
let activeAudioSourceRelease = null;
let silentAudioDataUrl = null;
const registerDoubleTap = createDoubleTapTracker({
  maxIntervalMs: DOUBLE_TAP_MAX_INTERVAL_MS,
  maxDistancePx: DOUBLE_TAP_MAX_DISTANCE_PX
});
const dragState = {
  pointerId: null,
  pointerType: null,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  lastTimeMs: 0,
  startTarget: null,
  dragging: false,
  yawOffset: 0,
  pitchOffset: 0,
  intensity: 0,
  modeHint: null
};

const view = {
  width: 0,
  height: 0,
  dpr: 1
};

function resizeRenderer() {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));

  view.width = width;
  view.height = height;
  view.dpr = dpr;

  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);

  camera.aspect = width / height;
  const portraitBias = clamp((height - width) / Math.max(height, width), 0, 1);
  camera.fov = 36 + portraitBias * 7.5;
  camera.position.y = 0.2 + portraitBias * 0.05;
  camera.position.z = 5.72 + portraitBias * 1.62;
  camera.lookAt(0, 0.36, 0);
  camera.updateProjectionMatrix();

  viewportSizeEl.textContent = `${width}x${height} @${dpr.toFixed(2)}`;
}

function blend(current, target, alpha) {
  return current + (target - current) * alpha;
}

function blendControls(current, target, alpha) {
  current.head.yaw = blend(current.head.yaw, target.head.yaw, alpha);
  current.head.pitch = blend(current.head.pitch, target.head.pitch, alpha);
  current.head.roll = blend(current.head.roll, target.head.roll, alpha);
  current.head.sway_x = blend(current.head.sway_x, target.head.sway_x, alpha);
  current.head.sway_y = blend(current.head.sway_y, target.head.sway_y, alpha);
  current.head.push_z = blend(current.head.push_z, target.head.push_z, alpha);

  current.brows.left.raise = blend(current.brows.left.raise, target.brows.left.raise, alpha);
  current.brows.right.raise = blend(current.brows.right.raise, target.brows.right.raise, alpha);
  current.brows.tilt = blend(current.brows.tilt, target.brows.tilt, alpha);
  current.brows.furrow = blend(current.brows.furrow, target.brows.furrow, alpha);

  current.eyes.left.open = blend(current.eyes.left.open, target.eyes.left.open, alpha);
  current.eyes.right.open = blend(current.eyes.right.open, target.eyes.right.open, alpha);
  current.eyes.gaze_x = blend(current.eyes.gaze_x, target.eyes.gaze_x, alpha);
  current.eyes.gaze_y = blend(current.eyes.gaze_y, target.eyes.gaze_y, alpha);

  current.mouth.open = blend(current.mouth.open, target.mouth.open, alpha);
  current.mouth.wide = blend(current.mouth.wide, target.mouth.wide, alpha);

  current.debug.brow_l = blend(current.debug.brow_l, target.debug.brow_l, alpha);
  current.debug.brow_r = blend(current.debug.brow_r, target.debug.brow_r, alpha);
  current.debug.eye_l = blend(current.debug.eye_l, target.debug.eye_l, alpha);
  current.debug.eye_r = blend(current.debug.eye_r, target.debug.eye_r, alpha);
  current.debug.blink_l = blend(current.debug.blink_l, target.debug.blink_l, alpha);
  current.debug.blink_r = blend(current.debug.blink_r, target.debug.blink_r, alpha);
  current.debug.gaze_x = blend(current.debug.gaze_x, target.debug.gaze_x, alpha);
  current.debug.gaze_y = blend(current.debug.gaze_y, target.debug.gaze_y, alpha);
  current.debug.jank = blend(current.debug.jank, target.debug.jank, alpha);
  current.debug.mode = target.debug.mode;
  current.debug.fail_streak = target.debug.fail_streak;
}

function updateHud() {
  const metrics = faceState.metrics;

  stateValuesEl.textContent = [
    `confused     ${formatValue(metrics.confused)}`,
    `frustration  ${formatValue(metrics.frustration)}`,
    `confidence   ${formatValue(metrics.confidence)}`,
    `urgency      ${formatValue(metrics.urgency)}`,
    `stuckness    ${formatValue(metrics.stuckness)}`,
    `fail_streak  ${metrics.fail_streak}`
  ].join('\n');

  debugValuesEl.textContent = [
    `mode    ${String(renderedControls.debug.mode ?? '-')}`,
    `drag    ${dragState.pointerId !== null && dragState.dragging ? 'active' : 'idle'}   hint    ${String(dragState.modeHint ?? '-')}`,
    `drag_y  ${formatValue(dragState.yawOffset)}   drag_p  ${formatValue(dragState.pitchOffset)}   drag_i  ${formatValue(dragState.intensity)}`,
    `brow_l  ${formatValue(renderedControls.debug.brow_l)}   brow_r  ${formatValue(renderedControls.debug.brow_r)}`,
    `eye_l   ${formatValue(renderedControls.debug.eye_l)}   eye_r   ${formatValue(renderedControls.debug.eye_r)}`,
    `blink_l ${formatValue(renderedControls.debug.blink_l)}   blink_r ${formatValue(renderedControls.debug.blink_r)}`,
    `gaze_x  ${formatValue(renderedControls.debug.gaze_x)}   gaze_y  ${formatValue(renderedControls.debug.gaze_y)}`,
    `yaw     ${formatValue(renderedControls.head.yaw)}   pitch   ${formatValue(renderedControls.head.pitch)}`,
    `roll    ${formatValue(renderedControls.head.roll)}   jank    ${formatValue(renderedControls.debug.jank)}`,
    `axis    +x:${AXIS_CONVENTION.positive_x} +y:${AXIS_CONVENTION.positive_y} +z:${AXIS_CONVENTION.positive_z}`
  ].join('\n');
}

function appendEvent(payload) {
  if (payload.type === 'tts_mouth') {
    return;
  }

  const timeText = new Date().toLocaleTimeString('ja-JP', { hour12: false });
  const label =
    payload.type === 'event'
      ? `${payload.name ?? 'event'} s=${formatValue(payload.severity ?? 0.5)}`
      : payload.type === 'say'
        ? `say ${String(payload.text ?? '').slice(0, 30)}`
        : payload.type === 'say_result'
          ? `say_result spoken=${payload.spoken === true ? 'yes' : 'no'} reason=${payload.reason ?? '-'}`
        : payload.type === 'tts_state'
          ? `tts ${String(payload.phase ?? '-')}${payload.reason ? `:${payload.reason}` : ''}`
        : payload.type === 'tts_audio'
          ? `tts_audio gen=${Number.isInteger(payload.generation) ? payload.generation : '-'}`
        : `${payload.type ?? 'unknown'}`;

  events.unshift(`${timeText}  ${label}`);
  if (events.length > 8) {
    events.length = 8;
  }

  eventLogEl.innerHTML = '';
  for (const item of events) {
    const entry = document.createElement('li');
    entry.textContent = item;
    eventLogEl.appendChild(entry);
  }
}

function showUtterance(text, ttlMs) {
  utteranceEl.textContent = text;
  utteranceEl.classList.remove('hidden');
  const ttl = typeof ttlMs === 'number' && Number.isFinite(ttlMs) ? ttlMs : 3500;
  utteranceExpiresAt = Date.now() + Math.max(900, Math.min(ttl, 10_000));
}

function resolvePayloadRevision(payload) {
  if (Number.isFinite(payload?.revision)) {
    return Math.floor(payload.revision);
  }
  if (Number.isFinite(payload?.ts)) {
    return Math.floor(payload.ts);
  }
  return Date.now();
}

function resolvePayloadMessageId(payload) {
  if (typeof payload?.message_id === 'string' && payload.message_id.trim() !== '') {
    return payload.message_id.trim();
  }
  if (typeof payload?.utterance_id === 'string' && payload.utterance_id.trim() !== '') {
    return payload.utterance_id.trim();
  }
  return null;
}

function resolvePayloadSessionId(payload) {
  const sessionId = typeof payload?.session_id === 'string' && payload.session_id.trim() !== '' ? payload.session_id : '-';
  return sessionId;
}

function shouldUseLatestPayload(payload, latestBySession) {
  const sessionId = resolvePayloadSessionId(payload);
  const revision = resolvePayloadRevision(payload);
  const messageId = resolvePayloadMessageId(payload);
  const latest = latestBySession.get(sessionId);

  if (latest && Number.isFinite(latest.revision)) {
    if (revision < latest.revision) {
      return false;
    }
    if (revision === latest.revision && messageId && latest.messageId && messageId === latest.messageId) {
      return false;
    }
  }

  latestBySession.set(sessionId, { revision, messageId });
  return true;
}

function shouldDisplaySay(payload) {
  return shouldUseLatestPayload(payload, latestSayMetaBySession);
}

function shouldPlayTtsAudio(payload) {
  return shouldUseLatestPayload(payload, latestAudioMetaBySession);
}

function ensurePlaybackAudioElement() {
  if (playbackAudioEl) {
    return playbackAudioEl;
  }

  const player = new Audio();
  player.preload = 'auto';
  player.playsInline = true;
  player.setAttribute('playsinline', 'true');
  player.setAttribute('webkit-playsinline', 'true');
  player.volume = 1;
  player.addEventListener('ended', () => {
    releaseActiveAudioSource();
    resetActiveAudio();
  });
  player.addEventListener('error', () => {
    releaseActiveAudioSource();
    resetActiveAudio();
    setTtsPhase('browser_error', 'warn');
  });
  playbackAudioEl = player;
  return player;
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => {
        reject(new Error('audio unlock timeout'));
      }, timeoutMs);
    })
  ]);
}

function createSilentAudioDataUrl() {
  if (silentAudioDataUrl) {
    return silentAudioDataUrl;
  }

  const sampleCount = Math.max(1, Math.floor((SILENT_WAV_SAMPLE_RATE * SILENT_WAV_DURATION_MS) / 1000));
  const dataSize = sampleCount * 2;
  const totalSize = 44 + dataSize;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);

  function writeAscii(offset, text) {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  }

  writeAscii(0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SILENT_WAV_SAMPLE_RATE, true);
  view.setUint32(28, SILENT_WAV_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  silentAudioDataUrl = `data:audio/wav;base64,${btoa(binary)}`;
  return silentAudioDataUrl;
}

function buildPlaybackSource(mimeType, audioBase64) {
  if (typeof Blob === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof atob === 'function') {
    try {
      const binary = atob(audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const blob = new Blob([bytes], { type: mimeType });
      const objectUrl = URL.createObjectURL(blob);
      return {
        src: objectUrl,
        release() {
          URL.revokeObjectURL(objectUrl);
        }
      };
    } catch {
      // Fall through to data URL fallback.
    }
  }

  return {
    src: `data:${mimeType};base64,${audioBase64}`,
    release: null
  };
}

async function unlockPlaybackAudio() {
  if (audioUnlocked) {
    return true;
  }

  if (unlockInFlight) {
    return unlockInFlight;
  }

  const player = ensurePlaybackAudioElement();
  if (!player.paused) {
    audioUnlocked = true;
    return true;
  }

  unlockInFlight = (async () => {
    const originalSrc = player.src;
    try {
      player.src = createSilentAudioDataUrl();
      player.currentTime = 0;
      await withTimeout(Promise.resolve(player.play()), UNLOCK_TIMEOUT_MS);
      audioUnlocked = true;
      return true;
    } finally {
      try {
        player.pause();
      } catch {
        // Ignore pause errors in unlock cleanup.
      }
      try {
        player.currentTime = 0;
      } catch {
        // Ignore seek errors in unlock cleanup.
      }
      player.src = originalSrc;
      unlockInFlight = null;
    }
  })();

  return unlockInFlight;
}

function hideAudioReplayButton() {
  if (!audioReplayButtonEl) {
    return;
  }
  audioReplayButtonEl.classList.add('hidden');
}

function showAudioReplayButton() {
  if (!audioReplayButtonEl) {
    return;
  }
  audioReplayButtonEl.classList.remove('hidden');
}

function resetActiveAudio() {
  activeAudioGeneration = null;
}

function releaseActiveAudioSource() {
  if (typeof activeAudioSourceRelease === 'function') {
    activeAudioSourceRelease();
    activeAudioSourceRelease = null;
  }
}

function stopActiveBrowserAudio(generation = null) {
  if (!playbackAudioEl) {
    resetActiveAudio();
    return;
  }
  if (Number.isInteger(generation) && Number.isInteger(activeAudioGeneration) && generation !== activeAudioGeneration) {
    return;
  }

  try {
    playbackAudioEl.pause();
  } catch {
    // Ignore pause errors while stopping active browser audio.
  }
  try {
    playbackAudioEl.currentTime = 0;
  } catch {
    // Ignore seek errors while stopping active browser audio.
  }
  releaseActiveAudioSource();
  resetActiveAudio();
}

function queueReplayPayload(payload) {
  pendingReplayPayload = payload;
  showAudioReplayButton();
}

async function playAudioSource(src, generation = null, release = null) {
  const player = ensurePlaybackAudioElement();
  stopActiveBrowserAudio();
  player.src = src;
  player.currentTime = 0;
  activeAudioSourceRelease = typeof release === 'function' ? release : null;
  try {
    await player.play();
    activeAudioGeneration = Number.isInteger(generation) ? generation : null;
  } catch (error) {
    releaseActiveAudioSource();
    throw error;
  }
}

async function playBrowserAudioPayload(payload) {
  if (!shouldPlayTtsAudio(payload)) {
    return;
  }
  if (typeof payload.audio_base64 !== 'string' || payload.audio_base64.trim() === '') {
    return;
  }

  const mimeType = typeof payload.mime_type === 'string' && payload.mime_type.trim() !== '' ? payload.mime_type.trim() : 'audio/wav';
  const source = buildPlaybackSource(mimeType, payload.audio_base64);
  const generation = Number.isInteger(payload.generation) ? payload.generation : null;

  try {
    await unlockPlaybackAudio();
    await playAudioSource(source.src, generation, source.release);
    pendingReplayPayload = null;
    hideAudioReplayButton();
  } catch {
    if (typeof source.release === 'function') {
      source.release();
    }
    queueReplayPayload({
      mimeType,
      audioBase64: payload.audio_base64,
      generation
    });
    setTtsPhase('browser_blocked', 'warn');
  }
}

function handleTtsAudio(payload) {
  void playBrowserAudioPayload(payload);
}

function handleTtsState(payload) {
  const phase = typeof payload.phase === 'string' ? payload.phase : '-';
  const audioTarget = typeof payload.audio_target === 'string' ? payload.audio_target : 'local';
  const reason = typeof payload.reason === 'string' ? payload.reason : null;

  if (phase === 'worker_ready') {
    if (payload.playback_backend === 'silent' && audioTarget === 'local') {
      setTtsStatus('silent', 'warn');
      setTtsPhase('worker_ready:silent', 'warn');
      return;
    }

    setTtsStatus('ready', 'ok');
    setTtsPhase(phase, 'ok');
    return;
  }

  if (phase === 'worker_unavailable' || phase === 'worker_error') {
    setTtsStatus('unavailable', 'warn');
    setTtsPhase(phase, 'warn');
    speechActive = false;
    speechMouthOpen = 0;
    return;
  }

  if (phase === 'play_start') {
    setTtsStatus('speaking', 'ok');
    setTtsPhase(phase, 'ok');
    speechActive = true;
    return;
  }

  if (phase === 'play_stop') {
    if (reason === 'interrupted') {
      stopActiveBrowserAudio(payload.generation);
    }
    setTtsStatus('ready', 'ok');
    setTtsPhase(phase, 'default');
    speechActive = false;
    speechMouthOpen = 0;
    return;
  }

  if (phase === 'interrupt_requested') {
    stopActiveBrowserAudio(payload.generation);
    setTtsStatus('busy', 'default');
    setTtsPhase(`${phase}:${reason ?? '-'}`, 'default');
    return;
  }

  if (phase === 'synth_start' || phase === 'queued') {
    setTtsStatus('busy', 'default');
    setTtsPhase(phase, 'default');
    return;
  }

  if (phase === 'dropped') {
    stopActiveBrowserAudio(payload.generation);
    setTtsPhase(`dropped:${payload.reason ?? '-'}`, 'warn');
    if (!speechActive) {
      setTtsStatus('ready', 'default');
    }
    return;
  }

  if (phase === 'error') {
    stopActiveBrowserAudio(payload.generation);
    setTtsStatus('error', 'warn');
    setTtsPhase(`error:${payload.reason ?? '-'}`, 'warn');
    speechActive = false;
    speechMouthOpen = 0;
    return;
  }

  setTtsPhase(phase, 'default');
}

function handleTtsMouth(payload) {
  if (typeof payload.open !== 'number' || !Number.isFinite(payload.open)) {
    return;
  }

  speechMouthOpen = clamp(payload.open, 0, 1);
  if (speechMouthOpen > 0.02) {
    speechActive = true;
  }
}

function handleSayResult(payload) {
  const spoken = payload.spoken === true;
  if (!spoken) {
    setTtsPhase(`dropped:${payload.reason ?? '-'}`, 'warn');
    if (!speechActive) {
      setTtsStatus('ready', 'default');
    }
    return;
  }

  if (payload.queued) {
    setTtsStatus('busy', 'default');
    setTtsPhase('queued', 'default');
  }
}

function handlePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  if (typeof payload.session_id === 'string' && payload.session_id.trim() !== '' && payload.session_id !== '-') {
    faceState.session_id = payload.session_id;
    sessionIdEl.textContent = payload.session_id;
  }

  appendEvent(payload);

  if (payload.type === 'event') {
    faceState = applyEventToFaceState(faceState, payload, Date.now());
  } else if (payload.type === 'say' && typeof payload.text === 'string' && payload.text.trim() !== '') {
    if (shouldDisplaySay(payload)) {
      showUtterance(payload.text, payload.ttl_ms);
    }
  } else if (payload.type === 'say_result') {
    handleSayResult(payload);
  } else if (payload.type === 'tts_state') {
    handleTtsState(payload);
  } else if (payload.type === 'tts_mouth') {
    handleTtsMouth(payload);
  } else if (payload.type === 'tts_audio') {
    handleTtsAudio(payload);
  }
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${window.location.host}/ws`;

  setWsStatus('connecting', 'default');

  socket = new WebSocket(wsUrl);

  socket.addEventListener('open', () => {
    reconnectAttempts = 0;
    setWsStatus('online', 'ok');
  });

  socket.addEventListener('message', async (event) => {
    try {
      const raw = typeof event.data === 'string' ? event.data : await event.data.text();
      handlePayload(JSON.parse(raw));
    } catch {
      setWsStatus('decode-error', 'warn');
    }
  });

  socket.addEventListener('error', () => {
    setWsStatus('socket-error', 'warn');
  });

  socket.addEventListener('close', () => {
    setWsStatus('offline', 'warn');

    if (reconnectTimer !== null) {
      return;
    }

    const waitMs = Math.min(6000, 800 + reconnectAttempts * 450);
    reconnectAttempts += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, waitMs);
  });
}

async function installLookingGlassPolyfill() {
  const enabled = savedLookingGlassEnabled();
  lgEnabledInput.checked = enabled;

  if (!enabled) {
    setLgStatus('disabled', 'warn');
    return false;
  }

  const errors = [];

  for (const source of LG_POLYFILL_SOURCES) {
    try {
      const module = await import(source);
      const namespace = module.default && typeof module.default === 'object' ? module.default : module;
      const PolyfillCtor = module.LookingGlassWebXRPolyfill ?? namespace.LookingGlassWebXRPolyfill ?? window.LookingGlassWebXRPolyfill;
      const config = module.LookingGlassConfig ?? namespace.LookingGlassConfig ?? window.LookingGlassConfig;

      if (typeof PolyfillCtor !== 'function' || !config || typeof config !== 'object') {
        throw new Error('module exports missing LookingGlassWebXRPolyfill/LookingGlassConfig');
      }

      config.targetY = 0;
      config.targetZ = 0;
      config.targetDiam = 3;
      config.fovy = (40 * Math.PI) / 180;
      config.depthiness = 0.55;

      if (!window.__mhLookingGlassPolyfillInstalled) {
        new PolyfillCtor();
        window.__mhLookingGlassPolyfillInstalled = true;
      }

      if (!navigator.xr || typeof navigator.xr.requestSession !== 'function') {
        throw new Error('navigator.xr is unavailable after polyfill init');
      }

      setLgStatus(`ready (${new URL(source).host})`, 'ok');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${source} -> ${message}`);
    }
  }

  setLgStatus('unavailable', 'warn', `lg polyfill load failed:\n${errors.join('\n')}`);
  return false;
}

function updateXrButtonLabel() {
  if (!xrButtonEl) {
    return;
  }
  xrButtonEl.textContent = renderer.xr.isPresenting ? 'Exit XR' : 'View in XR';
}

function setPanelsVisible(visible) {
  panelsVisible = visible;
  for (const panel of uiPanels) {
    panel.classList.toggle('panel-hidden', !visible);
  }
  uiHiddenHintEl.classList.toggle('hidden', visible);
}

function togglePanelsVisible() {
  setPanelsVisible(!panelsVisible);
}

function registerTapForPanelToggle(timestampMs, x, y, target) {
  if (shouldIgnoreToggleTarget(target)) {
    return;
  }

  if (registerDoubleTap(timestampMs, x, y)) {
    togglePanelsVisible();
  }
}

function beginDragTracking(pointerId, pointerType, x, y, timestampMs, target) {
  dragState.pointerId = pointerId;
  dragState.pointerType = pointerType;
  dragState.startX = x;
  dragState.startY = y;
  dragState.lastX = x;
  dragState.lastY = y;
  dragState.lastTimeMs = timestampMs;
  dragState.startTarget = target;
  dragState.dragging = false;
  dragState.modeHint = null;
}

function updateDragTracking(pointerId, x, y, timestampMs) {
  if (dragState.pointerId === null || dragState.pointerId !== pointerId) {
    return;
  }

  const deltaX = x - dragState.lastX;
  const deltaY = y - dragState.lastY;
  const elapsedMs = Math.max(1, timestampMs - dragState.lastTimeMs);
  const movementFromStartPx = Math.hypot(x - dragState.startX, y - dragState.startY);
  const speedPxPerSecond = Math.hypot(deltaX, deltaY) / (elapsedMs / 1000);

  if (!dragState.dragging && movementFromStartPx >= DRAG_START_THRESHOLD_PX) {
    dragState.dragging = true;
    dragState.modeHint = String(targetControls.debug.mode ?? 'neutral');
  }

  if (dragState.dragging) {
    dragState.yawOffset = clamp(dragState.yawOffset + deltaX * DRAG_YAW_PER_PX, -DRAG_OFFSET_MAX, DRAG_OFFSET_MAX);
    dragState.pitchOffset = clamp(dragState.pitchOffset + deltaY * DRAG_PITCH_PER_PX, -DRAG_OFFSET_MAX, DRAG_OFFSET_MAX);

    const speedIntensity = clamp(speedPxPerSecond / DRAG_SPEED_FOR_FULL_INTENSITY_PX_PER_SEC, 0, 1);
    const offsetIntensity = clamp(Math.hypot(dragState.yawOffset, dragState.pitchOffset) / DRAG_OFFSET_MAX, 0, 1);
    const targetIntensity = Math.max(speedIntensity, offsetIntensity * 0.86);
    dragState.intensity = blend(dragState.intensity, targetIntensity, 0.42);
  }

  dragState.lastX = x;
  dragState.lastY = y;
  dragState.lastTimeMs = timestampMs;
}

function endDragTracking(pointerId, x, y, timestampMs, target, canceled = false) {
  if (dragState.pointerId === null || dragState.pointerId !== pointerId) {
    return;
  }

  const wasDragging = dragState.dragging;
  const pointerType = dragState.pointerType;
  const tapTarget = target ?? dragState.startTarget;

  dragState.pointerId = null;
  dragState.pointerType = null;
  dragState.startX = 0;
  dragState.startY = 0;
  dragState.lastX = x;
  dragState.lastY = y;
  dragState.lastTimeMs = timestampMs;
  dragState.startTarget = null;
  dragState.dragging = false;

  if (canceled || wasDragging || pointerType === 'mouse') {
    return;
  }

  registerTapForPanelToggle(timestampMs, x, y, tapTarget);
}

function decayDragOffsets(dtSeconds) {
  if (dragState.pointerId !== null && dragState.dragging) {
    return;
  }

  const offsetDecay = Math.exp(-DRAG_OFFSET_DECAY_PER_SECOND * dtSeconds);
  const intensityDecay = Math.exp(-DRAG_INTENSITY_DECAY_PER_SECOND * dtSeconds);
  dragState.yawOffset *= offsetDecay;
  dragState.pitchOffset *= offsetDecay;
  dragState.intensity *= intensityDecay;

  if (Math.abs(dragState.yawOffset) < 0.0006) {
    dragState.yawOffset = 0;
  }
  if (Math.abs(dragState.pitchOffset) < 0.0006) {
    dragState.pitchOffset = 0;
  }
  if (dragState.intensity < 0.004) {
    dragState.intensity = 0;
  }
}

function applyDragOffsetsToControls(controls) {
  const yawOffset = dragState.yawOffset;
  const pitchOffset = dragState.pitchOffset;
  const rollOffset = yawOffset * DRAG_ROLL_FROM_YAW;

  controls.head.yaw = clamp(controls.head.yaw + yawOffset, -1, 1);
  controls.head.pitch = clamp(controls.head.pitch + pitchOffset, -1, 1);
  controls.head.roll = clamp(controls.head.roll + rollOffset, -1, 1);
  controls.head.sway_x = clamp(controls.head.sway_x + yawOffset * 0.36, -1, 1);
  controls.head.sway_y = clamp(controls.head.sway_y + pitchOffset * 0.32, -1, 1);
}

function handleStagePointerDown(event) {
  if (event.isPrimary === false) {
    return;
  }

  if (event.pointerType === 'mouse' && event.button !== 0) {
    return;
  }

  if (shouldIgnoreToggleTarget(event.target)) {
    return;
  }

  beginDragTracking(event.pointerId, event.pointerType, event.clientX, event.clientY, event.timeStamp, event.target);
  if (typeof stageEl.setPointerCapture === 'function') {
    try {
      stageEl.setPointerCapture(event.pointerId);
    } catch {
      // Ignore capture errors on browsers that restrict this by input source.
    }
  }
}

function handleStagePointerMove(event) {
  updateDragTracking(event.pointerId, event.clientX, event.clientY, event.timeStamp);
}

function handleStagePointerUp(event) {
  if (typeof stageEl.releasePointerCapture === 'function') {
    try {
      stageEl.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore release errors when capture was never set.
    }
  }
  endDragTracking(event.pointerId, event.clientX, event.clientY, event.timeStamp, event.target, false);
}

function handleStagePointerCancel(event) {
  endDragTracking(event.pointerId, event.clientX, event.clientY, event.timeStamp, event.target, true);
}

function handleStageTouchStart(event) {
  if (dragState.pointerId !== null || event.changedTouches.length < 1) {
    return;
  }

  const touch = event.changedTouches[0];
  if (shouldIgnoreToggleTarget(event.target)) {
    return;
  }
  beginDragTracking(touch.identifier, 'touch', touch.clientX, touch.clientY, event.timeStamp, event.target);
}

function findTrackedTouch(touchList) {
  for (let index = 0; index < touchList.length; index += 1) {
    const touch = touchList[index];
    if (touch.identifier === dragState.pointerId) {
      return touch;
    }
  }
  return null;
}

function handleStageTouchMove(event) {
  if (dragState.pointerId === null) {
    return;
  }
  const touch = findTrackedTouch(event.touches);
  if (!touch) {
    return;
  }
  updateDragTracking(touch.identifier, touch.clientX, touch.clientY, event.timeStamp);
}

function handleStageTouchEnd(event) {
  if (dragState.pointerId === null) {
    return;
  }
  const touch = findTrackedTouch(event.changedTouches);
  if (!touch) {
    return;
  }
  endDragTracking(touch.identifier, touch.clientX, touch.clientY, event.timeStamp, event.target, false);
}

function handleStageTouchCancel(event) {
  if (dragState.pointerId === null) {
    return;
  }
  const touch = findTrackedTouch(event.changedTouches);
  if (!touch) {
    return;
  }
  endDragTracking(touch.identifier, touch.clientX, touch.clientY, event.timeStamp, event.target, true);
}

function handleStageDoubleClick(event) {
  if (shouldIgnoreToggleTarget(event.target)) {
    return;
  }
  event.preventDefault();
  togglePanelsVisible();
}

function installGestureShortcuts() {
  if (!stageEl) {
    return;
  }

  stageEl.addEventListener('dblclick', handleStageDoubleClick);

  if (typeof window.PointerEvent === 'function') {
    stageEl.addEventListener('pointerdown', handleStagePointerDown, { passive: true });
    stageEl.addEventListener('pointermove', handleStagePointerMove, { passive: true });
    stageEl.addEventListener('pointerup', handleStagePointerUp, { passive: true });
    stageEl.addEventListener('pointercancel', handleStagePointerCancel, { passive: true });
  } else {
    stageEl.addEventListener('touchstart', handleStageTouchStart, { passive: true });
    stageEl.addEventListener('touchmove', handleStageTouchMove, { passive: true });
    stageEl.addEventListener('touchend', handleStageTouchEnd, { passive: true });
    stageEl.addEventListener('touchcancel', handleStageTouchCancel, { passive: true });
  }
}

function installAudioUnlockHooks() {
  const triggerUnlock = () => {
    void unlockPlaybackAudio();
  };

  window.addEventListener('pointerdown', triggerUnlock, { passive: true });
  window.addEventListener('touchstart', triggerUnlock, { passive: true });
  window.addEventListener('touchend', triggerUnlock, { passive: true });
  window.addEventListener('click', triggerUnlock, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void unlockPlaybackAudio();
    }
  });
}

function installAudioReplayButton() {
  if (!audioReplayButtonEl) {
    return;
  }

  audioReplayButtonEl.addEventListener('click', () => {
    if (!pendingReplayPayload) {
      return;
    }

    const replay = pendingReplayPayload;
    pendingReplayPayload = null;
    void (async () => {
      try {
        const directSource = buildPlaybackSource(replay.mimeType, replay.audioBase64);
        await playAudioSource(directSource.src, replay.generation, directSource.release);
        audioUnlocked = true;
        hideAudioReplayButton();
      } catch {
        try {
          await unlockPlaybackAudio();
          const retrySource = buildPlaybackSource(replay.mimeType, replay.audioBase64);
          await playAudioSource(retrySource.src, replay.generation, retrySource.release);
          audioUnlocked = true;
          hideAudioReplayButton();
        } catch {
          queueReplayPayload(replay);
          setTtsPhase('browser_blocked', 'warn');
        }
      }
    })();
  });
}

async function startXrSession() {
  if (!navigator.xr || typeof navigator.xr.requestSession !== 'function') {
    setMetricValue(renderModeEl, 'xr-api-missing', 'warn');
    return;
  }

  try {
    const session = await navigator.xr.requestSession(XR_SESSION_TYPE, {
      optionalFeatures: ['local-floor']
    });
    await renderer.xr.setSession(session);
  } catch (error) {
    setMetricValue(renderModeEl, 'xr-start-failed', 'warn');
    stateValuesEl.textContent = `xr start failed: ${error.message}`;
  }
}

async function toggleXrSession() {
  if (renderer.xr.isPresenting) {
    const session = renderer.xr.getSession();
    if (session) {
      await session.end();
    }
    return;
  }
  await startXrSession();
}

function mountXrButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.addEventListener('click', () => {
    toggleXrSession().catch((error) => {
      setMetricValue(renderModeEl, 'xr-toggle-failed', 'warn');
      stateValuesEl.textContent = `xr toggle failed: ${error.message}`;
    });
  });
  xrButtonSlot.appendChild(button);
  xrButtonEl = button;
  updateXrButtonLabel();

  renderer.xr.addEventListener('sessionstart', () => {
    setMetricValue(renderModeEl, 'looking-glass-xr', 'ok');
    updateXrButtonLabel();
  });

  renderer.xr.addEventListener('sessionend', () => {
    setMetricValue(renderModeEl, 'monitor', 'default');
    updateXrButtonLabel();
  });
}

function tick(nowMs) {
  const dtSeconds = Math.min(0.12, Math.max(0.001, (nowMs - lastFrameMs) / 1000));
  lastFrameMs = nowMs;

  faceState = stepFaceState(faceState, dtSeconds, Date.now());
  targetControls = deriveFaceControls(faceState, nowMs);
  decayDragOffsets(dtSeconds);

  if (dragState.intensity > 0.01) {
    faceState = applyDragEmotionBias(
      faceState,
      {
        intensity: dragState.intensity,
        modeHint: dragState.modeHint
      },
      dtSeconds,
      Date.now()
    );
    targetControls = deriveFaceControls(faceState, nowMs);
  }

  applyDragOffsetsToControls(targetControls);

  const speechBlendOpen = clamp(speechMouthOpen, 0, 1);
  if (speechActive || speechBlendOpen > 0.01) {
    targetControls.mouth.open = clamp(Math.max(targetControls.mouth.open * 0.46, speechBlendOpen * 1.08), 0, 1);
    targetControls.mouth.wide = clamp(Math.max(targetControls.mouth.wide, 0.44 + speechBlendOpen * 0.58), 0, 1);
  }

  speechMouthOpen = Math.max(0, speechMouthOpen - dtSeconds * 1.2);

  blendControls(renderedControls, targetControls, Math.min(1, dtSeconds * 11.8));
  applyControlsToRig(rig, renderedControls);

  if (utteranceExpiresAt > 0 && Date.now() >= utteranceExpiresAt) {
    utteranceEl.classList.add('hidden');
    utteranceExpiresAt = 0;
  }

  updateHud();
  renderer.render(scene, camera);
}

let resizeObserver;

async function bootstrap() {
  setMetricValue(renderModeEl, 'monitor', 'default');
  setTtsStatus('starting', 'default');
  setTtsPhase('-', 'default');

  await installLookingGlassPolyfill();
  mountXrButton();
  installGestureShortcuts();
  installAudioUnlockHooks();
  installAudioReplayButton();

  lgApplyButton.addEventListener('click', () => {
    writeLookingGlassEnabled(lgEnabledInput.checked);
    window.location.reload();
  });

  resizeRenderer();
  window.addEventListener('resize', resizeRenderer);

  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => resizeRenderer());
    resizeObserver.observe(document.documentElement);
  }

  connectWebSocket();
  renderer.setAnimationLoop(tick);
}

bootstrap().catch((error) => {
  setMetricValue(wsStatusEl, 'boot-error', 'warn');
  setMetricValue(lgStatusEl, 'boot-error', 'warn');
  stateValuesEl.textContent = `bootstrap failed: ${error.message}`;
});

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.repeat) {
    return;
  }
  event.preventDefault();
  togglePanelsVisible();
});

window.addEventListener('beforeunload', () => {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }

  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }

  stopActiveBrowserAudio();
  renderer.setAnimationLoop(null);
  renderer.dispose();
});
