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
import { createInitialOperatorUiState, deriveOperatorUiFlags, reduceOperatorUiState } from './operator_ui_state.js';
import { isDefaultAnsiStyle, parseAnsiRuns } from './operator_ansi.js';
import { getOperatorRealtimeAsrSuspicion, resolveOperatorRealtimeAsrFinalText, shouldAcceptOperatorBatchFallbackResult } from './operator_asr_text.js';
import { normalizeOperatorAsrTerms } from './operator_asr_term_normalizer.js';
import { createTapBurstTrigger } from './operator_hidden_recovery.js';
import { resolveOperatorKeyboardCommandAction, resolveOperatorKeyboardPttLanguage } from './operator_keyboard_ptt.js';
import { buildOperatorTextInsertion, normalizeOperatorTextSelection } from './operator_text_insert.js';
import {
  BROWSER_AUDIO_MAX_CHANNELS_DEFAULT,
  clampBrowserAudioMaxChannels,
  selectBrowserAudioChannelIndex,
  shouldStopBrowserAudioChannel
} from './browser_audio_policy.js';
import {
  deriveAgentTileTone,
  deriveDashboardMode,
  normalizeDashboardAgent,
  sortDashboardAgents,
  summarizeAgentTileMessage
} from './agent_dashboard_state.js';
import { applyAgentResultToAgents } from './agent_dashboard_apply_result.js';
import { listAgentLifecycleActions, shouldShowMobileAgentList } from './agent_dashboard_actions.js';
import { summarizeAgentActionFailure, summarizeAgentActionSuccess } from './agent_dashboard_action_feedback.js';
import {
  deriveAgentTransientUpdate,
  resolveAgentIdForPayload as resolveFeedAgentIdForPayload
} from './agent_dashboard_feed.js';

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
const operatorPanelEl = document.getElementById('operator-panel');
const operatorHandleEl = document.getElementById('operator-handle');
const operatorEscButtonEl = document.getElementById('operator-esc');
const operatorEscInlineButtonEl = document.getElementById('operator-esc-inline');
const operatorCloseButtonEl = document.getElementById('operator-close');
const operatorRestartButtonEl = document.getElementById('operator-restart');
const operatorTitleEl = document.getElementById('operator-title');
const operatorStatusEl = document.getElementById('operator-status');
const operatorPromptEl = document.getElementById('operator-prompt');
const operatorAgentListEl = document.getElementById('operator-agent-list');
const operatorAgentListItemsEl = document.getElementById('operator-agent-list-items');
const operatorAckEl = document.getElementById('operator-ack');
const operatorChoiceButtonsEl = document.getElementById('operator-choice-buttons');
const operatorApprovalMetaEl = document.getElementById('operator-approval-meta');
const operatorPttJaButtonEl = document.getElementById('operator-ptt-ja');
const operatorPttEnButtonEl = document.getElementById('operator-ptt-en');
const operatorTextCardEl = document.getElementById('operator-text-card');
const operatorTextInputEl = document.getElementById('operator-text-input');
const operatorTextSendButtonEl = document.getElementById('operator-text-send');
const operatorTextClearButtonEl = document.getElementById('operator-text-clear');
const operatorTextCancelButtonEl = document.getElementById('operator-text-cancel');
const operatorKeyUpEl = document.getElementById('operator-key-up');
const operatorKeyDownEl = document.getElementById('operator-key-down');
const operatorKeyEnterEl = document.getElementById('operator-key-enter');
const operatorMirrorToggleEl = document.getElementById('operator-mirror-toggle');
const operatorHelpToggleEl = document.getElementById('operator-help-toggle');
const operatorKeyboardHelpEl = document.getElementById('operator-keyboard-help');
const operatorMirrorEl = document.getElementById('operator-mirror');
const agentDashboardEl = document.getElementById('agent-dashboard');
const agentDashboardStatusEl = document.getElementById('agent-dashboard-status');
const agentDashboardGridEl = document.getElementById('agent-dashboard-grid');
const agentDashboardRefreshButtonEl = document.getElementById('agent-dashboard-refresh');
const agentDashboardAddToggleButtonEl = document.getElementById('agent-dashboard-add-toggle');
const agentDashboardAddFormEl = document.getElementById('agent-dashboard-add-form');
const agentDashboardAddIdEl = document.getElementById('agent-dashboard-id');
const agentDashboardAddSessionIdEl = document.getElementById('agent-dashboard-session-id');
const agentDashboardAddRepoPathEl = document.getElementById('agent-dashboard-repo-path');
const agentDashboardAddBranchEl = document.getElementById('agent-dashboard-branch');
const agentDashboardAddSubmitEl = document.getElementById('agent-dashboard-add-submit');

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
const OPERATOR_ASR_MAX_RECORDING_MS = 30_000;
const OPERATOR_MIN_AUDIO_BLOB_BYTES = 900;
const OPERATOR_REALTIME_ASR_DEFAULT_SAMPLE_RATE = 16_000;
const OPERATOR_REALTIME_ASR_PROCESSOR_BUFFER_SIZE = 4096;
const OPERATOR_REALTIME_BATCH_FALLBACK_MIN_SECONDS = 0.25;
const OPERATOR_KEYBOARD_MODIFIER_PTT_DELAY_MS = 140;
const OPERATOR_ESC_RECOVERY_REQUIRED_TAPS = 4;
const OPERATOR_ESC_RECOVERY_WINDOW_MS = 1_600;
const OPERATOR_RECOVER_PENDING_TIMEOUT_MS = 3_000;
const OPERATOR_UI_MODE_AUTO = 'auto';
const OPERATOR_UI_MODE_PC = 'pc';
const OPERATOR_UI_MODE_MOBILE = 'mobile';
const OPERATOR_UI_MODES = new Set([OPERATOR_UI_MODE_AUTO, OPERATOR_UI_MODE_PC, OPERATOR_UI_MODE_MOBILE]);
const OPERATOR_MIRROR_DEFAULT_FG_CSS_VAR = 'var(--operator-mirror-fg)';
const OPERATOR_MIRROR_DEFAULT_BG_CSS_VAR = 'var(--operator-mirror-bg-solid)';
const OPERATOR_MIRROR_FOLLOW_THRESHOLD_PX = 24;
const AGENT_DASHBOARD_POLL_INTERVAL_MS = 2_400;
const AGENT_TILE_MESSAGE_TTL_MS = 11_000;
const AGENT_TILE_SPEAKING_TTL_MS = 6_000;
const MIC_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
};

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
let unlockAudioEl = null;
let unlockInFlight = null;
let audioUnlocked = false;
let pendingReplayPayload = null;
let browserAudioMixer = null;
let browserAudioMaxChannels = BROWSER_AUDIO_MAX_CHANNELS_DEFAULT;
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
let operatorUiState = createInitialOperatorUiState();
let operatorActivePrompt = null;
let operatorTerminalSnapshotLines = [];
let operatorMirrorAutoFollow = true;
let operatorMirrorInitialScrollDone = false;
let operatorKeyboardHelpOpen = false;
const operatorBatchAsrConfig = {
  enabled: false
};
const operatorRealtimeAsrConfig = {
  enabled: false,
  sampleRateHz: OPERATOR_REALTIME_ASR_DEFAULT_SAMPLE_RATE
};
const operatorMicState = {
  recorder: null,
  stream: null,
  chunks: [],
  recording: false,
  pointerArmed: false,
  keyboardArmedKey: null,
  keyboardPendingKey: null,
  keyboardPendingTimer: null,
  language: 'en',
  startedAtMs: 0,
  stopTimer: null,
  mode: 'batch',
  audioContext: null,
  sourceNode: null,
  processorNode: null,
  processorSinkNode: null,
  realtimeDraftActive: false,
  realtimeBaseText: '',
  realtimeSelectionStart: 0,
  realtimeSelectionEnd: 0,
  realtimeText: '',
  realtimeGeneration: 0,
  realtimePcmChunks: [],
  realtimePcmBytes: 0
};
let operatorConfiguredUiMode = OPERATOR_UI_MODE_AUTO;
let operatorEffectiveUiMode = OPERATOR_UI_MODE_PC;
let operatorPanelEnabled = true;
let operatorRecoverPending = false;
let operatorRecoverPendingTimer = null;
let agentDashboardPollTimer = null;
let agentDashboardLoadInFlight = null;
let agentDashboardAddFormOpen = false;
let agentDashboardAddPending = false;
let agentDashboardState = {
  mode: 'single',
  selectedAgentId: null,
  agents: [],
  loaded: false
};
const agentTransientStateById = new Map();
const operatorEscRecoveryTracker = createTapBurstTrigger({
  requiredCount: OPERATOR_ESC_RECOVERY_REQUIRED_TAPS,
  windowMs: OPERATOR_ESC_RECOVERY_WINDOW_MS
});

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

function resolveOperatorSessionId() {
  if (typeof faceState.session_id === 'string' && faceState.session_id.trim() !== '' && faceState.session_id !== '-') {
    return faceState.session_id;
  }
  return 'default';
}

function normalizeOperatorUiMode(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!OPERATOR_UI_MODES.has(normalized)) {
    return null;
  }
  return normalized;
}

function detectDefaultOperatorUiMode() {
  const narrowViewport = window.matchMedia?.('(max-width: 960px)')?.matches === true;
  const touchPrimary = Number.isFinite(navigator.maxTouchPoints) && navigator.maxTouchPoints > 0;
  return narrowViewport || touchPrimary ? OPERATOR_UI_MODE_MOBILE : OPERATOR_UI_MODE_PC;
}

function shouldShowOperatorKeyboardHelpToggle() {
  const finePointer = window.matchMedia?.('(pointer:fine)')?.matches === true;
  const touchPrimary = Number.isFinite(navigator.maxTouchPoints) && navigator.maxTouchPoints > 0;
  return finePointer || !touchPrimary;
}

function truncateAgentText(value, maxLength = 84) {
  if (typeof value !== 'string') {
    return '';
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function setAgentDashboardStatus(text, tone = 'default') {
  if (!agentDashboardStatusEl) {
    return;
  }
  agentDashboardStatusEl.textContent = text;
  agentDashboardStatusEl.style.color = toneColor(tone);
}

function normalizeDashboardAgentList(rawAgents) {
  if (!Array.isArray(rawAgents)) {
    return [];
  }
  const mapped = rawAgents.map((agent, index) => normalizeDashboardAgent(agent, index));
  return sortDashboardAgents(mapped);
}

function getNonRemovedDashboardAgents() {
  return agentDashboardState.agents.filter((agent) => agent.status !== 'removed');
}

function ensureSelectedDashboardAgent() {
  if (agentDashboardState.selectedAgentId) {
    const existing = agentDashboardState.agents.find((agent) => agent.id === agentDashboardState.selectedAgentId);
    if (existing) {
      return;
    }
  }
  const fallback = getNonRemovedDashboardAgents()[0] ?? agentDashboardState.agents[0] ?? null;
  agentDashboardState.selectedAgentId = fallback?.id ?? null;
}

function getAgentTransientState(agentId) {
  const existing = agentTransientStateById.get(agentId);
  if (existing) {
    return existing;
  }
  const next = {
    message: null,
    messageExpiresAt: 0,
    speakingUntil: 0
  };
  agentTransientStateById.set(agentId, next);
  return next;
}

function pruneAgentTransientState(nowMs = Date.now()) {
  for (const [agentId, state] of agentTransientStateById.entries()) {
    const messageExpired = !state.message || state.messageExpiresAt <= nowMs;
    const speakingExpired = state.speakingUntil <= nowMs;
    if (messageExpired && speakingExpired) {
      agentTransientStateById.delete(agentId);
    }
  }
}

function setAgentTransientMessage(agentId, message, ttlMs = AGENT_TILE_MESSAGE_TTL_MS) {
  const text = truncateAgentText(message);
  if (text === '') {
    return;
  }
  const transient = getAgentTransientState(agentId);
  transient.message = text;
  transient.messageExpiresAt = Date.now() + Math.max(600, ttlMs);
}

function markAgentSpeaking(agentId, active) {
  const transient = getAgentTransientState(agentId);
  transient.speakingUntil = active ? Date.now() + AGENT_TILE_SPEAKING_TTL_MS : 0;
}

function trackAgentTileFromPayload(payload) {
  const agentId = resolveFeedAgentIdForPayload(payload, agentDashboardState.agents);
  if (!agentId) {
    return;
  }
  const update = deriveAgentTransientUpdate(payload);
  if (!update) {
    return;
  }
  if (typeof update.message === 'string' && update.message.trim() !== '') {
    setAgentTransientMessage(agentId, update.message);
  }
  if (typeof update.speaking === 'boolean') {
    markAgentSpeaking(agentId, update.speaking);
  }
}

async function readAgentDashboardState() {
  const response = await fetch('/api/agents/state', {
    method: 'GET',
    cache: 'no-store'
  });
  if (!response.ok) {
    throw new Error(`agent state request failed (${response.status})`);
  }
  const payload = await response.json();
  if (!payload || payload.ok !== true || !Array.isArray(payload?.state?.agents)) {
    throw new Error('agent state response is invalid');
  }
  return normalizeDashboardAgentList(payload.state.agents);
}

function updateAgentDashboardMode() {
  agentDashboardState.mode = deriveDashboardMode(agentDashboardState.agents, {
    isMobileUi: operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE
  });
  document.body.classList.toggle('agent-mode-multi', agentDashboardState.mode === 'multi');
}

function createDashboardActionButton(agent, label, action, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'operator-btn';
  button.textContent = label;
  button.dataset.agentId = agent.id;
  button.dataset.agentAction = action;
  button.addEventListener('click', onClick);
  return button;
}

async function runAgentDashboardAction(agent, action) {
  const path = action === 'add' ? '/api/agents/add' : `/api/agents/${encodeURIComponent(agent.id)}/${action}`;
  const body = action === 'focus' ? { session_id: resolveOperatorSessionId() } : {};
  const response = await fetch(path, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    const detail =
      typeof payload?.detail === 'string' && payload.detail.trim() !== '' ? payload.detail.trim() : null;
    const error = new Error(`${action} failed (${response.status})${detail ? `: ${detail}` : ''}`);
    error.code = typeof payload?.error === 'string' ? payload.error : 'agent_action_failed';
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  return payload;
}

function bindAgentActionButton(button, agent, action, options = {}) {
  if (!button) {
    return;
  }
  button.addEventListener('click', async (event) => {
    if (options.stopPropagation === true) {
      event.stopPropagation();
    }
    button.disabled = true;
    try {
      const payload = await runAgentDashboardAction(agent, action);
      const feedback = summarizeAgentActionSuccess(agent.id, action, payload);
      setAgentDashboardStatus(feedback.statusText, feedback.statusTone);
      if (typeof feedback.tileMessage === 'string' && feedback.tileMessage.trim() !== '') {
        setAgentTransientMessage(agent.id, feedback.tileMessage);
      }
      if (payload?.result?.agent && typeof payload.result.agent === 'object') {
        agentDashboardState.agents = applyAgentResultToAgents(agentDashboardState.agents, payload.result.agent);
        renderAgentDashboard();
      }
      await refreshAgentDashboardState({ silentStatus: true });
    } catch (error) {
      const feedback = summarizeAgentActionFailure(agent.id, action, error);
      setAgentDashboardStatus(feedback.statusText, feedback.statusTone);
      if (typeof feedback.tileMessage === 'string' && feedback.tileMessage.trim() !== '') {
        setAgentTransientMessage(agent.id, feedback.tileMessage);
      }
      renderAgentDashboard();
    } finally {
      button.disabled = false;
    }
  });
}

function renderAgentDashboard() {
  if (!agentDashboardEl || !agentDashboardGridEl || !agentDashboardAddFormEl) {
    return;
  }

  updateAgentDashboardMode();
  const showDashboard = agentDashboardState.mode === 'multi' && operatorPanelEnabled;
  agentDashboardEl.classList.toggle('hidden', !showDashboard);
  if (!showDashboard) {
    renderOperatorMobileAgentList();
    return;
  }

  pruneAgentTransientState(Date.now());
  ensureSelectedDashboardAgent();
  agentDashboardAddFormEl.classList.toggle('hidden', !agentDashboardAddFormOpen);
  if (agentDashboardAddSubmitEl) {
    agentDashboardAddSubmitEl.disabled = agentDashboardAddPending;
  }
  if (agentDashboardAddToggleButtonEl) {
    agentDashboardAddToggleButtonEl.textContent = agentDashboardAddFormOpen ? 'Hide Add' : '+Agent';
  }

  agentDashboardGridEl.innerHTML = '';
  for (const agent of agentDashboardState.agents) {
    const transient = agentTransientStateById.get(agent.id) ?? null;
    const nowMs = Date.now();
    const speaking = Boolean(transient && transient.speakingUntil > nowMs);
    const transientMessage = transient && transient.messageExpiresAt > nowMs ? transient.message : null;
    const tile = document.createElement('article');
    tile.className = 'agent-tile';
    if (agent.id === agentDashboardState.selectedAgentId) {
      tile.classList.add('is-selected');
    }
    tile.dataset.tone = deriveAgentTileTone(agent, { speaking });
    tile.addEventListener('click', () => {
      if (agentDashboardState.selectedAgentId !== agent.id) {
        agentDashboardState.selectedAgentId = agent.id;
        renderAgentDashboard();
      }
    });

    const header = document.createElement('header');
    header.className = 'agent-tile-header';
    const idEl = document.createElement('span');
    idEl.className = 'agent-tile-id';
    idEl.textContent = agent.id;
    const statusEl = document.createElement('span');
    statusEl.className = 'agent-tile-status';
    statusEl.textContent = agent.status;
    header.append(idEl, statusEl);

    const sessionEl = document.createElement('div');
    sessionEl.className = 'agent-tile-session';
    sessionEl.textContent = `session: ${agent.session_id ?? '-'}`;

    const messageEl = document.createElement('p');
    messageEl.className = 'agent-tile-message';
    messageEl.textContent = summarizeAgentTileMessage(agent, transientMessage);

    const actions = document.createElement('div');
    actions.className = 'agent-tile-actions';
    for (const item of listAgentLifecycleActions(agent)) {
      const button = createDashboardActionButton(agent, item.label, item.action, () => {});
      bindAgentActionButton(button, agent, item.action, { stopPropagation: true });
      actions.appendChild(button);
    }

    tile.append(header, sessionEl, messageEl, actions);
    agentDashboardGridEl.appendChild(tile);
  }
  renderOperatorMobileAgentList();
}

function renderOperatorMobileAgentList() {
  if (!operatorAgentListEl || !operatorAgentListItemsEl) {
    return;
  }
  const shouldShow = shouldShowMobileAgentList(agentDashboardState.agents, {
    isMobileUi: operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE,
    operatorPanelEnabled
  });
  operatorAgentListEl.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) {
    return;
  }

  pruneAgentTransientState(Date.now());
  operatorAgentListItemsEl.innerHTML = '';
  for (const agent of agentDashboardState.agents) {
    const transient = agentTransientStateById.get(agent.id) ?? null;
    const nowMs = Date.now();
    const message = summarizeAgentTileMessage(
      agent,
      transient && transient.messageExpiresAt > nowMs ? transient.message : null
    );
    const item = document.createElement('article');
    item.className = 'operator-agent-item';
    if (agent.id === agentDashboardState.selectedAgentId) {
      item.style.borderColor = 'rgba(111, 243, 184, 0.65)';
    }

    const header = document.createElement('header');
    header.className = 'operator-agent-item-header';
    const idEl = document.createElement('span');
    idEl.className = 'operator-agent-item-id';
    idEl.textContent = agent.id;
    const statusEl = document.createElement('span');
    statusEl.className = 'operator-agent-item-status';
    statusEl.textContent = agent.status;
    header.append(idEl, statusEl);

    const messageEl = document.createElement('p');
    messageEl.className = 'operator-agent-item-message';
    messageEl.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'operator-agent-item-actions';
    for (const actionItem of listAgentLifecycleActions(agent)) {
      const button = createDashboardActionButton(agent, actionItem.label, actionItem.action, () => {});
      bindAgentActionButton(button, agent, actionItem.action, { stopPropagation: false });
      actions.appendChild(button);
    }
    item.append(header, messageEl, actions);
    operatorAgentListItemsEl.appendChild(item);
  }
}

async function refreshAgentDashboardState(options = {}) {
  if (agentDashboardLoadInFlight) {
    return agentDashboardLoadInFlight;
  }
  const silentStatus = options.silentStatus === true;
  agentDashboardLoadInFlight = (async () => {
    const agents = await readAgentDashboardState();
    agentDashboardState.agents = agents;
    agentDashboardState.loaded = true;
    ensureSelectedDashboardAgent();
    renderAgentDashboard();
    if (!silentStatus) {
      setAgentDashboardStatus(`${getNonRemovedDashboardAgents().length} agents`, 'ok');
    }
  })()
    .catch((error) => {
      if (!silentStatus) {
        setAgentDashboardStatus(`agent state error: ${error.message}`, 'warn');
      }
    })
    .finally(() => {
      agentDashboardLoadInFlight = null;
    });
  return agentDashboardLoadInFlight;
}

function scheduleAgentDashboardPoll(delayMs = AGENT_DASHBOARD_POLL_INTERVAL_MS) {
  if (agentDashboardPollTimer !== null) {
    clearTimeout(agentDashboardPollTimer);
  }
  agentDashboardPollTimer = window.setTimeout(() => {
    agentDashboardPollTimer = null;
    void refreshAgentDashboardState({ silentStatus: true }).finally(() => {
      scheduleAgentDashboardPoll(AGENT_DASHBOARD_POLL_INTERVAL_MS);
    });
  }, Math.max(600, delayMs));
}

function installAgentDashboardControls() {
  if (!agentDashboardEl || !agentDashboardAddFormEl) {
    return;
  }

  if (agentDashboardRefreshButtonEl) {
    agentDashboardRefreshButtonEl.addEventListener('click', () => {
      void refreshAgentDashboardState({ silentStatus: false });
    });
  }
  if (agentDashboardAddToggleButtonEl) {
    agentDashboardAddToggleButtonEl.addEventListener('click', () => {
      agentDashboardAddFormOpen = !agentDashboardAddFormOpen;
      renderAgentDashboard();
    });
  }
  agentDashboardAddFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (agentDashboardAddPending) {
      return;
    }
    agentDashboardAddPending = true;
    renderAgentDashboard();
    try {
      const payload = {
        create_worktree: true,
        create_tmux: true
      };
      const id = typeof agentDashboardAddIdEl?.value === 'string' ? agentDashboardAddIdEl.value.trim() : '';
      const sessionId =
        typeof agentDashboardAddSessionIdEl?.value === 'string' ? agentDashboardAddSessionIdEl.value.trim() : '';
      const sourceRepoPath =
        typeof agentDashboardAddRepoPathEl?.value === 'string' ? agentDashboardAddRepoPathEl.value.trim() : '';
      const branch = typeof agentDashboardAddBranchEl?.value === 'string' ? agentDashboardAddBranchEl.value.trim() : '';
      if (id) {
        payload.id = id;
      }
      if (sessionId) {
        payload.session_id = sessionId;
      } else if (id) {
        payload.session_id = id;
      }
      if (sourceRepoPath) {
        payload.source_repo_path = sourceRepoPath;
      }
      if (branch) {
        payload.branch = branch;
      }

      const response = await fetch('/api/agents/add', {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(payload)
      });
      const json = await response.json().catch(() => null);
      if (!response.ok || json?.ok !== true) {
        const detail = json?.detail ? `: ${json.detail}` : '';
        throw new Error(`add failed (${response.status})${detail}`);
      }
      if (json?.result?.agent && typeof json.result.agent === 'object') {
        agentDashboardState.agents = applyAgentResultToAgents(agentDashboardState.agents, json.result.agent);
      }
      if (agentDashboardAddIdEl) {
        agentDashboardAddIdEl.value = '';
      }
      if (agentDashboardAddSessionIdEl) {
        agentDashboardAddSessionIdEl.value = '';
      }
      if (agentDashboardAddRepoPathEl) {
        agentDashboardAddRepoPathEl.value = '';
      }
      if (agentDashboardAddBranchEl) {
        agentDashboardAddBranchEl.value = '';
      }
      agentDashboardAddFormOpen = false;
      setAgentDashboardStatus('agent created', 'ok');
      renderAgentDashboard();
      await refreshAgentDashboardState({ silentStatus: true });
    } catch (error) {
      setAgentDashboardStatus(error.message, 'warn');
    } finally {
      agentDashboardAddPending = false;
      renderAgentDashboard();
    }
  });
}

function applyOperatorUiMode(mode) {
  const configured = normalizeOperatorUiMode(mode) ?? OPERATOR_UI_MODE_AUTO;
  operatorConfiguredUiMode = configured;
  operatorEffectiveUiMode = configured === OPERATOR_UI_MODE_AUTO ? detectDefaultOperatorUiMode() : configured;

  document.body.classList.remove('ui-mode-mobile', 'ui-mode-pc');
  document.body.classList.add(operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE ? 'ui-mode-mobile' : 'ui-mode-pc');

  if (operatorTitleEl) {
    operatorTitleEl.textContent = operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE ? 'MINIMUM HEADROOM OPERATOR' : 'Operator';
  }
  renderAgentDashboard();
}

async function loadOperatorUiConfig() {
  const queryMode = normalizeOperatorUiMode(new URL(window.location.href).searchParams.get('ui'));
  let configMode = null;
  try {
    const response = await fetch('/api/operator/ui-config', {
      method: 'GET',
      cache: 'no-store'
    });
    if (response.ok) {
      const payload = await response.json();
      configMode = normalizeOperatorUiMode(payload?.uiMode);
      operatorPanelEnabled = payload?.operatorPanelEnabled !== false;
      operatorBatchAsrConfig.enabled = payload?.batchAsr?.enabled === true;
      operatorRealtimeAsrConfig.enabled = payload?.realtimeAsr?.enabled === true;
      operatorRealtimeAsrConfig.sampleRateHz = Number.isFinite(payload?.realtimeAsr?.sampleRateHz)
        ? Math.max(8_000, Math.floor(payload.realtimeAsr.sampleRateHz))
        : OPERATOR_REALTIME_ASR_DEFAULT_SAMPLE_RATE;
      browserAudioMaxChannels = Number.isFinite(payload?.browserAudio?.maxChannels)
        ? clampBrowserAudioMaxChannels(payload.browserAudio.maxChannels)
        : BROWSER_AUDIO_MAX_CHANNELS_DEFAULT;
    }
  } catch {
    // Keep defaults on fetch failures.
  }
  applyOperatorUiMode(queryMode ?? configMode ?? OPERATOR_UI_MODE_AUTO);
}

async function requestOperatorRecoverDefault() {
  if (operatorRecoverPending) {
    return false;
  }

  operatorRecoverPending = true;
  if (operatorRecoverPendingTimer !== null) {
    window.clearTimeout(operatorRecoverPendingTimer);
    operatorRecoverPendingTimer = null;
  }
  const query = new URLSearchParams({
    session_id: resolveOperatorSessionId()
  });

  try {
    const response = await fetch(`/api/operator/recover-default?${query.toString()}`, {
      method: 'POST',
      cache: 'no-store'
    });
    if (!response.ok) {
      throw new Error(`recover failed (${response.status})`);
    }
    operatorRecoverPendingTimer = window.setTimeout(() => {
      operatorRecoverPending = false;
      operatorRecoverPendingTimer = null;
      setOperatorStatusLine('recover timeout', 'warn');
    }, OPERATOR_RECOVER_PENDING_TIMEOUT_MS);
    setOperatorAckLine('ack: recovery requested', 'default');
    setOperatorStatusLine('recovering agent...', 'warn');
    return true;
  } catch {
    operatorRecoverPending = false;
    if (operatorRecoverPendingTimer !== null) {
      window.clearTimeout(operatorRecoverPendingTimer);
      operatorRecoverPendingTimer = null;
    }
    setOperatorStatusLine('recover request failed', 'warn');
    return false;
  }
}

function sendSocketPayload(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function setOperatorStatusLine(text, tone = 'default') {
  if (!operatorStatusEl) {
    return;
  }
  operatorStatusEl.textContent = text;
  operatorStatusEl.style.color = toneColor(tone);
}

function setOperatorAckLine(text, tone = 'default') {
  if (!operatorAckEl) {
    return;
  }
  operatorAckEl.textContent = text;
  operatorAckEl.style.color = toneColor(tone);
}

function dispatchOperatorUiAction(action) {
  operatorUiState = reduceOperatorUiState(operatorUiState, action);
  updateOperatorUi();
}

function formatOperatorApprovalMeta(payload) {
  const lines = [];
  if (typeof payload.purpose === 'string' && payload.purpose.trim() !== '') {
    lines.push(`purpose: ${payload.purpose.trim()}`);
  }
  if (typeof payload.action === 'string' && payload.action.trim() !== '') {
    lines.push(`action: ${payload.action.trim()}`);
  }
  if (typeof payload.effect === 'string' && payload.effect.trim() !== '') {
    lines.push(`effect: ${payload.effect.trim()}`);
  }
  if (typeof payload.risk === 'string' && payload.risk.trim() !== '') {
    lines.push(`risk: ${payload.risk.trim()}`);
  }
  return lines.join('\n');
}

function normalizeOperatorPromptChoices(payload) {
  if (Array.isArray(payload?.choices) && payload.choices.length > 0) {
    return payload.choices.map((item) => String(item));
  }
  if (payload?.state === 'awaiting_approval') {
    return ['approve', 'deny'];
  }
  return [];
}

function sendOperatorResponse(responseKind, value, extra = {}) {
  const requestId = Object.prototype.hasOwnProperty.call(extra, 'requestId')
    ? extra.requestId ?? null
    : operatorActivePrompt?.request_id ?? null;
  const payload = {
    v: 1,
    type: 'operator_response',
    session_id: resolveOperatorSessionId(),
    request_id: requestId,
    response_kind: responseKind,
    value,
    source: 'ui',
    ts: Date.now()
  };
  if (extra.submit === false) {
    payload.submit = false;
  }

  const sent = sendSocketPayload(payload);
  if (!sent) {
    setOperatorStatusLine('bridge offline', 'warn');
    setOperatorAckLine('ack: not sent (offline)', 'warn');
    dispatchOperatorUiAction({ type: 'socket_close' });
    return false;
  }

  setOperatorAckLine(`ack: queued ${responseKind}`, 'default');
  return true;
}

function renderOperatorChoices(payload) {
  if (!operatorChoiceButtonsEl) {
    return;
  }
  operatorChoiceButtonsEl.innerHTML = '';

  const choices = normalizeOperatorPromptChoices(payload);
  if (choices.length === 0) {
    return;
  }

  for (const rawChoice of choices) {
    const choice = String(rawChoice);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'operator-btn';
    button.textContent = choice;
    button.addEventListener('click', () => {
      sendOperatorResponse('choice_single', choice);
    });
    operatorChoiceButtonsEl.appendChild(button);
  }
}

function appendOperatorTextInput(value, language = 'en') {
  if (!operatorTextInputEl || typeof value !== 'string') {
    return false;
  }
  const text = normalizeOperatorAsrTerms(value.trim(), language);
  if (text === '') {
    return false;
  }
  const next = buildOperatorTextInsertion(
    operatorTextInputEl.value,
    text,
    language,
    operatorTextInputEl.selectionStart,
    operatorTextInputEl.selectionEnd
  );
  operatorTextInputEl.value = next.text;
  try {
    operatorTextInputEl.setSelectionRange(next.caretStart, next.caretEnd);
  } catch {
    // Ignore selection update errors on unsupported input states.
  }
  syncOperatorTextInputHeight();
  setOperatorStatusLine(`asr appended (${language})`, 'ok');
  return true;
}

function shouldUseOperatorRealtimeAsr() {
  const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
  return operatorRealtimeAsrConfig.enabled && typeof AudioContextCtor === 'function' && socket?.readyState === WebSocket.OPEN;
}

function beginOperatorRealtimeDraft(language = 'en') {
  if (!operatorTextInputEl) {
    return;
  }
  const selection = normalizeOperatorTextSelection(
    operatorTextInputEl.value,
    operatorTextInputEl.selectionStart,
    operatorTextInputEl.selectionEnd
  );
  operatorMicState.realtimeDraftActive = true;
  operatorMicState.realtimeBaseText = operatorTextInputEl.value;
  operatorMicState.realtimeSelectionStart = selection.start;
  operatorMicState.realtimeSelectionEnd = selection.end;
  operatorMicState.realtimeText = '';
}

function renderOperatorRealtimeDraft() {
  if (!operatorTextInputEl || !operatorMicState.realtimeDraftActive) {
    return;
  }
  const next = buildOperatorTextInsertion(
    operatorMicState.realtimeBaseText,
    operatorMicState.realtimeText,
    operatorMicState.language,
    operatorMicState.realtimeSelectionStart,
    operatorMicState.realtimeSelectionEnd
  );
  operatorTextInputEl.value = next.text;
  try {
    operatorTextInputEl.setSelectionRange(next.caretStart, next.caretEnd);
  } catch {
    // Ignore selection update errors on unsupported input states.
  }
  syncOperatorTextInputHeight();
}

function clearOperatorRealtimeDraft(keepRenderedText = true) {
  if (!keepRenderedText && operatorTextInputEl) {
    operatorTextInputEl.value = operatorMicState.realtimeBaseText;
    try {
      operatorTextInputEl.setSelectionRange(operatorMicState.realtimeSelectionStart, operatorMicState.realtimeSelectionEnd);
    } catch {
      // Ignore selection update errors on unsupported input states.
    }
    syncOperatorTextInputHeight();
  }
  operatorMicState.realtimeDraftActive = false;
  operatorMicState.realtimeBaseText = '';
  operatorMicState.realtimeSelectionStart = 0;
  operatorMicState.realtimeSelectionEnd = 0;
  operatorMicState.realtimeText = '';
}

function normalizeOperatorRealtimeGeneration(value, fallback = null) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function isCurrentOperatorRealtimeGeneration(value) {
  const normalized = normalizeOperatorRealtimeGeneration(value, null);
  if (normalized === null) {
    return true;
  }
  return normalized === operatorMicState.realtimeGeneration;
}

function cancelPendingOperatorRealtimeAsr(keepRenderedText = true) {
  if (!operatorMicState.realtimeDraftActive) {
    return false;
  }
  sendOperatorRealtimeAsrPayload('operator_realtime_asr_cancel', {
    language: operatorMicState.language
  });
  clearOperatorRealtimeDraft(keepRenderedText);
  return true;
}

function syncOperatorTextInputHeight() {
  if (!operatorTextInputEl) {
    return;
  }

  operatorTextInputEl.style.height = 'auto';

  const computed = window.getComputedStyle(operatorTextInputEl);
  const lineHeight = Number.parseFloat(computed.lineHeight) || 0;
  const paddingHeight =
    (Number.parseFloat(computed.paddingTop) || 0) +
    (Number.parseFloat(computed.paddingBottom) || 0);
  const borderHeight =
    (Number.parseFloat(computed.borderTopWidth) || 0) +
    (Number.parseFloat(computed.borderBottomWidth) || 0);
  const minHeight = Math.max(34, lineHeight > 0 ? lineHeight + paddingHeight + borderHeight : 34);
  const maxHeight =
    lineHeight > 0
      ? lineHeight * 3 + paddingHeight + borderHeight
      : Math.max(minHeight, operatorTextInputEl.scrollHeight);
  const nextHeight = Math.max(minHeight, Math.min(operatorTextInputEl.scrollHeight, maxHeight));

  operatorTextInputEl.style.height = `${Math.ceil(nextHeight)}px`;
  operatorTextInputEl.style.overflowY = operatorTextInputEl.scrollHeight > maxHeight + 1 ? 'auto' : 'hidden';
}

function clearOperatorRealtimeAudioBuffer() {
  operatorMicState.realtimePcmChunks = [];
  operatorMicState.realtimePcmBytes = 0;
}

function applyOperatorRealtimeDelta(value) {
  if (!operatorMicState.realtimeDraftActive || typeof value !== 'string' || value === '') {
    return;
  }
  operatorMicState.realtimeText += value;
  renderOperatorRealtimeDraft();
}

function finalizeOperatorRealtimeDraft(value) {
  if (!operatorMicState.realtimeDraftActive) {
    return;
  }
  if (typeof value === 'string' && value !== '') {
    operatorMicState.realtimeText = normalizeOperatorAsrTerms(value, operatorMicState.language);
    renderOperatorRealtimeDraft();
  }
  clearOperatorRealtimeDraft(true);
}

function encodeBytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function resampleMonoAudio(input, sourceRate, targetRate) {
  if (sourceRate === targetRate) {
    return input;
  }
  const sampleRateRatio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.round(input.length / sampleRateRatio));
  const output = new Float32Array(outputLength);
  let sourceIndex = 0;
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const nextSourceIndex = Math.min(input.length, Math.round((outputIndex + 1) * sampleRateRatio));
    let sum = 0;
    let count = 0;
    for (let index = sourceIndex; index < nextSourceIndex; index += 1) {
      sum += input[index];
      count += 1;
    }
    output[outputIndex] = count > 0 ? sum / count : input[Math.min(sourceIndex, input.length - 1)];
    sourceIndex = nextSourceIndex;
  }
  return output;
}

function encodeMonoPcm16Bytes(channelData, sourceRate, targetRate) {
  const resampled = resampleMonoAudio(channelData, sourceRate, targetRate);
  if (resampled.length < 1) {
    return null;
  }
  const pcmBytes = new Uint8Array(resampled.length * 2);
  const view = new DataView(pcmBytes.buffer);
  for (let index = 0; index < resampled.length; index += 1) {
    const sample = clamp(resampled[index], -1, 1);
    const scaled = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(index * 2, Math.round(scaled), true);
  }
  return pcmBytes;
}

function encodeRealtimeAudioChunk(channelData, sourceRate, targetRate) {
  const pcmBytes = encodeMonoPcm16Bytes(channelData, sourceRate, targetRate);
  if (!pcmBytes) {
    return null;
  }
  return {
    audio: encodeBytesToBase64(pcmBytes),
    pcmBytes
  };
}

function buildWaveBlobFromPcmChunks(chunks, sampleRateHz) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return null;
  }
  const dataLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (dataLength < 1) {
    return null;
  }

  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 44;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  const byteRate = sampleRateHz * 2;
  view.setUint32(0, 0x52494646, false);
  view.setUint32(4, 36 + dataLength, true);
  view.setUint32(8, 0x57415645, false);
  view.setUint32(12, 0x666d7420, false);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(36, 0x64617461, false);
  view.setUint32(40, dataLength, true);

  return new Blob([buffer], { type: 'audio/wav' });
}

function estimateOperatorRealtimeAudioSeconds(byteLength, sampleRateHz) {
  if (!Number.isFinite(byteLength) || byteLength <= 0 || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    return 0;
  }
  return byteLength / (sampleRateHz * 2);
}

function formatOperatorAsrErrorDetail(detail) {
  if (typeof detail === 'string' && detail.trim() !== '') {
    return detail.trim();
  }
  if (detail && typeof detail === 'object') {
    if (typeof detail.detail === 'string' && detail.detail.trim() !== '') {
      return detail.detail.trim();
    }
    try {
      return JSON.stringify(detail);
    } catch {
      return String(detail);
    }
  }
  return '';
}

async function attemptOperatorRealtimeBatchFallback(language = 'en', reason = 'empty') {
  const isSuspicious = reason === 'suspicious';
  const isError = reason === 'error';
  const audioSeconds = estimateOperatorRealtimeAudioSeconds(
    operatorMicState.realtimePcmBytes,
    operatorRealtimeAsrConfig.sampleRateHz
  );
  if (audioSeconds > 0 && audioSeconds < OPERATOR_REALTIME_BATCH_FALLBACK_MIN_SECONDS) {
    clearOperatorRealtimeAudioBuffer();
    setOperatorStatusLine(`speech too short to transcribe (${language})`, 'warn');
    return false;
  }

  const wavBlob = buildWaveBlobFromPcmChunks(operatorMicState.realtimePcmChunks, operatorRealtimeAsrConfig.sampleRateHz);
  clearOperatorRealtimeAudioBuffer();

  if (!wavBlob) {
    setOperatorStatusLine(
      isSuspicious
        ? `realtime ASR rejected suspicious text (${language})`
        : isError
          ? `realtime ASR failed (${language})`
          : `realtime ASR returned empty text (${language})`,
      'warn'
    );
    return false;
  }

  if (!operatorBatchAsrConfig.enabled) {
    setOperatorStatusLine(
      isSuspicious
        ? `realtime ASR rejected suspicious text (${language}); batch fallback unavailable`
        : isError
          ? `realtime ASR failed (${language}); batch fallback unavailable`
          : `realtime ASR returned empty text (${language}); batch fallback unavailable`,
      'warn'
    );
    return false;
  }

  setOperatorStatusLine(
    isSuspicious
      ? `realtime ASR looked off; retrying batch (${language})...`
      : isError
        ? `realtime ASR failed; retrying batch (${language})...`
        : `realtime ASR empty; retrying batch (${language})...`,
    'default'
  );
  try {
    const transcript = await requestOperatorAsrTranscript(wavBlob, 'audio/wav', language);
    if (!shouldAcceptOperatorBatchFallbackResult(transcript, language)) {
      const reason = getOperatorRealtimeAsrSuspicion(transcript.text, language) ?? 'off-target text';
      setOperatorStatusLine(`batch fallback rejected (${language}): ${reason}`, 'warn');
      return false;
    }
    appendOperatorTextInput(transcript.text, transcript.language);
    setOperatorStatusLine(`batch fallback ready (${transcript.language})`, 'ok');
    return true;
  } catch (error) {
    setOperatorStatusLine(
      isSuspicious
        ? `realtime ASR suspicious; batch fallback failed: ${error.message}`
        : isError
          ? `realtime ASR failed; batch fallback failed: ${error.message}`
          : `realtime ASR empty; batch fallback failed: ${error.message}`,
      'warn'
    );
    return false;
  }
}

function sendOperatorRealtimeAsrPayload(type, extra = {}) {
  const { generation: rawGeneration, ...restExtra } = extra;
  const generation = normalizeOperatorRealtimeGeneration(
    rawGeneration ?? operatorMicState.realtimeGeneration,
    null
  );
  return sendSocketPayload({
    v: 1,
    type,
    session_id: resolveOperatorSessionId(),
    ts: Date.now(),
    ...(generation === null ? {} : { generation }),
    ...restExtra
  });
}

function submitOperatorTextInput() {
  if (!operatorTextInputEl) {
    return;
  }
  const text = operatorTextInputEl.value.trim();
  if (text === '') {
    setOperatorStatusLine('text is empty', 'warn');
    return;
  }
  const sent = sendOperatorResponse('text', text, { submit: true });
  if (sent) {
    cancelPendingOperatorRealtimeAsr(true);
    clearOperatorRealtimeAudioBuffer();
    operatorTextInputEl.value = '';
    syncOperatorTextInputHeight();
    setOperatorStatusLine('text sent', 'ok');
  }
}

function clearOperatorTextInput({ focusTextInput = false } = {}) {
  if (!operatorTextInputEl) {
    return false;
  }
  cancelPendingOperatorRealtimeAsr(true);
  clearOperatorRealtimeAudioBuffer();
  operatorTextInputEl.value = '';
  syncOperatorTextInputHeight();
  setOperatorStatusLine('text cleared', 'default');
  if (focusTextInput) {
    operatorTextInputEl.focus({ preventScroll: true });
  }
  return true;
}

function focusOperatorTextInput() {
  if (!operatorTextInputEl) {
    return false;
  }
  cancelPendingOperatorRealtimeAsr(true);
  clearOperatorRealtimeAudioBuffer();
  operatorTextInputEl.focus({ preventScroll: true });
  syncOperatorTextInputHeight();
  setOperatorStatusLine('text input focused', 'default');
  return true;
}

function cancelPendingOperatorKeyboardPttStart() {
  if (operatorMicState.keyboardPendingTimer) {
    clearTimeout(operatorMicState.keyboardPendingTimer);
    operatorMicState.keyboardPendingTimer = null;
  }
  operatorMicState.keyboardPendingKey = null;
}

function shouldDelayOperatorKeyboardPttStart(key) {
  return key === 'Control' || key === 'Alt';
}

function hideOperatorKeyboard(updateStatus = true) {
  if (!operatorTextInputEl) {
    return;
  }
  operatorTextInputEl.blur();
  window.setTimeout(() => {
    operatorTextInputEl.blur();
  }, 50);
  if (updateStatus) {
    setOperatorStatusLine('keyboard hidden', 'default');
  }
}

function applyAnsiRunStyle(element, run) {
  let color = run.fg;
  let backgroundColor = run.bg;

  if (run.inverse) {
    color = run.bg ?? OPERATOR_MIRROR_DEFAULT_BG_CSS_VAR;
    backgroundColor = run.fg ?? OPERATOR_MIRROR_DEFAULT_FG_CSS_VAR;
  }

  if (color) {
    element.style.color = color;
  }
  if (backgroundColor) {
    element.style.backgroundColor = backgroundColor;
  }
  if (run.bold) {
    element.style.fontWeight = '700';
  }
  if (run.faint) {
    element.style.opacity = '0.78';
  }
  if (run.italic) {
    element.style.fontStyle = 'italic';
  }
  if (run.underline) {
    element.style.textDecoration = 'underline';
  }
}

function renderAnsiTextToMirror(text) {
  if (!operatorMirrorEl) {
    return;
  }

  const runs = parseAnsiRuns(text);
  if (runs.length === 0) {
    operatorMirrorEl.textContent = '';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const run of runs) {
    if (run.text === '') {
      continue;
    }
    if (isDefaultAnsiStyle(run)) {
      fragment.appendChild(document.createTextNode(run.text));
      continue;
    }
    const span = document.createElement('span');
    span.textContent = run.text;
    applyAnsiRunStyle(span, run);
    fragment.appendChild(span);
  }

  operatorMirrorEl.replaceChildren(fragment);
}

function isOperatorMirrorNearBottom() {
  if (!operatorMirrorEl) {
    return true;
  }
  const distance = operatorMirrorEl.scrollHeight - operatorMirrorEl.scrollTop - operatorMirrorEl.clientHeight;
  return distance <= OPERATOR_MIRROR_FOLLOW_THRESHOLD_PX;
}

function scrollOperatorMirrorToBottom() {
  if (!operatorMirrorEl) {
    return;
  }
  operatorMirrorEl.scrollTop = operatorMirrorEl.scrollHeight;
}

function scrollOperatorMirrorByPage(direction) {
  if (!operatorMirrorEl || !Number.isFinite(direction) || direction === 0) {
    return false;
  }
  const pageSize = Math.max(80, Math.floor(operatorMirrorEl.clientHeight * 0.9));
  operatorMirrorEl.scrollTop += pageSize * direction;
  handleOperatorMirrorScroll();
  return true;
}

function handleOperatorMirrorScroll() {
  operatorMirrorAutoFollow = isOperatorMirrorNearBottom();
}

function renderOperatorTerminalSnapshot() {
  if (!operatorMirrorEl) {
    return;
  }
  if (!operatorTerminalSnapshotLines || operatorTerminalSnapshotLines.length === 0) {
    operatorMirrorEl.textContent = '(empty)';
    return;
  }

  const shouldStickToBottom = operatorMirrorAutoFollow || isOperatorMirrorNearBottom();
  renderAnsiTextToMirror(operatorTerminalSnapshotLines.join('\n'));

  if (!operatorMirrorInitialScrollDone) {
    scrollOperatorMirrorToBottom();
    operatorMirrorInitialScrollDone = true;
    operatorMirrorAutoFollow = true;
    return;
  }

  if (shouldStickToBottom) {
    scrollOperatorMirrorToBottom();
    operatorMirrorAutoFollow = true;
  }
}

function updateOperatorUi() {
  if (!operatorPanelEnabled) {
    if (operatorPanelEl) {
      operatorPanelEl.classList.add('hidden');
    }
    if (operatorEscButtonEl) {
      operatorEscButtonEl.classList.add('hidden');
    }
    if (operatorEscInlineButtonEl) {
      operatorEscInlineButtonEl.classList.add('hidden');
    }
    if (operatorHandleEl) {
      operatorHandleEl.classList.add('hidden');
    }
    if (operatorCloseButtonEl) {
      operatorCloseButtonEl.classList.add('hidden');
    }
    if (operatorHelpToggleEl) {
      operatorHelpToggleEl.classList.add('hidden');
      operatorHelpToggleEl.setAttribute('aria-expanded', 'false');
    }
    if (operatorKeyboardHelpEl) {
      operatorKeyboardHelpEl.hidden = true;
    }
    if (operatorAgentListEl) {
      operatorAgentListEl.classList.add('hidden');
    }
    return;
  }

  const flags = deriveOperatorUiFlags(operatorUiState);
  const prompt = operatorActivePrompt;
  const awaiting = operatorUiState.awaiting;
  const inputKind = prompt?.input_kind ?? null;
  const isMobileUi = operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE;
  const approvalMeta = prompt ? formatOperatorApprovalMeta(prompt) : '';

  if (operatorPanelEl) {
    operatorPanelEl.classList.toggle('hidden', !flags.showPanel);
  }
  if (operatorEscButtonEl) {
    const showFloatingEsc = flags.showEsc && (!flags.showPanel || !isMobileUi);
    operatorEscButtonEl.classList.toggle('hidden', !showFloatingEsc);
  }
  if (operatorEscInlineButtonEl) {
    const showInlineEsc = flags.showEsc && flags.showPanel && isMobileUi;
    operatorEscInlineButtonEl.classList.toggle('hidden', !showInlineEsc);
  }
  if (operatorHandleEl) {
    operatorHandleEl.classList.add('hidden');
  }
  if (operatorCloseButtonEl) {
    operatorCloseButtonEl.classList.add('hidden');
  }
  if (operatorRestartButtonEl) {
    operatorRestartButtonEl.classList.toggle('hidden', !flags.showRestart);
  }
  if (operatorMirrorEl) {
    const showMirror = isMobileUi || flags.showMirror;
    operatorMirrorEl.classList.toggle('hidden', !showMirror);
  }
  if (operatorMirrorToggleEl) {
    operatorMirrorToggleEl.classList.toggle('hidden', isMobileUi);
    operatorMirrorToggleEl.textContent = flags.showMirror ? 'Hide Terminal' : 'Terminal';
  }
  const showKeyboardHelpToggle = shouldShowOperatorKeyboardHelpToggle();
  if (operatorHelpToggleEl) {
    operatorHelpToggleEl.classList.toggle('hidden', !showKeyboardHelpToggle);
    operatorHelpToggleEl.setAttribute('aria-expanded', showKeyboardHelpToggle && operatorKeyboardHelpOpen ? 'true' : 'false');
  }
  if (operatorKeyboardHelpEl) {
    operatorKeyboardHelpEl.hidden = !showKeyboardHelpToggle || !operatorKeyboardHelpOpen;
  }

  if (operatorPromptEl) {
    let promptText = '';
    if (prompt?.prompt) {
      promptText = prompt.prompt;
    } else if (awaiting) {
      promptText = 'Awaiting input.';
    }
    operatorPromptEl.textContent = promptText;
    operatorPromptEl.classList.toggle('hidden', promptText === '');
  }
  if (operatorApprovalMetaEl) {
    operatorApprovalMetaEl.textContent = approvalMeta;
    operatorApprovalMetaEl.classList.toggle('hidden', approvalMeta === '');
  }

  const showChoices = awaiting && (inputKind === 'choice_single' || prompt?.state === 'awaiting_approval');
  if (operatorChoiceButtonsEl) {
    operatorChoiceButtonsEl.classList.toggle('hidden', !showChoices || operatorChoiceButtonsEl.childElementCount === 0);
  }

  const showPtt = isMobileUi ? !awaiting || inputKind === 'text' || inputKind === null : awaiting && inputKind === 'text';
  if (operatorPttJaButtonEl) {
    operatorPttJaButtonEl.classList.toggle('hidden', !showPtt);
  }
  if (operatorPttEnButtonEl) {
    operatorPttEnButtonEl.classList.toggle('hidden', !showPtt);
  }
  if (operatorTextCardEl) {
    operatorTextCardEl.classList.toggle('hidden', false);
  }
  if (operatorTextInputEl) {
    if (awaiting && inputKind === 'text') {
      operatorTextInputEl.placeholder = 'Type response text';
    } else if (awaiting && inputKind) {
      operatorTextInputEl.placeholder = 'Type manual input (prompt expects choice)';
    } else {
      operatorTextInputEl.placeholder = 'Text fallback input';
    }
  }

  const hasTextDraft = operatorTextInputEl ? operatorTextInputEl.value.trim() !== '' : false;
  if (!awaiting && !hasTextDraft) {
    if (flags.showRestart) {
      setOperatorStatusLine('recovery', 'warn');
    } else {
      setOperatorStatusLine(isMobileUi ? 'manual input ready' : 'idle', 'ok');
    }
  }

  renderOperatorTerminalSnapshot();
}

function handleOperatorPrompt(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  operatorActivePrompt = payload;
  renderOperatorChoices(payload);
  dispatchOperatorUiAction({
    type: 'prompt_received',
    requestId: payload.request_id ?? null,
    prompt: payload
  });
  setOperatorStatusLine(payload.state === 'awaiting_approval' ? 'awaiting approval' : 'awaiting input', 'ok');
}

function handleOperatorAck(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const stage = typeof payload.stage === 'string' ? payload.stage : '-';
  const reason = typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : '';
  const ok = payload.ok === true;

  setOperatorAckLine(`ack: ${stage}${reason ? ` (${reason})` : ''}`, ok ? 'ok' : 'warn');
  if (!ok) {
    setOperatorStatusLine(`ack failed: ${reason || 'unknown'}`, 'warn');
  } else if (stage === 'sent_to_tmux') {
    setOperatorStatusLine('input delivered', 'ok');
  }

  if (operatorEffectiveUiMode !== OPERATOR_UI_MODE_MOBILE) {
    dispatchOperatorUiAction({
      type: 'ack_received',
      ok,
      stage,
      requestId: payload.request_id ?? null
    });
  }

  if (ok && stage === 'sent_to_tmux') {
    operatorActivePrompt = null;
  }
}

function handleOperatorStatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  dispatchOperatorUiAction({
    type: 'operator_state',
    bridgeOnline: payload.bridge_online === true,
    recoveryMode: payload.recovery_mode === true,
    noResponse: payload.no_response === true,
    awaiting: payload.awaiting === true,
    requestId: typeof payload.request_id === 'string' ? payload.request_id : null
  });

  if (payload.awaiting === false && !payload.request_id) {
    operatorActivePrompt = null;
  }

  if (payload.bridge_online === false) {
    setOperatorStatusLine('bridge offline', 'warn');
  } else if (payload.recovery_mode === true) {
    setOperatorStatusLine(`recovery${payload.reason ? `: ${payload.reason}` : ''}`, 'warn');
  }
}

function handleOperatorRecoverResult(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  operatorRecoverPending = false;
  if (operatorRecoverPendingTimer !== null) {
    window.clearTimeout(operatorRecoverPendingTimer);
    operatorRecoverPendingTimer = null;
  }
  if (payload.ok === true) {
    setOperatorAckLine('ack: recovered', 'ok');
    setOperatorStatusLine(`recovered${payload.pane ? `: ${payload.pane}` : ''}`, 'ok');
    return;
  }

  const reason = typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : 'recover_failed';
  setOperatorAckLine(`ack: recover failed (${reason})`, 'warn');
  setOperatorStatusLine(`recover failed: ${reason}`, 'warn');
}

function handleOperatorTerminalSnapshot(payload) {
  if (!payload || !Array.isArray(payload.lines)) {
    return;
  }
  operatorTerminalSnapshotLines = payload.lines.map((line) => String(line));
  renderOperatorTerminalSnapshot();
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

function ensureUnlockAudioElement() {
  if (unlockAudioEl) {
    return unlockAudioEl;
  }

  const player = new Audio();
  player.preload = 'auto';
  player.playsInline = true;
  player.setAttribute('playsinline', 'true');
  player.setAttribute('webkit-playsinline', 'true');
  player.volume = 1;
  unlockAudioEl = player;
  return player;
}

function createBrowserAudioChannel() {
  const player = new Audio();
  player.preload = 'auto';
  player.playsInline = true;
  player.setAttribute('playsinline', 'true');
  player.setAttribute('webkit-playsinline', 'true');
  player.volume = 1;
  return {
    player,
    token: 0,
    active: false,
    sessionId: null,
    generation: null,
    startedAt: 0,
    release: null
  };
}

function ensureBrowserAudioMixer() {
  if (browserAudioMixer) {
    return browserAudioMixer;
  }
  browserAudioMixer = {
    channels: []
  };
  return browserAudioMixer;
}

function releaseBrowserAudioChannelResource(channel) {
  if (typeof channel.release === 'function') {
    channel.release();
  }
  channel.release = null;
}

function clearBrowserAudioChannel(channel) {
  releaseBrowserAudioChannelResource(channel);
  channel.active = false;
  channel.sessionId = null;
  channel.generation = null;
  channel.startedAt = 0;
}

function pauseAndResetBrowserAudioChannel(channel) {
  try {
    channel.player.pause();
  } catch {
    // Ignore pause errors while stopping a browser audio channel.
  }
  try {
    channel.player.currentTime = 0;
  } catch {
    // Ignore seek errors while resetting a browser audio channel.
  }
}

function reserveBrowserAudioChannel(sessionId) {
  const mixer = ensureBrowserAudioMixer();
  const nextIndex = selectBrowserAudioChannelIndex(
    mixer.channels,
    sessionId,
    clampBrowserAudioMaxChannels(browserAudioMaxChannels)
  );
  while (mixer.channels.length <= nextIndex) {
    mixer.channels.push(createBrowserAudioChannel());
  }
  return mixer.channels[nextIndex];
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

  const player = ensureUnlockAudioElement();
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

function stopActiveBrowserAudio(generation = null, sessionId = null) {
  if (!browserAudioMixer) {
    return;
  }
  for (const channel of browserAudioMixer.channels) {
    if (!shouldStopBrowserAudioChannel(channel, { generation, sessionId })) {
      continue;
    }
    pauseAndResetBrowserAudioChannel(channel);
    clearBrowserAudioChannel(channel);
  }
}

function queueReplayPayload(payload) {
  pendingReplayPayload = payload;
  showAudioReplayButton();
}

async function playAudioSource(src, generation = null, release = null, sessionId = '-') {
  const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : '-';
  const channel = reserveBrowserAudioChannel(normalizedSessionId);
  const token = channel.token + 1;
  channel.token = token;
  pauseAndResetBrowserAudioChannel(channel);
  clearBrowserAudioChannel(channel);
  channel.player.src = src;
  channel.player.currentTime = 0;
  channel.release = typeof release === 'function' ? release : null;
  channel.active = true;
  channel.sessionId = normalizedSessionId;
  channel.generation = Number.isInteger(generation) ? generation : null;
  channel.startedAt = Date.now();

  const finalizeIfCurrent = () => {
    if (channel.token !== token) {
      return;
    }
    clearBrowserAudioChannel(channel);
  };
  channel.player.onended = finalizeIfCurrent;
  channel.player.onerror = () => {
    finalizeIfCurrent();
    setTtsPhase('browser_error', 'warn');
  };

  try {
    await channel.player.play();
    if (channel.token !== token) {
      return { superseded: true };
    }
    return { superseded: false };
  } catch (error) {
    if (channel.token === token) {
      clearBrowserAudioChannel(channel);
    }
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
  const sessionId = resolvePayloadSessionId(payload);

  try {
    await unlockPlaybackAudio();
    const played = await playAudioSource(source.src, generation, source.release, sessionId);
    if (played.superseded) {
      return;
    }
    pendingReplayPayload = null;
    hideAudioReplayButton();
  } catch {
    if (typeof source.release === 'function') {
      source.release();
    }
    queueReplayPayload({
      mimeType,
      audioBase64: payload.audio_base64,
      generation,
      sessionId
    });
    setTtsPhase('browser_blocked', 'warn');
  }
}

function releaseOperatorMicCapture() {
  if (operatorMicState.processorNode) {
    operatorMicState.processorNode.onaudioprocess = null;
    try {
      operatorMicState.processorNode.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
  }
  if (operatorMicState.sourceNode) {
    try {
      operatorMicState.sourceNode.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
  }
  if (operatorMicState.processorSinkNode) {
    try {
      operatorMicState.processorSinkNode.disconnect();
    } catch {
      // Ignore disconnect errors.
    }
  }
  if (operatorMicState.audioContext) {
    const audioContext = operatorMicState.audioContext;
    window.setTimeout(() => {
      void audioContext.close().catch(() => {});
    }, 0);
  }
  if (operatorMicState.recorder && operatorMicState.recorder.state !== 'inactive') {
    try {
      operatorMicState.recorder.stop();
    } catch {
      // Ignore cleanup errors while stopping recorder.
    }
  }
  if (operatorMicState.stream) {
    operatorMicState.stream.getTracks().forEach((track) => track.stop());
  }
  if (operatorMicState.stopTimer) {
    clearTimeout(operatorMicState.stopTimer);
    operatorMicState.stopTimer = null;
  }
  operatorMicState.recorder = null;
  operatorMicState.stream = null;
  operatorMicState.chunks = [];
  operatorMicState.mode = 'batch';
  operatorMicState.audioContext = null;
  operatorMicState.sourceNode = null;
  operatorMicState.processorNode = null;
  operatorMicState.processorSinkNode = null;
  operatorMicState.recording = false;
  operatorMicState.pointerArmed = false;
  operatorMicState.keyboardArmedKey = null;
  cancelPendingOperatorKeyboardPttStart();
}

function stopMediaRecorder(recorder, chunks) {
  if (!recorder || recorder.state === 'inactive') {
    return Promise.resolve(new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' }));
  }

  return new Promise((resolve, reject) => {
    const handleStop = () => {
      cleanup();
      resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
    };
    const handleError = () => {
      cleanup();
      reject(new Error('MediaRecorder error'));
    };
    const cleanup = () => {
      recorder.removeEventListener('stop', handleStop);
      recorder.removeEventListener('error', handleError);
    };

    recorder.addEventListener('stop', handleStop, { once: true });
    recorder.addEventListener('error', handleError, { once: true });
    recorder.stop();
  });
}

async function ensureOperatorMediaRecorder() {
  if (operatorMicState.recorder && operatorMicState.stream && operatorMicState.stream.active) {
    return operatorMicState.recorder;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO_CONSTRAINTS });
  const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  const mimeType = preferredTypes.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  });

  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  operatorMicState.stream = stream;
  operatorMicState.recorder = recorder;
  return recorder;
}

async function startOperatorRealtimeRecording(language) {
  const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
  if (typeof AudioContextCtor !== 'function') {
    return false;
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO_CONSTRAINTS });
  let audioContext = null;
  let sourceNode = null;
  let processorNode = null;
  let processorSinkNode = null;

  try {
    audioContext = new AudioContextCtor();
    await audioContext.resume();

    sourceNode = audioContext.createMediaStreamSource(stream);
    processorNode = audioContext.createScriptProcessor(OPERATOR_REALTIME_ASR_PROCESSOR_BUFFER_SIZE, 1, 1);
    processorSinkNode = audioContext.createGain();
    processorSinkNode.gain.value = 0;

    sourceNode.connect(processorNode);
    processorNode.connect(processorSinkNode);
    processorSinkNode.connect(audioContext.destination);

    const nextRealtimeGeneration = (operatorMicState.realtimeGeneration + 1) % Number.MAX_SAFE_INTEGER;
    if (!sendOperatorRealtimeAsrPayload('operator_realtime_asr_start', { language, generation: nextRealtimeGeneration })) {
      throw new Error('realtime ASR socket unavailable');
    }

    operatorMicState.mode = 'realtime';
    operatorMicState.stream = stream;
    operatorMicState.audioContext = audioContext;
    operatorMicState.sourceNode = sourceNode;
    operatorMicState.processorNode = processorNode;
    operatorMicState.processorSinkNode = processorSinkNode;
    operatorMicState.language = language === 'ja' ? 'ja' : 'en';
    operatorMicState.recording = true;
    operatorMicState.startedAtMs = Date.now();
    operatorMicState.realtimeGeneration = nextRealtimeGeneration;
    clearOperatorRealtimeAudioBuffer();
    beginOperatorRealtimeDraft(operatorMicState.language);

    processorNode.onaudioprocess = (event) => {
      if (!operatorMicState.recording || operatorMicState.mode !== 'realtime') {
        return;
      }
      const chunk = encodeRealtimeAudioChunk(
        event.inputBuffer.getChannelData(0),
        event.inputBuffer.sampleRate,
        operatorRealtimeAsrConfig.sampleRateHz
      );
      if (!chunk) {
        return;
      }
      operatorMicState.realtimePcmChunks.push(chunk.pcmBytes);
      operatorMicState.realtimePcmBytes += chunk.pcmBytes.length;
      const sent = sendOperatorRealtimeAsrPayload('operator_realtime_asr_chunk', {
        language: operatorMicState.language,
        audio: chunk.audio,
        sample_rate_hz: operatorRealtimeAsrConfig.sampleRateHz
      });
      if (!sent) {
        setOperatorStatusLine('realtime ASR offline', 'warn');
      }
    };

    return true;
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    if (processorNode) {
      try {
        processorNode.disconnect();
      } catch {
        // Ignore disconnect errors during failed realtime setup.
      }
    }
    if (processorSinkNode) {
      try {
        processorSinkNode.disconnect();
      } catch {
        // Ignore disconnect errors during failed realtime setup.
      }
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        // Ignore disconnect errors during failed realtime setup.
      }
    }
    if (audioContext) {
      void audioContext.close().catch(() => {});
    }
    throw error;
  }
}

async function stopOperatorRealtimeRecording() {
  if (!operatorMicState.recording || operatorMicState.mode !== 'realtime') {
    return;
  }

  operatorMicState.recording = false;
  if (operatorMicState.stopTimer) {
    clearTimeout(operatorMicState.stopTimer);
    operatorMicState.stopTimer = null;
  }

  setOperatorStatusLine('finalizing realtime audio...', 'default');
  const sent = sendOperatorRealtimeAsrPayload('operator_realtime_asr_stop', {
    language: operatorMicState.language
  });
  if (!sent) {
    clearOperatorRealtimeDraft(false);
    setOperatorStatusLine('realtime ASR offline', 'warn');
  }
  releaseOperatorMicCapture();
}

async function startOperatorRecording(language) {
  if (operatorMicState.recording) {
    return false;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setOperatorStatusLine('microphone unavailable (use text input)', 'warn');
    return false;
  }
  if (!shouldUseOperatorRealtimeAsr() && typeof MediaRecorder === 'undefined') {
    setOperatorStatusLine('microphone recorder unavailable (use text input)', 'warn');
    return false;
  }
  const activeInputKind = operatorActivePrompt?.input_kind ?? null;
  if (operatorUiState.awaiting && activeInputKind && activeInputKind !== 'text') {
    setOperatorStatusLine('prompt expects choice; use buttons or text input', 'warn');
    return false;
  }

  try {
    hideOperatorKeyboard(false);
    void unlockPlaybackAudio().catch(() => {
      setTtsPhase('browser_blocked', 'warn');
    });
    if (shouldUseOperatorRealtimeAsr()) {
      try {
        await startOperatorRealtimeRecording(language);
        if (operatorMicState.stopTimer) {
          clearTimeout(operatorMicState.stopTimer);
        }
        operatorMicState.stopTimer = setTimeout(() => {
          if (!operatorMicState.recording) {
            return;
          }
          stopOperatorRecordingAndTranscribe().catch(() => {
            // Ignore here. UI path already updates status on errors.
          });
        }, OPERATOR_ASR_MAX_RECORDING_MS);
        setOperatorStatusLine(`recording realtime (${operatorMicState.language})...`, 'ok');
        return true;
      } catch (error) {
        if (typeof MediaRecorder === 'undefined') {
          throw error;
        }
        releaseOperatorMicCapture();
        setOperatorStatusLine(`realtime unavailable; using batch (${language === 'ja' ? 'ja' : 'en'})...`, 'warn');
      }
    }
    const recorder = await ensureOperatorMediaRecorder();
    operatorMicState.mode = 'batch';
    operatorMicState.language = language === 'ja' ? 'ja' : 'en';
    operatorMicState.chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        operatorMicState.chunks.push(event.data);
      }
    };
    recorder.start();
    operatorMicState.recording = true;
    operatorMicState.startedAtMs = Date.now();
    if (operatorMicState.stopTimer) {
      clearTimeout(operatorMicState.stopTimer);
    }
    operatorMicState.stopTimer = setTimeout(() => {
      if (!operatorMicState.recording) {
        return;
      }
      stopOperatorRecordingAndTranscribe().catch(() => {
        // Ignore here. UI path already updates status on errors.
      });
    }, OPERATOR_ASR_MAX_RECORDING_MS);
    setOperatorStatusLine(`recording (${operatorMicState.language})...`, 'ok');
    return true;
  } catch (error) {
    setOperatorStatusLine(`mic error: ${error.message} (use text input)`, 'warn');
    releaseOperatorMicCapture();
    return false;
  }
}

async function requestOperatorAsrTranscript(blob, mimeType, language) {
  const query = new URLSearchParams();
  query.set('lang', language === 'ja' ? 'ja' : 'en');
  const response = await fetch(`/api/operator/asr?${query.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': mimeType || 'audio/webm'
    },
    body: blob
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload || payload.ok === false) {
    const detailText = formatOperatorAsrErrorDetail(payload?.detail);
    const detail = detailText ? `: ${detailText}` : '';
    throw new Error(`ASR failed (${response.status})${detail}`);
  }

  if (typeof payload.text !== 'string' || payload.text.trim() === '') {
    throw new Error('ASR returned empty text');
  }

  return {
    text: payload.text.trim(),
    language: payload.language === 'ja' ? 'ja' : 'en',
    confidence: Number.isFinite(payload.confidence) ? Number(payload.confidence) : null
  };
}

async function stopOperatorRecordingAndTranscribe() {
  if (!operatorMicState.recording) {
    return;
  }

  if (operatorMicState.mode === 'realtime') {
    await stopOperatorRealtimeRecording();
    return;
  }

  if (!operatorMicState.recorder) {
    return;
  }

  operatorMicState.recording = false;
  if (operatorMicState.stopTimer) {
    clearTimeout(operatorMicState.stopTimer);
    operatorMicState.stopTimer = null;
  }

  setOperatorStatusLine('processing audio...', 'default');
  try {
    const recorder = operatorMicState.recorder;
    const chunks = operatorMicState.chunks;
    const blob = await stopMediaRecorder(recorder, chunks);
    operatorMicState.chunks = [];

    if (!blob || blob.size < OPERATOR_MIN_AUDIO_BLOB_BYTES) {
      setOperatorStatusLine('recording was too short', 'warn');
      return;
    }

    const result = await requestOperatorAsrTranscript(blob, blob.type || recorder.mimeType || 'audio/webm', operatorMicState.language);
    const suspicion = getOperatorRealtimeAsrSuspicion(result.text, operatorMicState.language);
    if (suspicion) {
      setOperatorStatusLine(`asr rejected (${operatorMicState.language}): ${suspicion}`, 'warn');
      return;
    }
    appendOperatorTextInput(result.text, result.language);
  } catch (error) {
    setOperatorStatusLine(`asr error: ${error.message}`, 'warn');
  } finally {
    releaseOperatorMicCapture();
  }
}

function handleTtsAudio(payload) {
  void playBrowserAudioPayload(payload);
}

function handleTtsState(payload) {
  const phase = typeof payload.phase === 'string' ? payload.phase : '-';
  const audioTarget = typeof payload.audio_target === 'string' ? payload.audio_target : 'local';
  const reason = typeof payload.reason === 'string' ? payload.reason : null;
  const sessionId = resolvePayloadSessionId(payload);

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
      stopActiveBrowserAudio(payload.generation, sessionId);
    }
    setTtsStatus('ready', 'ok');
    setTtsPhase(phase, 'default');
    speechActive = false;
    speechMouthOpen = 0;
    return;
  }

  if (phase === 'interrupt_requested') {
    stopActiveBrowserAudio(payload.generation, sessionId);
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
    stopActiveBrowserAudio(payload.generation, sessionId);
    setTtsPhase(`dropped:${payload.reason ?? '-'}`, 'warn');
    if (!speechActive) {
      setTtsStatus('ready', 'default');
    }
    return;
  }

  if (phase === 'error') {
    stopActiveBrowserAudio(payload.generation, sessionId);
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

function handleOperatorRealtimeAsrDelta(payload) {
  if (!isCurrentOperatorRealtimeGeneration(payload.generation)) {
    return;
  }
  const delta = typeof payload.delta === 'string' ? payload.delta : '';
  if (delta === '') {
    return;
  }
  if (!operatorMicState.realtimeDraftActive) {
    beginOperatorRealtimeDraft(payload.language === 'ja' ? 'ja' : 'en');
  }
  applyOperatorRealtimeDelta(delta);
  setOperatorStatusLine(`transcribing (${payload.language === 'ja' ? 'ja' : 'en'})...`, 'ok');
}

function handleOperatorRealtimeAsrDone(payload) {
  if (!isCurrentOperatorRealtimeGeneration(payload.generation)) {
    return;
  }
  const language = payload.language === 'ja' ? 'ja' : 'en';
  const text = typeof payload.text === 'string' ? payload.text : '';
  const hadDraftText = operatorMicState.realtimeDraftActive && operatorMicState.realtimeText.trim() !== '';
  const resolved = resolveOperatorRealtimeAsrFinalText(text, operatorMicState.realtimeText, language);
  const candidateText = resolved.text;
  const suspicion = getOperatorRealtimeAsrSuspicion(candidateText, language);
  if (!operatorMicState.realtimeDraftActive) {
    if (candidateText !== '') {
      if (suspicion) {
        void attemptOperatorRealtimeBatchFallback(language, 'suspicious');
        return;
      }
      appendOperatorTextInput(candidateText, language);
      clearOperatorRealtimeAudioBuffer();
      setOperatorStatusLine(`realtime ASR ready (${language})`, 'ok');
      return;
    }
    void attemptOperatorRealtimeBatchFallback(language);
    return;
  }
  if (suspicion) {
    clearOperatorRealtimeDraft(false);
    void attemptOperatorRealtimeBatchFallback(language, 'suspicious');
    return;
  }
  finalizeOperatorRealtimeDraft(candidateText);
  if (candidateText === '' && !hadDraftText) {
    void attemptOperatorRealtimeBatchFallback(language);
    return;
  }
  clearOperatorRealtimeAudioBuffer();
  setOperatorStatusLine(`realtime ASR ready (${language})`, 'ok');
}

function handleOperatorRealtimeAsrError(payload) {
  if (!isCurrentOperatorRealtimeGeneration(payload.generation)) {
    return;
  }
  const error = typeof payload.error === 'string' ? payload.error : 'realtime_asr_error';
  const language = payload.language === 'ja' ? 'ja' : 'en';
  const hasBufferedAudio = operatorMicState.realtimePcmBytes > 0;
  if (operatorMicState.realtimeDraftActive) {
    clearOperatorRealtimeDraft(true);
  }
  if (hasBufferedAudio) {
    void attemptOperatorRealtimeBatchFallback(language, 'error');
    return;
  }
  clearOperatorRealtimeAudioBuffer();
  setOperatorStatusLine(`realtime ASR error: ${error}`, 'warn');
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
  trackAgentTileFromPayload(payload);

  if (payload.type === 'event') {
    faceState = applyEventToFaceState(faceState, payload, Date.now());
  } else if (payload.type === 'say' && typeof payload.text === 'string' && payload.text.trim() !== '') {
    if (shouldDisplaySay(payload)) {
      showUtterance(payload.text, payload.ttl_ms);
    }
  } else if (payload.type === 'say_result') {
    handleSayResult(payload);
  } else if (payload.type === 'operator_prompt') {
    handleOperatorPrompt(payload);
  } else if (payload.type === 'operator_ack') {
    handleOperatorAck(payload);
  } else if (payload.type === 'operator_state') {
    handleOperatorStatePayload(payload);
  } else if (payload.type === 'operator_recover_result') {
    handleOperatorRecoverResult(payload);
  } else if (payload.type === 'operator_set_pane_result') {
    if (payload.ok === true) {
      setOperatorStatusLine(`pane switched${payload.pane ? `: ${payload.pane}` : ''}`, 'ok');
      setOperatorAckLine('ack: pane switched', 'ok');
    } else {
      setOperatorStatusLine(`pane switch failed${payload.reason ? `: ${payload.reason}` : ''}`, 'warn');
    }
  } else if (payload.type === 'operator_terminal_snapshot') {
    handleOperatorTerminalSnapshot(payload);
  } else if (payload.type === 'operator_realtime_asr_delta') {
    handleOperatorRealtimeAsrDelta(payload);
  } else if (payload.type === 'operator_realtime_asr_done') {
    handleOperatorRealtimeAsrDone(payload);
  } else if (payload.type === 'operator_realtime_asr_error') {
    handleOperatorRealtimeAsrError(payload);
  } else if (payload.type === 'tts_state') {
    handleTtsState(payload);
  } else if (payload.type === 'tts_mouth') {
    handleTtsMouth(payload);
  } else if (payload.type === 'tts_audio') {
    handleTtsAudio(payload);
  }
  renderAgentDashboard();
}

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${window.location.host}/ws`;

  setWsStatus('connecting', 'default');

  socket = new WebSocket(wsUrl);

  socket.addEventListener('open', () => {
    reconnectAttempts = 0;
    setWsStatus('online', 'ok');
    dispatchOperatorUiAction({ type: 'socket_open' });
    setOperatorStatusLine('connected', 'ok');
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
    setOperatorStatusLine('socket error', 'warn');
  });

  socket.addEventListener('close', () => {
    setWsStatus('offline', 'warn');
    dispatchOperatorUiAction({ type: 'socket_close' });
    setOperatorStatusLine('offline', 'warn');

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
        const played = await playAudioSource(
          directSource.src,
          replay.generation,
          directSource.release,
          replay.sessionId ?? '-'
        );
        if (played.superseded) {
          return;
        }
        audioUnlocked = true;
        hideAudioReplayButton();
      } catch {
        try {
          await unlockPlaybackAudio();
          const retrySource = buildPlaybackSource(replay.mimeType, replay.audioBase64);
          const played = await playAudioSource(
            retrySource.src,
            replay.generation,
            retrySource.release,
            replay.sessionId ?? '-'
          );
          if (played.superseded) {
            return;
          }
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

function registerOperatorPttButton(button, language) {
  if (!button) {
    return;
  }

  button.addEventListener('pointerdown', async (event) => {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    event.preventDefault();
    operatorMicState.pointerArmed = true;
    const started = await startOperatorRecording(language);
    if (!started) {
      operatorMicState.pointerArmed = false;
      return;
    }
    if (!operatorMicState.pointerArmed) {
      await stopOperatorRecordingAndTranscribe();
    }
  });

  const stopHandler = async () => {
    if (!operatorMicState.pointerArmed) {
      return;
    }
    operatorMicState.pointerArmed = false;
    await stopOperatorRecordingAndTranscribe();
  };

  button.addEventListener('pointerup', stopHandler);
  button.addEventListener('pointerleave', stopHandler);
  button.addEventListener('pointercancel', stopHandler);
}

function installOperatorKeyboardPtt() {
  window.addEventListener('keydown', async (event) => {
    const language = resolveOperatorKeyboardPttLanguage(event, {
      isMobileUi: operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE,
      textInputElement: operatorTextInputEl
    });
    if (!language) {
      return;
    }
    if (operatorMicState.pointerArmed || operatorMicState.keyboardArmedKey !== null || operatorMicState.recording) {
      return;
    }
    if (operatorMicState.keyboardPendingKey !== null) {
      return;
    }

    event.preventDefault();
    if (document.activeElement === operatorTextInputEl) {
      operatorTextInputEl.blur();
    }
    if (shouldDelayOperatorKeyboardPttStart(event.key)) {
      operatorMicState.keyboardPendingKey = event.key;
      operatorMicState.keyboardPendingTimer = window.setTimeout(async () => {
        operatorMicState.keyboardPendingTimer = null;
        if (operatorMicState.keyboardPendingKey !== event.key) {
          return;
        }
        operatorMicState.keyboardPendingKey = null;
        if (operatorMicState.pointerArmed || operatorMicState.keyboardArmedKey !== null || operatorMicState.recording) {
          return;
        }
        setOperatorStatusLine(`keyboard PTT (${language})...`, 'default');
        operatorMicState.keyboardArmedKey = event.key;
        const started = await startOperatorRecording(language);
        if (!started) {
          if (operatorMicState.keyboardArmedKey === event.key) {
            operatorMicState.keyboardArmedKey = null;
          }
          return;
        }
        if (operatorMicState.keyboardArmedKey !== event.key) {
          await stopOperatorRecordingAndTranscribe();
        }
      }, OPERATOR_KEYBOARD_MODIFIER_PTT_DELAY_MS);
      return;
    }

    setOperatorStatusLine(`keyboard PTT (${language})...`, 'default');
    operatorMicState.keyboardArmedKey = event.key;
    const started = await startOperatorRecording(language);
    if (!started) {
      if (operatorMicState.keyboardArmedKey === event.key) {
        operatorMicState.keyboardArmedKey = null;
      }
      return;
    }
    if (operatorMicState.keyboardArmedKey !== event.key) {
      await stopOperatorRecordingAndTranscribe();
    }
  }, true);

  window.addEventListener('keyup', async (event) => {
    if (operatorMicState.keyboardPendingKey && event.key === operatorMicState.keyboardPendingKey) {
      event.preventDefault();
      cancelPendingOperatorKeyboardPttStart();
      return;
    }
    if (!operatorMicState.keyboardArmedKey || event.key !== operatorMicState.keyboardArmedKey) {
      return;
    }

    event.preventDefault();
    operatorMicState.keyboardArmedKey = null;
    await stopOperatorRecordingAndTranscribe();
  }, true);

  window.addEventListener('blur', () => {
    cancelPendingOperatorKeyboardPttStart();
    if (!operatorMicState.keyboardArmedKey) {
      return;
    }
    operatorMicState.keyboardArmedKey = null;
    void stopOperatorRecordingAndTranscribe();
  });
}

function installOperatorKeyboardCommands() {
  window.addEventListener('keydown', (event) => {
    const action = resolveOperatorKeyboardCommandAction(event, {
      textInputElement: operatorTextInputEl
    });
    if (!action) {
      return;
    }
    if (action === 'focus_text_input') {
      event.preventDefault();
      cancelPendingOperatorKeyboardPttStart();
      if (operatorMicState.keyboardArmedKey === 'Control' || operatorMicState.keyboardArmedKey === 'Alt') {
        operatorMicState.keyboardArmedKey = null;
        releaseOperatorMicCapture();
      }
      focusOperatorTextInput();
      return;
    }
    if (action === 'clear_text') {
      event.preventDefault();
      clearOperatorTextInput({ focusTextInput: true });
      return;
    }
    if (action === 'send_text') {
      event.preventDefault();
      submitOperatorTextInput();
      return;
    }
    if (action === 'mirror_page_up' || action === 'mirror_page_down') {
      if (!operatorMirrorEl || operatorMirrorEl.classList.contains('hidden')) {
        return;
      }
      event.preventDefault();
      scrollOperatorMirrorByPage(action === 'mirror_page_up' ? -1 : 1);
      return;
    }
    if (action === 'select_up' || action === 'select_down') {
      event.preventDefault();
      sendOperatorResponse('key', action === 'select_up' ? 'Up' : 'Down', { submit: false });
      return;
    }
    event.preventDefault();
    sendOperatorResponse('key', 'Enter', { submit: false });
  }, true);
}

async function handleOperatorEscButtonClick() {
  hideOperatorKeyboard();
  if (operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE && operatorEscRecoveryTracker.recordTap(Date.now())) {
    await requestOperatorRecoverDefault();
    return;
  }
  sendOperatorResponse('key', 'Esc', { requestId: null, submit: false });
}

function installOperatorControls() {
  if (!operatorPanelEl) {
    return;
  }

  operatorUiState = createInitialOperatorUiState();
  dispatchOperatorUiAction({ type: 'panel_open' });
  setOperatorStatusLine('connecting', 'default');
  setOperatorAckLine('ack: -', 'default');

  if (operatorHandleEl) {
    operatorHandleEl.addEventListener('click', () => {
      dispatchOperatorUiAction({ type: operatorUiState.panelOpen ? 'panel_close' : 'panel_open' });
    });
  }

  if (operatorCloseButtonEl) {
    operatorCloseButtonEl.addEventListener('click', () => {
      hideOperatorKeyboard();
      dispatchOperatorUiAction({ type: 'panel_close' });
    });
  }

  if (operatorRestartButtonEl) {
    operatorRestartButtonEl.addEventListener('click', () => {
      if (sendOperatorResponse('restart', 'restart', { requestId: null })) {
        setOperatorStatusLine('restart requested', 'default');
      }
    });
  }

  if (operatorEscButtonEl) {
    operatorEscButtonEl.addEventListener('click', () => {
      void handleOperatorEscButtonClick();
    });
  }
  if (operatorEscInlineButtonEl) {
    operatorEscInlineButtonEl.addEventListener('click', () => {
      void handleOperatorEscButtonClick();
    });
  }

  if (operatorMirrorToggleEl) {
    operatorMirrorToggleEl.addEventListener('click', () => {
      dispatchOperatorUiAction({ type: 'mirror_toggle' });
    });
  }
  if (operatorHelpToggleEl) {
    operatorHelpToggleEl.addEventListener('click', () => {
      operatorKeyboardHelpOpen = !operatorKeyboardHelpOpen;
      updateOperatorUi();
    });
  }
  if (operatorMirrorEl) {
    operatorMirrorEl.addEventListener('scroll', handleOperatorMirrorScroll, { passive: true });
  }

  if (operatorTextSendButtonEl) {
    operatorTextSendButtonEl.addEventListener('click', () => {
      submitOperatorTextInput();
    });
  }
  if (operatorTextClearButtonEl) {
    operatorTextClearButtonEl.addEventListener('pointerdown', (event) => {
      event.preventDefault();
    });
    operatorTextClearButtonEl.addEventListener('click', () => {
      clearOperatorTextInput({ focusTextInput: true });
    });
  }
  if (operatorTextCancelButtonEl) {
    operatorTextCancelButtonEl.addEventListener('click', () => {
      hideOperatorKeyboard();
    });
  }
  if (operatorTextInputEl) {
    syncOperatorTextInputHeight();
    operatorTextInputEl.addEventListener('input', () => {
      syncOperatorTextInputHeight();
    });
    operatorTextInputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        hideOperatorKeyboard();
        return;
      }
      if (event.key === 'Enter') {
        return;
      }
    });
    window.addEventListener('resize', syncOperatorTextInputHeight);
  }

  const keyBindings = [
    [operatorKeyUpEl, 'Up'],
    [operatorKeyDownEl, 'Down'],
    [operatorKeyEnterEl, 'Enter']
  ];
  for (const [button, token] of keyBindings) {
    if (!button) {
      continue;
    }
    button.addEventListener('click', () => {
      sendOperatorResponse('key', token, { submit: false });
    });
  }

  registerOperatorPttButton(operatorPttJaButtonEl, 'ja');
  registerOperatorPttButton(operatorPttEnButtonEl, 'en');
  installOperatorKeyboardPtt();
  installOperatorKeyboardCommands();
  updateOperatorUi();
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

function markOperatorUiBootReady() {
  document.body.classList.remove('boot-pending');
}

async function bootstrap() {
  await loadOperatorUiConfig();
  setMetricValue(renderModeEl, 'monitor', 'default');
  setTtsStatus('starting', 'default');
  setTtsPhase('-', 'default');

  await installLookingGlassPolyfill();
  mountXrButton();
  installGestureShortcuts();
  installAudioUnlockHooks();
  installAudioReplayButton();
  if (operatorPanelEnabled) {
    installOperatorControls();
  } else {
    updateOperatorUi();
  }
  installAgentDashboardControls();
  await refreshAgentDashboardState({ silentStatus: false });
  scheduleAgentDashboardPoll(AGENT_DASHBOARD_POLL_INTERVAL_MS);
  markOperatorUiBootReady();

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
  markOperatorUiBootReady();
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
  if (agentDashboardPollTimer !== null) {
    clearTimeout(agentDashboardPollTimer);
    agentDashboardPollTimer = null;
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }

  releaseOperatorMicCapture();
  stopActiveBrowserAudio();
  renderer.setAnimationLoop(null);
  renderer.dispose();
});
