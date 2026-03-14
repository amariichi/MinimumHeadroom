import * as THREE from 'three';
import {
  AXIS_CONVENTION,
  FEATURE_ANCHORS,
  applyDragEmotionBias,
  createInitialFaceState,
  deriveFaceControls,
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
  deriveAgentOperationalState,
  deriveAssignmentToneOptions,
  deriveAgentTileTone,
  deriveDashboardMode,
  deriveOwnerInboxToneOptions,
  normalizeDashboardAgent,
  resolveAgentQuietActivityAt,
  shouldRefreshAgentActivityFromState,
  shouldUseAgentQuietPromptIdle,
  sortDashboardAgents,
  summarizeAgentOperationalState,
  summarizeAgentTileMessage,
  summarizeOwnerInboxSummary
} from './agent_dashboard_state.js';
import { resolveAgentsFromActionResult } from './agent_dashboard_apply_result.js';
import { listAgentLifecycleActions, shouldShowMobileAgentList } from './agent_dashboard_actions.js';
import { summarizeAgentActionFailure, summarizeAgentActionSuccess } from './agent_dashboard_action_feedback.js';
import {
  deriveAgentTransientUpdate,
  resolveAgentIdForPane,
  shouldCountPayloadAsAgentActivity
} from './agent_dashboard_feed.js';
import { createAgentDashboardFaceRenderer } from './agent_dashboard_face_renderer.js';
import { deriveAgentFaceIdentity, faceAccentCss } from './agent_face_identity.js';
import { applyIdleMotionToControls } from './face_idle_motion.js';
import {
  applyAgentFaceRuntimeDragDelta,
  applyAgentFaceRuntimeDragToControls,
  applyPayloadToAgentFaceRuntime,
  createAgentFaceRuntime,
  resolveFaceAgentId,
  setAgentFaceRuntimeDragActive,
  stepAgentFaceRuntime
} from './agent_face_store.js';
import {
  addFaceLights,
  applyAppearanceToRig,
  applyControlsToRig,
  createFaceCamera,
  createFaceRig
} from './face_rig.js';

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
const operatorCurrentAgentButtonEl = document.getElementById('operator-agent-current');
const operatorCurrentAgentLabelEl = document.getElementById('operator-agent-current-label');
const operatorCurrentAgentMetaEl = document.getElementById('operator-agent-current-meta');
const operatorStatusEl = document.getElementById('operator-status');
const operatorPromptEl = document.getElementById('operator-prompt');
const operatorAgentListEl = document.getElementById('operator-agent-list');
const operatorAgentListItemsEl = document.getElementById('operator-agent-list-items');
const operatorAgentListAddButtonEl = document.getElementById('operator-agent-list-add');
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
const agentDashboardFaceCanvasEl = document.getElementById('agent-dashboard-face-canvas');
const agentDashboardStatusEl = document.getElementById('agent-dashboard-status');
const agentDashboardGridEl = document.getElementById('agent-dashboard-grid');
const agentDashboardCloseButtonEl = document.getElementById('agent-dashboard-close');
const agentDashboardAddToggleButtonEl = document.getElementById('agent-dashboard-add-toggle');
const agentDashboardAddFormEl = document.getElementById('agent-dashboard-add-form');
const agentDashboardAddIdEl = document.getElementById('agent-dashboard-id');
const agentDashboardAddSessionIdEl = document.getElementById('agent-dashboard-session-id');
const agentDashboardAddRepoPathEl = document.getElementById('agent-dashboard-repo-path');
const agentDashboardAddBranchEl = document.getElementById('agent-dashboard-branch');
const agentDashboardAddSubmitEl = document.getElementById('agent-dashboard-add-submit');

const LOOKING_GLASS_ENABLED_KEY = 'mh_lg_webxr_enabled';
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
const OPERATOR_ASR_MAX_RECORDING_MS = 30_000;
const OPERATOR_MIN_AUDIO_BLOB_BYTES = 900;
const OPERATOR_REALTIME_ASR_DEFAULT_SAMPLE_RATE = 16_000;
const OPERATOR_REALTIME_ASR_PROCESSOR_BUFFER_SIZE = 4096;
const OPERATOR_REALTIME_BATCH_FALLBACK_MIN_SECONDS = 0.25;
const OPERATOR_KEYBOARD_MODIFIER_PTT_DELAY_MS = 140;
const OPERATOR_KEYBOARD_SPACE_PTT_DELAY_MS = 1_000;
const OPERATOR_ESC_RECOVERY_REQUIRED_TAPS = 4;
const OPERATOR_ESC_RECOVERY_WINDOW_MS = 1_600;
const OPERATOR_RECOVER_PENDING_TIMEOUT_MS = 3_000;
const OPERATOR_FOCUS_PENDING_TIMEOUT_MS = 3_000;
const OPERATOR_MIRROR_ACTIVITY_SUPPRESS_MS = 1_500;
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
const AGENT_TILE_PROMPT_IDLE_TTL_MS = 90_000;
const AGENT_TILE_PROMPT_IDLE_QUIET_MS = 8_000;
const AGENT_TILE_MIRROR_ACTIVITY_RETENTION_MS = 10 * 60_000;
const AGENT_DASHBOARD_RERENDER_INTERVAL_MS = 750;
const AGENT_TILE_DRAG_START_THRESHOLD_PX = 8;
const AGENT_TILE_DRAG_FOCUS_SUPPRESS_MS = 260;
const DESKTOP_DASHBOARD_BASELINE_HEIGHT_PX = 1_080;
const DESKTOP_DASHBOARD_MAX_UPSCALE = 1.16;
const DESKTOP_DASHBOARD_WIDTH_RESERVE_PX = 430;
const OPERATOR_DASHBOARD_AGENT_ID = '__operator__';
const OPERATOR_DASHBOARD_AGENT_LABEL = 'operator';
const OPERATOR_BRIDGE_SESSION_ID_DEFAULT = 'default';
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

function createScene(renderer) {
  const scene = new THREE.Scene();
  addFaceLights(scene);
  const camera = createFaceCamera();
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
const agentFaceRuntimeById = new Map();
const agentDashboardFaceRenderer = agentDashboardFaceCanvasEl ? createAgentDashboardFaceRenderer(agentDashboardFaceCanvasEl) : null;
let agentDashboardFaceDescriptors = [];
const agentTileFocusSuppressUntilById = new Map();
const agentTileDragState = {
  pointerId: null,
  agentId: null,
  slotEl: null,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  lastTimeMs: 0,
  dragging: false
};

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
let operatorBridgeSessionId = OPERATOR_BRIDGE_SESSION_ID_DEFAULT;
let operatorMirrorPaneId = null;
let operatorRecoverPending = false;
let operatorRecoverPendingTimer = null;
let lastAgentDashboardRerenderAt = 0;
let operatorFocusPending = null;
let operatorFocusPendingTimer = null;
let operatorMirrorActivitySuppression = null;
let agentDashboardPollTimer = null;
let agentDashboardLoadInFlight = null;
let agentDashboardAddFormOpen = false;
let agentDashboardAddPending = false;
let agentDashboardSurfaceOpen = false;
let operatorAgentPickerOpen = false;
let agentDashboardState = {
  mode: 'single',
  selectedAgentId: OPERATOR_DASHBOARD_AGENT_ID,
  agents: [],
  activeStreamId: null,
  activeTargetRepoRoot: null,
  hiddenAgentCount: 0,
  loaded: false
};
let ownerInboxViewState = {
  loaded: false,
  reports: [],
  summary: {
    unresolved_count: 0,
    blocking_count: 0,
    informational_count: 0,
    error_count: 0,
    top_report: null,
    summary: null,
    by_agent_id: {}
  }
};
let agentAssignmentViewState = {
  loaded: false,
  assignments: [],
  latestByAgentId: {},
  summary: {
    count: 0,
    by_delivery_state: {
      pending: 0,
      sent_to_tmux: 0,
      acked: 0,
      acked_late: 0,
      failed: 0,
      timeout: 0
    },
    by_agent_id: {}
  }
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
  if (
    typeof operatorBridgeSessionId === 'string' &&
    operatorBridgeSessionId.trim() !== '' &&
    operatorBridgeSessionId !== '-'
  ) {
    return operatorBridgeSessionId;
  }
  return OPERATOR_BRIDGE_SESSION_ID_DEFAULT;
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

function createAgentTileSpeechBubble(text) {
  const bubble = document.createElement('div');
  bubble.className = 'agent-tile-speech-bubble';
  bubble.textContent = text;
  bubble.setAttribute('aria-hidden', 'true');
  return bubble;
}

function setAgentDashboardStatus(text, tone = 'default') {
  if (!agentDashboardStatusEl) {
    return;
  }
  agentDashboardStatusEl.textContent = text;
  agentDashboardStatusEl.style.color = toneColor(tone);
}

function refreshAgentDashboardSoon() {
  void refreshAgentDashboardState({ silentStatus: true });
}

function updateOperatorCurrentAgentBar() {
  if (!operatorCurrentAgentButtonEl || !operatorCurrentAgentLabelEl || !operatorCurrentAgentMetaEl) {
    return;
  }
  const current = getCurrentDashboardAgent();
  const nowMs = Date.now();
  const toneOptions = resolveAgentTransientToneOptions(current?.id ?? OPERATOR_DASHBOARD_AGENT_ID, current, nowMs);
  const currentSummary = isOperatorDashboardAgentId(current?.id ?? OPERATOR_DASHBOARD_AGENT_ID)
    ? getOwnerInboxOverallSummary()
    : getOwnerInboxAgentSummary(current?.id ?? '');
  const currentAssignment = isOperatorDashboardAgentId(current?.id ?? OPERATOR_DASHBOARD_AGENT_ID)
    ? null
    : getLatestAgentAssignment(current?.id ?? '');
  const unresolvedCount = Number.isFinite(currentSummary?.unresolved_count) ? Math.max(0, Math.floor(currentSummary.unresolved_count)) : 0;
  const label = current?.label ?? current?.id ?? OPERATOR_DASHBOARD_AGENT_LABEL;
  const operationalState = deriveAgentOperationalState(current, {
    ...toneOptions,
    nowMs,
    lastActivityAt: resolveAgentQuietActivityAt(current, agentTransientStateById.get(current?.id ?? '') ?? null),
    ownerInboxSummary: currentSummary,
    assignment: currentAssignment
  });
  const status = summarizeAgentOperationalState(operationalState);
  const message = summarizeAgentTileMessage(
    current,
    null,
    summarizeOwnerInboxSummary(currentSummary),
    operationalState
  );
  const countText = formatDashboardVisibleCount();
  const paneText = operatorMirrorPaneId ? ` · ${operatorMirrorPaneId}` : '';
  operatorCurrentAgentLabelEl.textContent = label;
  operatorCurrentAgentMetaEl.textContent = `${status} · ${countText}${paneText}${unresolvedCount > 0 ? ` · inbox ${unresolvedCount}` : ''}${message ? ` · ${truncateAgentText(message, 40)}` : ''}`;
  operatorCurrentAgentButtonEl.dataset.tone = deriveAgentTileTone(current, toneOptions);
  operatorCurrentAgentButtonEl.setAttribute(
    'aria-expanded',
    operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE ? String(operatorAgentPickerOpen) : String(agentDashboardSurfaceOpen)
  );
}

function clearPendingOperatorFocus() {
  operatorFocusPending = null;
  if (operatorFocusPendingTimer !== null) {
    window.clearTimeout(operatorFocusPendingTimer);
    operatorFocusPendingTimer = null;
  }
}

function armPendingOperatorFocus(agentId, options = {}) {
  clearPendingOperatorFocus();
  operatorFocusPending = {
    agentId,
    closePicker: options.closePicker === true
  };
  operatorFocusPendingTimer = window.setTimeout(() => {
    const pending = operatorFocusPending;
    clearPendingOperatorFocus();
    if (!pending) {
      return;
    }
    setAgentDashboardStatus(`focus timeout: ${pending.agentId}`, 'warn');
    renderAgentDashboard();
    updateOperatorUi();
  }, OPERATOR_FOCUS_PENDING_TIMEOUT_MS);
}

function applyCompletedOperatorFocus(agentId, closePicker = true) {
  agentDashboardState.selectedAgentId = agentId;
  if (closePicker) {
    closeDesktopAgentDashboardSurface();
    operatorAgentPickerOpen = false;
  }
  renderAgentDashboard();
  updateOperatorUi();
}

function shouldCloseOperatorPickerAfterFocus() {
  return operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE;
}

function handleCompletedOperatorFocusResult(options = {}) {
  const paneId = typeof options.pane === 'string' && options.pane.trim() !== '' ? options.pane.trim() : null;
  const focusedAgentId =
    typeof options.agentId === 'string' && options.agentId.trim() !== '' ? options.agentId.trim() : null;
  const ackText = typeof options.ackText === 'string' && options.ackText.trim() !== '' ? options.ackText.trim() : 'ack: pane switched';
  const statusPrefix =
    typeof options.statusPrefix === 'string' && options.statusPrefix.trim() !== '' ? options.statusPrefix.trim() : 'pane switched';

  operatorMirrorPaneId = paneId ?? operatorMirrorPaneId;
  if (paneId) {
    operatorMirrorActivitySuppression = {
      paneId,
      expiresAt: Date.now() + OPERATOR_MIRROR_ACTIVITY_SUPPRESS_MS
    };
  }
  if (operatorFocusPending) {
    const pending = operatorFocusPending;
    applyCompletedOperatorFocus(pending.agentId, pending.closePicker);
    clearPendingOperatorFocus();
  } else if (focusedAgentId) {
    agentDashboardState.selectedAgentId = focusedAgentId;
  }
  if (focusedAgentId) {
    setAgentTransientMessage(focusedAgentId, 'focused in operator');
  }
  if (focusedAgentId === OPERATOR_DASHBOARD_AGENT_ID) {
    setAgentDashboardStatus('operator selected', 'ok');
  } else if (focusedAgentId) {
    setAgentDashboardStatus(`${focusedAgentId}: focus ok`, 'ok');
  }
  setOperatorStatusLine(`${statusPrefix}${paneId ? `: ${paneId}` : ''}`, 'ok');
  setOperatorAckLine(ackText, 'ok');
  void refreshAgentDashboardState({ silentStatus: true });
}

function handleFailedOperatorFocusResult(reason, options = {}) {
  const normalizedReason = typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : 'focus_failed';
  const ackPrefix =
    typeof options.ackPrefix === 'string' && options.ackPrefix.trim() !== '' ? options.ackPrefix.trim() : 'ack: focus failed';
  const statusPrefix =
    typeof options.statusPrefix === 'string' && options.statusPrefix.trim() !== '' ? options.statusPrefix.trim() : 'focus failed';
  const pendingAgentId = typeof options.pendingAgentId === 'string' && options.pendingAgentId.trim() !== ''
    ? options.pendingAgentId.trim()
    : null;

  if (!pendingAgentId || operatorFocusPending?.agentId === pendingAgentId) {
    clearPendingOperatorFocus();
  }
  setAgentDashboardStatus(`${statusPrefix}: ${normalizedReason}`, 'warn');
  setOperatorAckLine(`${ackPrefix} (${normalizedReason})`, 'warn');
  setOperatorStatusLine(`${statusPrefix}: ${normalizedReason}`, 'warn');
}

function normalizeDashboardAgentList(rawAgents) {
  if (!Array.isArray(rawAgents)) {
    return [];
  }
  const mapped = rawAgents.map((agent, index) => normalizeDashboardAgent(agent, index));
  return sortDashboardAgents(mapped);
}

function normalizeDashboardStatePayload(rawState) {
  if (!rawState || typeof rawState !== 'object') {
    return {
      agents: [],
      activeStreamId: null,
      activeTargetRepoRoot: null,
      hiddenAgentCount: 0
    };
  }
  return {
    agents: normalizeDashboardAgentList(rawState.agents),
    activeStreamId: typeof rawState.active_stream_id === 'string' && rawState.active_stream_id.trim() !== ''
      ? rawState.active_stream_id.trim()
      : null,
    activeTargetRepoRoot: typeof rawState.active_target_repo_root === 'string' && rawState.active_target_repo_root.trim() !== ''
      ? rawState.active_target_repo_root.trim()
      : null,
    hiddenAgentCount: Number.isFinite(rawState.hidden_agent_count)
      ? Math.max(0, Math.floor(rawState.hidden_agent_count))
      : 0
  };
}

function getTrackedDashboardAgents() {
  return agentDashboardState.agents;
}

function getOperatorDashboardAdditionalCount() {
  return operatorPanelEnabled ? 1 : 0;
}

function getDashboardVisibleCount() {
  return getTrackedDashboardAgents().length + getOperatorDashboardAdditionalCount();
}

function isOperatorDashboardAgentId(agentId) {
  return agentId === OPERATOR_DASHBOARD_AGENT_ID;
}

function getCurrentDashboardAgent() {
  if (isOperatorDashboardAgentId(agentDashboardState.selectedAgentId)) {
    return {
      id: OPERATOR_DASHBOARD_AGENT_ID,
      label: OPERATOR_DASHBOARD_AGENT_LABEL,
      status: operatorRecoverPending ? 'recovering' : 'active',
      session_id: resolveOperatorSessionId(),
      last_message: operatorRecoverPending ? 'recovering operator...' : 'primary operator'
    };
  }
  return agentDashboardState.agents.find((agent) => agent.id === agentDashboardState.selectedAgentId) ?? null;
}

function createEmptyOwnerInboxViewState() {
  return {
    loaded: true,
    reports: [],
    summary: {
      unresolved_count: 0,
      blocking_count: 0,
      informational_count: 0,
      error_count: 0,
      top_report: null,
      summary: null,
      by_agent_id: {}
    }
  };
}

function createEmptyAgentAssignmentViewState() {
  return {
    loaded: true,
    assignments: [],
    latestByAgentId: {},
    summary: {
      count: 0,
      by_delivery_state: {
        pending: 0,
        sent_to_tmux: 0,
        acked: 0,
        acked_late: 0,
        failed: 0,
        timeout: 0
      },
      by_agent_id: {}
    }
  };
}

function normalizeAssignmentAgentSummary(rawSummary = {}) {
  return {
    count: Number.isFinite(rawSummary?.count) ? Math.max(0, Math.floor(rawSummary.count)) : 0,
    pending: Number.isFinite(rawSummary?.pending) ? Math.max(0, Math.floor(rawSummary.pending)) : 0,
    sent_to_tmux: Number.isFinite(rawSummary?.sent_to_tmux) ? Math.max(0, Math.floor(rawSummary.sent_to_tmux)) : 0,
    acked: Number.isFinite(rawSummary?.acked) ? Math.max(0, Math.floor(rawSummary.acked)) : 0,
    acked_late: Number.isFinite(rawSummary?.acked_late) ? Math.max(0, Math.floor(rawSummary.acked_late)) : 0,
    failed: Number.isFinite(rawSummary?.failed) ? Math.max(0, Math.floor(rawSummary.failed)) : 0,
    timeout: Number.isFinite(rawSummary?.timeout) ? Math.max(0, Math.floor(rawSummary.timeout)) : 0
  };
}

function normalizeAssignmentRecord(rawAssignment = {}) {
  return {
    stream_id: typeof rawAssignment?.stream_id === 'string' ? rawAssignment.stream_id : null,
    mission_id: typeof rawAssignment?.mission_id === 'string' ? rawAssignment.mission_id : null,
    agent_id: typeof rawAssignment?.agent_id === 'string' ? rawAssignment.agent_id : null,
    delivery_state: typeof rawAssignment?.delivery_state === 'string' ? rawAssignment.delivery_state : 'pending',
    last_report_kind: typeof rawAssignment?.last_report_kind === 'string' ? rawAssignment.last_report_kind : null,
    last_report_at: Number.isFinite(rawAssignment?.last_report_at) ? Math.max(0, Math.floor(rawAssignment.last_report_at)) : 0,
    updated_at: Number.isFinite(rawAssignment?.updated_at) ? Math.max(0, Math.floor(rawAssignment.updated_at)) : 0
  };
}

function normalizeAgentAssignmentViewState(rawState) {
  const empty = createEmptyAgentAssignmentViewState();
  if (!rawState || typeof rawState !== 'object') {
    return empty;
  }
  const assignments = Array.isArray(rawState.assignments) ? rawState.assignments.map((item) => normalizeAssignmentRecord(item)) : [];
  const latestByAgentId = {};
  for (const assignment of assignments) {
    if (!assignment.agent_id) {
      continue;
    }
    const current = latestByAgentId[assignment.agent_id];
    if (!current || assignment.updated_at > current.updated_at) {
      latestByAgentId[assignment.agent_id] = assignment;
    }
  }
  const rawSummary = rawState.summary && typeof rawState.summary === 'object' ? rawState.summary : {};
  const rawByAgentId = rawSummary.by_agent_id && typeof rawSummary.by_agent_id === 'object' ? rawSummary.by_agent_id : {};
  const byAgentId = {};
  for (const [agentId, summary] of Object.entries(rawByAgentId)) {
    byAgentId[agentId] = normalizeAssignmentAgentSummary(summary);
  }
  return {
    loaded: true,
    assignments,
    latestByAgentId,
    summary: {
      count: Number.isFinite(rawSummary?.count) ? Math.max(0, Math.floor(rawSummary.count)) : assignments.length,
      by_delivery_state: {
        pending: Number.isFinite(rawSummary?.by_delivery_state?.pending) ? Math.max(0, Math.floor(rawSummary.by_delivery_state.pending)) : 0,
        sent_to_tmux: Number.isFinite(rawSummary?.by_delivery_state?.sent_to_tmux) ? Math.max(0, Math.floor(rawSummary.by_delivery_state.sent_to_tmux)) : 0,
        acked: Number.isFinite(rawSummary?.by_delivery_state?.acked) ? Math.max(0, Math.floor(rawSummary.by_delivery_state.acked)) : 0,
        acked_late: Number.isFinite(rawSummary?.by_delivery_state?.acked_late) ? Math.max(0, Math.floor(rawSummary.by_delivery_state.acked_late)) : 0,
        failed: Number.isFinite(rawSummary?.by_delivery_state?.failed) ? Math.max(0, Math.floor(rawSummary.by_delivery_state.failed)) : 0,
        timeout: Number.isFinite(rawSummary?.by_delivery_state?.timeout) ? Math.max(0, Math.floor(rawSummary.by_delivery_state.timeout)) : 0
      },
      by_agent_id: byAgentId
    }
  };
}

function normalizeOwnerInboxAgentSummary(rawSummary = {}) {
  return {
    agent_id: typeof rawSummary?.agent_id === 'string' ? rawSummary.agent_id : null,
    unresolved_count: Number.isFinite(rawSummary?.unresolved_count) ? Math.max(0, Math.floor(rawSummary.unresolved_count)) : 0,
    blocking_count: Number.isFinite(rawSummary?.blocking_count) ? Math.max(0, Math.floor(rawSummary.blocking_count)) : 0,
    informational_count: Number.isFinite(rawSummary?.informational_count) ? Math.max(0, Math.floor(rawSummary.informational_count)) : 0,
    error_count: Number.isFinite(rawSummary?.error_count) ? Math.max(0, Math.floor(rawSummary.error_count)) : 0,
    top_report: rawSummary?.top_report && typeof rawSummary.top_report === 'object' ? rawSummary.top_report : null,
    summary: typeof rawSummary?.summary === 'string' ? rawSummary.summary : null
  };
}

function normalizeOwnerInboxViewState(rawState) {
  const empty = createEmptyOwnerInboxViewState();
  if (!rawState || typeof rawState !== 'object') {
    return empty;
  }
  const reports = Array.isArray(rawState.reports) ? rawState.reports : [];
  const rawSummary = rawState.summary && typeof rawState.summary === 'object' ? rawState.summary : {};
  const byAgentId = {};
  const rawByAgentId = rawSummary.by_agent_id && typeof rawSummary.by_agent_id === 'object' ? rawSummary.by_agent_id : {};
  for (const [agentId, summary] of Object.entries(rawByAgentId)) {
    byAgentId[agentId] = normalizeOwnerInboxAgentSummary({
      ...summary,
      agent_id: typeof summary?.agent_id === 'string' ? summary.agent_id : agentId
    });
  }
  return {
    loaded: true,
    reports,
    summary: {
      unresolved_count: Number.isFinite(rawSummary?.unresolved_count) ? Math.max(0, Math.floor(rawSummary.unresolved_count)) : 0,
      blocking_count: Number.isFinite(rawSummary?.blocking_count) ? Math.max(0, Math.floor(rawSummary.blocking_count)) : 0,
      informational_count: Number.isFinite(rawSummary?.informational_count) ? Math.max(0, Math.floor(rawSummary.informational_count)) : 0,
      error_count: Number.isFinite(rawSummary?.error_count) ? Math.max(0, Math.floor(rawSummary.error_count)) : 0,
      top_report: rawSummary?.top_report && typeof rawSummary.top_report === 'object' ? rawSummary.top_report : null,
      summary: typeof rawSummary?.summary === 'string' ? rawSummary.summary : null,
      by_agent_id: byAgentId
    }
  };
}

function getOwnerInboxOverallSummary() {
  return ownerInboxViewState?.summary ?? createEmptyOwnerInboxViewState().summary;
}

function getOwnerInboxAgentSummary(agentId) {
  if (!agentId) {
    return null;
  }
  return ownerInboxViewState?.summary?.by_agent_id?.[agentId] ?? null;
}

function getLatestAgentAssignment(agentId) {
  if (!agentId) {
    return null;
  }
  return agentAssignmentViewState?.latestByAgentId?.[agentId] ?? null;
}

function syncSelectedDashboardAgentToMirrorPane() {
  if (!operatorMirrorPaneId) {
    return;
  }
  const focusedAgent = agentDashboardState.agents.find((agent) => agent.pane_id === operatorMirrorPaneId) ?? null;
  agentDashboardState.selectedAgentId = focusedAgent ? focusedAgent.id : OPERATOR_DASHBOARD_AGENT_ID;
}

function formatDashboardVisibleCount() {
  const count = getDashboardVisibleCount();
  return `${count} agent${count === 1 ? '' : 's'}`;
}

function computeDesktopAgentGridColumns(count) {
  if (count <= 1) {
    return 1;
  }
  if (count === 2) {
    return 2;
  }
  if (count === 3) {
    return 3;
  }
  return 4;
}

function resolveDesktopDashboardWidth(columns) {
  const viewportWidth = Math.max(320, window.innerWidth || 0);
  const viewportHeight = Math.max(640, window.innerHeight || 0);
  let baseWidth = 1240;
  if (columns <= 1) {
    baseWidth = 360;
  } else if (columns === 2) {
    baseWidth = 760;
  } else if (columns === 3) {
    baseWidth = 1080;
  }

  const availableWidth = Math.max(320, viewportWidth - DESKTOP_DASHBOARD_WIDTH_RESERVE_PX);
  const heightScale = clamp(viewportHeight / DESKTOP_DASHBOARD_BASELINE_HEIGHT_PX, 1, DESKTOP_DASHBOARD_MAX_UPSCALE);
  const widthScale = clamp(availableWidth / baseWidth, 1, DESKTOP_DASHBOARD_MAX_UPSCALE);
  const scale = Math.min(heightScale, widthScale);
  return `${Math.round(baseWidth * scale)}px`;
}

function resolveDesktopFaceSlotAspect(columns) {
  if (columns <= 1) {
    return '1 / 0.98';
  }
  if (columns === 2) {
    return '1 / 0.84';
  }
  if (columns === 3) {
    return '1 / 0.76';
  }
  return '1 / 0.72';
}

function closeDesktopAgentDashboardSurface() {
  agentDashboardSurfaceOpen = false;
}

function toggleDesktopAgentDashboardSurface(forceOpen = null) {
  if (operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE) {
    return;
  }
  agentDashboardSurfaceOpen = typeof forceOpen === 'boolean' ? forceOpen : !agentDashboardSurfaceOpen;
  if (agentDashboardSurfaceOpen) {
    operatorAgentPickerOpen = false;
    void refreshAgentDashboardState({ silentStatus: true });
  }
  renderAgentDashboard();
}

function toggleOperatorAgentPicker(forceOpen = null) {
  if (operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE) {
    operatorAgentPickerOpen = typeof forceOpen === 'boolean' ? forceOpen : !operatorAgentPickerOpen;
    if (operatorAgentPickerOpen) {
      void refreshAgentDashboardState({ silentStatus: true });
    }
    renderAgentDashboard();
    updateOperatorUi();
    return;
  }
  toggleDesktopAgentDashboardSurface(forceOpen);
}

function ensureSelectedDashboardAgent() {
  syncSelectedDashboardAgentToMirrorPane();
  if (agentDashboardState.selectedAgentId) {
    if (agentDashboardState.selectedAgentId === OPERATOR_DASHBOARD_AGENT_ID && operatorPanelEnabled) {
      return;
    }
    const existing = agentDashboardState.agents.find((agent) => agent.id === agentDashboardState.selectedAgentId);
    if (existing) {
      return;
    }
  }
  if (operatorPanelEnabled) {
    agentDashboardState.selectedAgentId = OPERATOR_DASHBOARD_AGENT_ID;
    return;
  }
  const fallback = getTrackedDashboardAgents()[0] ?? agentDashboardState.agents[0] ?? null;
  agentDashboardState.selectedAgentId = fallback?.id ?? null;
}

function getAgentFaceIdentitySource(agentId) {
  if (isOperatorDashboardAgentId(agentId)) {
    return {
      id: OPERATOR_DASHBOARD_AGENT_ID,
      session_id: resolveOperatorSessionId()
    };
  }
  return agentDashboardState.agents.find((agent) => agent.id === agentId) ?? { id: agentId };
}

function getOrCreateAgentFaceRuntime(agentId, nowMs = Date.now()) {
  const source = getAgentFaceIdentitySource(agentId);
  const identity = deriveAgentFaceIdentity(source);
  const existing = agentFaceRuntimeById.get(agentId);
  if (existing) {
    existing.identity = identity;
    existing.appearance = identity.appearance;
    existing.motion = identity.motion;
    return existing;
  }
  const runtime = createAgentFaceRuntime({
    nowMs,
    appearance: identity.appearance,
    motion: identity.motion
  });
  runtime.identity = identity;
  agentFaceRuntimeById.set(agentId, runtime);
  return runtime;
}

function syncKnownAgentFaceRuntimes(nowMs = Date.now()) {
  getOrCreateAgentFaceRuntime(OPERATOR_DASHBOARD_AGENT_ID, nowMs);
  for (const agent of agentDashboardState.agents) {
    getOrCreateAgentFaceRuntime(agent.id, nowMs);
  }
}

function resolvePayloadAgentIdForFace(payload) {
  return resolveFaceAgentId(payload, agentDashboardState.agents, {
    operatorAgentId: OPERATOR_DASHBOARD_AGENT_ID,
    operatorSessionId: resolveOperatorSessionId()
  });
}

function applyPayloadToFaceRuntimeStore(payload, nowMs = Date.now()) {
  const agentId = resolvePayloadAgentIdForFace(payload);
  if (!agentId) {
    return null;
  }
  const runtime = getOrCreateAgentFaceRuntime(agentId, nowMs);
  applyPayloadToAgentFaceRuntime(runtime, payload, nowMs);
  return agentId;
}

function getCurrentFaceRuntime(nowMs = Date.now()) {
  ensureSelectedDashboardAgent();
  const selectedAgentId = agentDashboardState.selectedAgentId ?? OPERATOR_DASHBOARD_AGENT_ID;
  return getOrCreateAgentFaceRuntime(selectedAgentId, nowMs);
}

function shouldSuppressAgentTileFocus(agentId, nowMs = Date.now()) {
  const until = agentTileFocusSuppressUntilById.get(agentId) ?? 0;
  if (until <= nowMs) {
    agentTileFocusSuppressUntilById.delete(agentId);
    return false;
  }
  return true;
}

function resetAgentTileDragState() {
  if (agentTileDragState.slotEl) {
    agentTileDragState.slotEl.classList.remove('is-dragging');
  }
  agentTileDragState.pointerId = null;
  agentTileDragState.agentId = null;
  agentTileDragState.slotEl = null;
  agentTileDragState.startX = 0;
  agentTileDragState.startY = 0;
  agentTileDragState.lastX = 0;
  agentTileDragState.lastY = 0;
  agentTileDragState.lastTimeMs = 0;
  agentTileDragState.dragging = false;
}

function beginAgentTileDrag(event, agentId, slotEl) {
  if (!event || !agentId || !slotEl) {
    return;
  }
  if (event.isPrimary === false || event.pointerType !== 'mouse' || event.button !== 0) {
    return;
  }
  const runtime = getOrCreateAgentFaceRuntime(agentId, Date.now());
  setAgentFaceRuntimeDragActive(runtime, true);
  agentTileDragState.pointerId = event.pointerId;
  agentTileDragState.agentId = agentId;
  agentTileDragState.slotEl = slotEl;
  agentTileDragState.startX = event.clientX;
  agentTileDragState.startY = event.clientY;
  agentTileDragState.lastX = event.clientX;
  agentTileDragState.lastY = event.clientY;
  agentTileDragState.lastTimeMs = event.timeStamp;
  agentTileDragState.dragging = false;
  if (typeof slotEl.setPointerCapture === 'function') {
    try {
      slotEl.setPointerCapture(event.pointerId);
    } catch {
      // Ignore capture failures.
    }
  }
}

function updateAgentTileDrag(event) {
  if (!event || agentTileDragState.pointerId === null || event.pointerId !== agentTileDragState.pointerId) {
    return;
  }
  const runtime = getOrCreateAgentFaceRuntime(agentTileDragState.agentId, Date.now());
  const deltaX = event.clientX - agentTileDragState.lastX;
  const deltaY = event.clientY - agentTileDragState.lastY;
  const elapsedMs = Math.max(1, event.timeStamp - agentTileDragState.lastTimeMs);
  const movementFromStartPx = Math.hypot(event.clientX - agentTileDragState.startX, event.clientY - agentTileDragState.startY);
  if (!agentTileDragState.dragging && movementFromStartPx >= AGENT_TILE_DRAG_START_THRESHOLD_PX) {
    agentTileDragState.dragging = true;
    agentTileDragState.slotEl?.classList.add('is-dragging');
  }
  if (agentTileDragState.dragging) {
    const modeHint = deriveFaceControls(runtime.faceState, performance.now()).debug.mode;
    const speedPxPerSecond = Math.hypot(deltaX, deltaY) / (elapsedMs / 1000);
    applyAgentFaceRuntimeDragDelta(runtime, {
      deltaX,
      deltaY,
      speedPxPerSecond,
      modeHint
    });
  }
  agentTileDragState.lastX = event.clientX;
  agentTileDragState.lastY = event.clientY;
  agentTileDragState.lastTimeMs = event.timeStamp;
}

function endAgentTileDrag(event, canceled = false) {
  if (!event || agentTileDragState.pointerId === null || event.pointerId !== agentTileDragState.pointerId) {
    return;
  }
  const runtime = getOrCreateAgentFaceRuntime(agentTileDragState.agentId, Date.now());
  setAgentFaceRuntimeDragActive(runtime, false);
  const wasDragging = agentTileDragState.dragging;
  const agentId = agentTileDragState.agentId;
  const slotEl = agentTileDragState.slotEl;
  if (slotEl && typeof slotEl.releasePointerCapture === 'function') {
    try {
      slotEl.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore release failures.
    }
  }
  resetAgentTileDragState();
  if (canceled || !wasDragging) {
    return;
  }
  agentTileFocusSuppressUntilById.set(agentId, Date.now() + AGENT_TILE_DRAG_FOCUS_SUPPRESS_MS);
  event.preventDefault();
  event.stopPropagation();
}

function bindAgentTileFaceDrag(faceSlot, agentId) {
  if (!faceSlot || !agentId) {
    return;
  }
  faceSlot.dataset.agentId = agentId;
  faceSlot.addEventListener('pointerdown', (event) => {
    beginAgentTileDrag(event, agentId, faceSlot);
  });
  faceSlot.addEventListener('pointermove', (event) => {
    updateAgentTileDrag(event);
  });
  faceSlot.addEventListener('pointerup', (event) => {
    endAgentTileDrag(event, false);
  });
  faceSlot.addEventListener('pointercancel', (event) => {
    endAgentTileDrag(event, true);
  });
}

function hasActiveAgentSpeech() {
  for (const runtime of agentFaceRuntimeById.values()) {
    if (runtime?.speech?.active || (runtime?.speech?.mouthOpen ?? 0) > 0.01) {
      return true;
    }
  }
  return false;
}

function getAgentTransientState(agentId) {
  const existing = agentTransientStateById.get(agentId);
  if (existing) {
    return existing;
  }
  const next = {
    message: null,
    messageExpiresAt: 0,
    speechBubble: null,
    speechBubbleExpiresAt: 0,
    speakingUntil: 0,
    needsAttentionUntil: 0,
    promptIdleUntil: 0,
    errorUntil: 0,
    lastActivityAt: 0,
    lastMirrorActivityAt: 0
  };
  agentTransientStateById.set(agentId, next);
  return next;
}

function pruneAgentTransientState(nowMs = Date.now()) {
  for (const [agentId, state] of agentTransientStateById.entries()) {
    const messageExpired = !state.message || state.messageExpiresAt <= nowMs;
    const speechBubbleExpired = !state.speechBubble || state.speechBubbleExpiresAt <= nowMs;
    const speakingExpired = state.speakingUntil <= nowMs;
    const attentionExpired = state.needsAttentionUntil <= nowMs;
    const promptIdleExpired = state.promptIdleUntil <= nowMs;
    const errorExpired = state.errorUntil <= nowMs;
    const activityExpired =
      !Number.isFinite(state.lastActivityAt) ||
      state.lastActivityAt <= 0 ||
      nowMs - state.lastActivityAt > AGENT_TILE_MIRROR_ACTIVITY_RETENTION_MS;
    const mirrorActivityExpired =
      !Number.isFinite(state.lastMirrorActivityAt) ||
      state.lastMirrorActivityAt <= 0 ||
      nowMs - state.lastMirrorActivityAt > AGENT_TILE_MIRROR_ACTIVITY_RETENTION_MS;
    if (
      messageExpired &&
      speechBubbleExpired &&
      speakingExpired &&
      attentionExpired &&
      promptIdleExpired &&
      errorExpired &&
      activityExpired &&
      mirrorActivityExpired
    ) {
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

function setAgentSpeechBubble(agentId, message, ttlMs = 5_000) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (text === '') {
    return;
  }
  const transient = getAgentTransientState(agentId);
  transient.speechBubble = text;
  transient.speechBubbleExpiresAt = Date.now() + Math.max(1_200, Math.min(8_000, ttlMs));
}

function markAgentSpeaking(agentId, active) {
  const transient = getAgentTransientState(agentId);
  transient.speakingUntil = active ? Date.now() + AGENT_TILE_SPEAKING_TTL_MS : 0;
}

function markAgentNeedsAttention(agentId, active, ttlMs = AGENT_TILE_MESSAGE_TTL_MS) {
  const transient = getAgentTransientState(agentId);
  transient.needsAttentionUntil = active ? Date.now() + Math.max(900, ttlMs) : 0;
  if (active) {
    transient.promptIdleUntil = 0;
  }
}

function markAgentPromptIdle(agentId, active, ttlMs = AGENT_TILE_PROMPT_IDLE_TTL_MS) {
  const transient = getAgentTransientState(agentId);
  transient.promptIdleUntil = active ? Date.now() + Math.max(2_500, ttlMs) : 0;
}

function markAgentActivity(agentId, nowMs = Date.now()) {
  const transient = getAgentTransientState(agentId);
  transient.lastActivityAt = nowMs;
  transient.promptIdleUntil = 0;
}

function markAgentMirrorActivity(agentId, nowMs = Date.now()) {
  const transient = getAgentTransientState(agentId);
  transient.lastActivityAt = nowMs;
  transient.lastMirrorActivityAt = nowMs;
  transient.promptIdleUntil = 0;
}

function markAgentError(agentId, active, ttlMs = AGENT_TILE_MESSAGE_TTL_MS) {
  const transient = getAgentTransientState(agentId);
  transient.errorUntil = active ? Date.now() + Math.max(900, ttlMs) : 0;
  if (active) {
    transient.promptIdleUntil = 0;
  }
}

function resolveAgentTransientToneOptions(agentId, agent, nowMs = Date.now()) {
  const transient = agentTransientStateById.get(agentId) ?? null;
  const speaking = Boolean(transient && transient.speakingUntil > nowMs);
  const transientNeedsAttention = Boolean(transient && transient.needsAttentionUntil > nowMs);
  const explicitPromptIdle = Boolean(transient && transient.promptIdleUntil > nowMs);
  const transientError = Boolean(transient && transient.errorUntil > nowMs);
  const assignmentTone = deriveAssignmentToneOptions(getLatestAgentAssignment(agentId));
  const inboxSummary = isOperatorDashboardAgentId(agentId)
    ? getOwnerInboxOverallSummary()
    : getOwnerInboxAgentSummary(agentId);
  const inboxTone = deriveOwnerInboxToneOptions(inboxSummary);
  const promptNeedsAttention =
    agentId === agentDashboardState.selectedAgentId &&
    operatorActivePrompt &&
    (operatorActivePrompt.state === 'awaiting_input' || operatorActivePrompt.state === 'awaiting_approval');
  const needsAttention = transientNeedsAttention || promptNeedsAttention || inboxTone.needsAttention || assignmentTone.needsAttention;
  const error = transientError || inboxTone.error;
  const lastActivityAt = resolveAgentQuietActivityAt(agent, transient);
  const quietPromptIdle = shouldUseAgentQuietPromptIdle({
    agentStatus: agent?.status ?? 'active',
    nowMs,
    lastActivityAt,
    quietMs: AGENT_TILE_PROMPT_IDLE_QUIET_MS,
    speaking,
    needsAttention,
    promptNeedsAttention: promptNeedsAttention || inboxTone.needsAttention,
    error
  });
  return {
    speaking,
    needsAttention,
    promptIdle: (explicitPromptIdle || quietPromptIdle) && !assignmentTone.suppressPromptIdle && !speaking && !needsAttention && !error,
    error
  };
}

function trackAgentTileFromPayload(payload) {
  const agentId = resolvePayloadAgentIdForFace(payload);
  if (!agentId) {
    return;
  }
  if (shouldCountPayloadAsAgentActivity(payload)) {
    markAgentActivity(agentId);
  }
  const update = deriveAgentTransientUpdate(payload);
  if (!update) {
    return;
  }
  if (typeof update.message === 'string' && update.message.trim() !== '') {
    setAgentTransientMessage(agentId, update.message);
  }
  if (typeof update.speechBubble === 'string' && update.speechBubble.trim() !== '') {
    setAgentSpeechBubble(agentId, update.speechBubble, update.speechBubbleTtlMs);
  }
  if (typeof update.speaking === 'boolean') {
    markAgentSpeaking(agentId, update.speaking);
  }
  if (typeof update.needsAttention === 'boolean') {
    markAgentNeedsAttention(agentId, update.needsAttention, update.needsAttentionTtlMs);
  }
  if (typeof update.attention === 'boolean') {
    markAgentNeedsAttention(agentId, update.attention, update.needsAttentionTtlMs);
  }
  if (typeof update.promptIdle === 'boolean') {
    markAgentPromptIdle(agentId, update.promptIdle);
  }
  if (typeof update.error === 'boolean') {
    markAgentError(agentId, update.error);
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
  return normalizeDashboardStatePayload(payload.state);
}

async function readOwnerInboxState(streamId = null) {
  const query = new URLSearchParams({
    owner_agent_id: OPERATOR_DASHBOARD_AGENT_ID
  });
  if (typeof streamId === 'string' && streamId.trim() !== '') {
    query.set('stream_id', streamId.trim());
  }
  const response = await fetch(`/api/owner-inbox/list?${query.toString()}`, {
    method: 'GET',
    cache: 'no-store'
  });
  if (!response.ok) {
    throw new Error(`owner inbox request failed (${response.status})`);
  }
  const payload = await response.json();
  if (!payload || payload.ok !== true || !payload.state || typeof payload.state !== 'object') {
    throw new Error('owner inbox response is invalid');
  }
  return normalizeOwnerInboxViewState(payload.state);
}

async function readAgentAssignmentState(streamId = null) {
  const query = new URLSearchParams();
  if (typeof streamId === 'string' && streamId.trim() !== '') {
    query.set('stream_id', streamId.trim());
  }
  const response = await fetch(`/api/agent-assignments/list?${query.toString()}`, {
    method: 'GET',
    cache: 'no-store'
  });
  if (!response.ok) {
    throw new Error(`agent assignment request failed (${response.status})`);
  }
  const payload = await response.json();
  if (!payload || payload.ok !== true || !payload.state || typeof payload.state !== 'object') {
    throw new Error('agent assignment response is invalid');
  }
  return normalizeAgentAssignmentViewState(payload.state);
}

function syncAgentActivityFromDashboardState(previousAgents, nextAgents, nowMs = Date.now()) {
  const previousById = new Map((Array.isArray(previousAgents) ? previousAgents : []).map((agent) => [agent.id, agent]));
  for (const agent of Array.isArray(nextAgents) ? nextAgents : []) {
    const transient = agentTransientStateById.get(agent.id) ?? null;
    const hasTrackedActivity = Boolean(transient && Number.isFinite(transient.lastActivityAt) && transient.lastActivityAt > 0);
    if (!hasTrackedActivity || shouldRefreshAgentActivityFromState(previousById.get(agent.id) ?? null, agent)) {
      const stateActivityAt = Number.isFinite(agent.updated_at) && agent.updated_at > 0 ? agent.updated_at : nowMs;
      markAgentActivity(agent.id, stateActivityAt);
    }
  }
}

function updateAgentDashboardMode() {
  agentDashboardState.mode = deriveDashboardMode(agentDashboardState.agents, {
    isMobileUi: operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE,
    additionalActiveCount: getOperatorDashboardAdditionalCount()
  });
  updateOperatorCurrentAgentBar();
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

async function createManagedAgent(options = {}) {
  const payload = {
    create_worktree: true,
    create_tmux: true,
    ...options
  };
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
  return json;
}

async function focusDashboardAgent(agentId, options = {}) {
  const closePicker = typeof options.closePicker === 'boolean'
    ? options.closePicker
    : shouldCloseOperatorPickerAfterFocus();
  if (isOperatorDashboardAgentId(agentId)) {
    armPendingOperatorFocus(OPERATOR_DASHBOARD_AGENT_ID, { closePicker });
    setAgentDashboardStatus('operator: switching...', 'default');
    renderAgentDashboard();
    updateOperatorUi();
    try {
      const ok = await requestOperatorRecoverDefault();
      if (!ok) {
        throw new Error('focus failed (recover request failed)');
      }
      return true;
    } catch (error) {
      if (operatorFocusPending?.agentId === OPERATOR_DASHBOARD_AGENT_ID) {
        clearPendingOperatorFocus();
      }
      throw error;
    }
  }

  const agent = agentDashboardState.agents.find((item) => item.id === agentId);
  if (!agent) {
    throw new Error(`focus failed (unknown agent: ${agentId})`);
  }
  armPendingOperatorFocus(agent.id, { closePicker });
  setAgentDashboardStatus(`${agent.id}: switching...`, 'default');
  renderAgentDashboard();
  updateOperatorUi();
  try {
    const payload = await runAgentDashboardAction(agent, 'focus');
    const nextAgents = resolveAgentsFromActionResult(agentDashboardState.agents, payload?.result);
    agentDashboardState.agents = nextAgents;
    renderAgentDashboard();
    updateOperatorUi();
    await refreshAgentDashboardState({ silentStatus: true });
    return true;
  } catch (error) {
    if (operatorFocusPending?.agentId === agent.id) {
      clearPendingOperatorFocus();
    }
    throw error;
  }
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
      const nextAgents = resolveAgentsFromActionResult(agentDashboardState.agents, payload?.result);
      if (nextAgents.length !== agentDashboardState.agents.length || nextAgents !== agentDashboardState.agents) {
        agentDashboardState.agents = nextAgents;
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
  lastAgentDashboardRerenderAt = Date.now();
  const isMobileUi = operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE;
  const showDashboard = !isMobileUi && operatorPanelEnabled && agentDashboardSurfaceOpen;
  document.body.classList.toggle('agent-dashboard-open', showDashboard);
  agentDashboardEl.classList.toggle('hidden', !showDashboard);
  if (!showDashboard) {
    agentDashboardFaceDescriptors = [];
    renderOperatorMobileAgentList();
    return;
  }

  pruneAgentTransientState(Date.now());
  ensureSelectedDashboardAgent();
  syncKnownAgentFaceRuntimes(Date.now());
  agentDashboardAddFormEl.classList.add('hidden');
  agentDashboardAddFormOpen = false;

  const visibleCount = getDashboardVisibleCount();
  const gridColumns = computeDesktopAgentGridColumns(visibleCount);
  agentDashboardEl.style.setProperty('--agent-dashboard-width', resolveDesktopDashboardWidth(gridColumns));
  agentDashboardGridEl.style.setProperty('--agent-grid-columns', String(gridColumns));
  agentDashboardGridEl.style.setProperty('--agent-face-slot-aspect', resolveDesktopFaceSlotAspect(gridColumns));
  agentDashboardGridEl.dataset.columns = String(gridColumns);
  agentDashboardGridEl.dataset.count = String(visibleCount);

  agentDashboardGridEl.innerHTML = '';
  agentDashboardFaceDescriptors = [];
  const operatorTile = document.createElement('article');
  operatorTile.className = 'agent-tile';
  const operatorToneOptions = resolveAgentTransientToneOptions(OPERATOR_DASHBOARD_AGENT_ID, null);
  const operatorInboxSummary = getOwnerInboxOverallSummary();
  operatorTile.dataset.tone = deriveAgentTileTone(
    { status: operatorRecoverPending ? 'active' : 'active' },
    operatorToneOptions
  );
  if (agentDashboardState.selectedAgentId === OPERATOR_DASHBOARD_AGENT_ID) {
    operatorTile.classList.add('is-selected');
  }
  const operatorRuntime = getOrCreateAgentFaceRuntime(OPERATOR_DASHBOARD_AGENT_ID);
  operatorTile.style.setProperty('--agent-accent', faceAccentCss(operatorRuntime.identity));

  const operatorFocusButton = document.createElement('button');
  operatorFocusButton.type = 'button';
  operatorFocusButton.className = 'agent-tile-focus';
  operatorFocusButton.setAttribute('aria-label', 'Focus operator');
  operatorFocusButton.addEventListener('click', (event) => {
    if (shouldSuppressAgentTileFocus(OPERATOR_DASHBOARD_AGENT_ID)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    void focusDashboardAgent(OPERATOR_DASHBOARD_AGENT_ID).catch((error) => {
      setAgentDashboardStatus(error.message, 'warn');
      renderAgentDashboard();
    });
  });

  const operatorHeader = document.createElement('header');
  operatorHeader.className = 'agent-tile-header';
  const operatorFaceSlot = document.createElement('div');
  operatorFaceSlot.className = 'agent-tile-face-slot';
  operatorFaceSlot.setAttribute('aria-hidden', 'true');
  bindAgentTileFaceDrag(operatorFaceSlot, OPERATOR_DASHBOARD_AGENT_ID);
  const operatorIdEl = document.createElement('span');
  operatorIdEl.className = 'agent-tile-id';
  operatorIdEl.textContent = OPERATOR_DASHBOARD_AGENT_LABEL;
  const operatorStatusEl = document.createElement('span');
  operatorStatusEl.className = 'agent-tile-status';
  operatorStatusEl.textContent = 'active';
  operatorHeader.append(operatorIdEl, operatorStatusEl);

  const operatorSessionEl = document.createElement('div');
  operatorSessionEl.className = 'agent-tile-session';
  operatorSessionEl.textContent = `session: ${resolveOperatorSessionId()}`;

  const operatorMessageEl = document.createElement('p');
  operatorMessageEl.className = 'agent-tile-message';
  operatorMessageEl.textContent =
    summarizeOwnerInboxSummary(operatorInboxSummary) ??
    (operatorRecoverPending ? 'recovering operator...' : 'primary operator');

  const operatorTransient = agentTransientStateById.get(OPERATOR_DASHBOARD_AGENT_ID) ?? null;
  const operatorSpeechBubble =
    operatorTransient && operatorTransient.speechBubbleExpiresAt > Date.now() ? operatorTransient.speechBubble : null;
  if (operatorSpeechBubble) {
    operatorFaceSlot.appendChild(createAgentTileSpeechBubble(operatorSpeechBubble));
  }

  operatorFocusButton.append(operatorFaceSlot, operatorHeader, operatorSessionEl, operatorMessageEl);
  operatorTile.append(operatorFocusButton);
  agentDashboardGridEl.appendChild(operatorTile);
  agentDashboardFaceDescriptors.push({
    key: OPERATOR_DASHBOARD_AGENT_ID,
    slotEl: operatorFaceSlot,
    tone: operatorTile.dataset.tone,
    appearance: operatorRuntime.appearance,
    faceState: operatorRuntime.faceState,
    speech: operatorRuntime.speech,
    motion: operatorRuntime.motion,
    drag: operatorRuntime.drag
  });

  for (const agent of agentDashboardState.agents) {
    const nowMs = Date.now();
    const transient = agentTransientStateById.get(agent.id) ?? null;
    const toneOptions = resolveAgentTransientToneOptions(agent.id, agent, nowMs);
    const transientMessage = transient && transient.messageExpiresAt > nowMs ? transient.message : null;
    const ownerInboxSummary = getOwnerInboxAgentSummary(agent.id);
    const ownerInboxMessage = summarizeOwnerInboxSummary(ownerInboxSummary);
    const operationalState = deriveAgentOperationalState(agent, {
      ...toneOptions,
      nowMs,
      lastActivityAt: resolveAgentQuietActivityAt(agent, transient),
      ownerInboxSummary,
      assignment: getLatestAgentAssignment(agent.id)
    });
    const runtime = getOrCreateAgentFaceRuntime(agent.id, nowMs);
    const tile = document.createElement('article');
    tile.className = 'agent-tile';
    if (agent.id === agentDashboardState.selectedAgentId) {
      tile.classList.add('is-selected');
    }
    tile.dataset.tone = deriveAgentTileTone(agent, toneOptions);
    tile.style.setProperty('--agent-accent', faceAccentCss(runtime.identity));

    const focusButton = document.createElement('button');
    focusButton.type = 'button';
    focusButton.className = 'agent-tile-focus';
    focusButton.setAttribute('aria-label', `Focus ${agent.id}`);
    focusButton.addEventListener('click', (event) => {
      if (shouldSuppressAgentTileFocus(agent.id)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      void focusDashboardAgent(agent.id).catch((error) => {
        setAgentDashboardStatus(error.message, 'warn');
        renderAgentDashboard();
      });
    });

    const header = document.createElement('header');
    header.className = 'agent-tile-header';
    const faceSlot = document.createElement('div');
    faceSlot.className = 'agent-tile-face-slot';
    faceSlot.setAttribute('aria-hidden', 'true');
    bindAgentTileFaceDrag(faceSlot, agent.id);
    const idEl = document.createElement('span');
    idEl.className = 'agent-tile-id';
    idEl.textContent = agent.id;
    const statusEl = document.createElement('span');
    statusEl.className = 'agent-tile-status';
    statusEl.textContent = summarizeAgentOperationalState(operationalState);
    header.append(idEl, statusEl);

    const sessionEl = document.createElement('div');
    sessionEl.className = 'agent-tile-session';
    sessionEl.textContent = `session: ${agent.session_id ?? '-'}`;

    const messageEl = document.createElement('p');
    messageEl.className = 'agent-tile-message';
    messageEl.textContent = summarizeAgentTileMessage(agent, transientMessage, ownerInboxMessage, operationalState);

    const speechBubble = transient && transient.speechBubbleExpiresAt > nowMs ? transient.speechBubble : null;
    if (speechBubble) {
      faceSlot.appendChild(createAgentTileSpeechBubble(speechBubble));
    }

    const actions = document.createElement('div');
    actions.className = 'agent-tile-actions';
    for (const item of listAgentLifecycleActions(agent)) {
      const button = createDashboardActionButton(agent, item.label, item.action, () => {});
      bindAgentActionButton(button, agent, item.action, { stopPropagation: true });
      actions.appendChild(button);
    }

    focusButton.append(faceSlot, header, sessionEl, messageEl);
    tile.append(focusButton, actions);
    agentDashboardGridEl.appendChild(tile);
    agentDashboardFaceDescriptors.push({
      key: agent.id,
      slotEl: faceSlot,
      tone: tile.dataset.tone,
      appearance: runtime.appearance,
      faceState: runtime.faceState,
      speech: runtime.speech,
      motion: runtime.motion,
      drag: runtime.drag
    });
  }
  renderOperatorMobileAgentList();
}

function renderOperatorMobileAgentList() {
  if (!operatorAgentListEl || !operatorAgentListItemsEl) {
    return;
  }
  if (operatorAgentListAddButtonEl) {
    operatorAgentListAddButtonEl.disabled = agentDashboardAddPending;
  }
  const shouldShow = shouldShowMobileAgentList(agentDashboardState.agents, {
    isMobileUi: operatorEffectiveUiMode === OPERATOR_UI_MODE_MOBILE,
    operatorPanelEnabled,
    pickerOpen: operatorAgentPickerOpen
  });
  operatorAgentListEl.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) {
    return;
  }

  pruneAgentTransientState(Date.now());
  operatorAgentListItemsEl.innerHTML = '';
  const operatorItem = document.createElement('article');
  operatorItem.className = 'operator-agent-item';
  operatorItem.dataset.tone = deriveAgentTileTone(
    { status: operatorRecoverPending ? 'active' : 'active' },
    resolveAgentTransientToneOptions(OPERATOR_DASHBOARD_AGENT_ID, null, Date.now())
  );
  if (agentDashboardState.selectedAgentId === OPERATOR_DASHBOARD_AGENT_ID) {
    operatorItem.classList.add('is-selected');
    operatorItem.style.borderColor = 'rgba(111, 243, 184, 0.65)';
  }
  const operatorItemFocus = document.createElement('button');
  operatorItemFocus.type = 'button';
  operatorItemFocus.className = 'operator-agent-item-focus';
  operatorItemFocus.setAttribute('aria-label', 'Focus operator');
  operatorItemFocus.addEventListener('click', () => {
    void focusDashboardAgent(OPERATOR_DASHBOARD_AGENT_ID).catch((error) => {
      setAgentDashboardStatus(error.message, 'warn');
      renderOperatorMobileAgentList();
    });
  });

  const operatorHeader = document.createElement('header');
  operatorHeader.className = 'operator-agent-item-header';
  const operatorIdEl = document.createElement('span');
  operatorIdEl.className = 'operator-agent-item-id';
  operatorIdEl.textContent = OPERATOR_DASHBOARD_AGENT_LABEL;
  const operatorStatusEl = document.createElement('span');
  operatorStatusEl.className = 'operator-agent-item-status';
  operatorStatusEl.textContent = 'active';
  operatorHeader.append(operatorIdEl, operatorStatusEl);

  const operatorMessageEl = document.createElement('p');
  operatorMessageEl.className = 'operator-agent-item-message';
  operatorMessageEl.textContent =
    summarizeOwnerInboxSummary(getOwnerInboxOverallSummary()) ??
    (operatorRecoverPending ? 'recovering operator...' : 'primary operator');

  operatorItemFocus.append(operatorHeader, operatorMessageEl);
  operatorItem.append(operatorItemFocus);
  operatorAgentListItemsEl.appendChild(operatorItem);

  for (const agent of agentDashboardState.agents) {
    const transient = agentTransientStateById.get(agent.id) ?? null;
    const nowMs = Date.now();
    const ownerInboxSummary = getOwnerInboxAgentSummary(agent.id);
    const ownerInboxMessage = summarizeOwnerInboxSummary(ownerInboxSummary);
    const toneOptions = resolveAgentTransientToneOptions(agent.id, agent, nowMs);
    const operationalState = deriveAgentOperationalState(agent, {
      ...toneOptions,
      nowMs,
      lastActivityAt: resolveAgentQuietActivityAt(agent, transient),
      ownerInboxSummary,
      assignment: getLatestAgentAssignment(agent.id)
    });
    const message = summarizeAgentTileMessage(
      agent,
      transient && transient.messageExpiresAt > nowMs ? transient.message : null,
      ownerInboxMessage,
      operationalState
    );
    const item = document.createElement('article');
    item.className = 'operator-agent-item';
    item.dataset.tone = deriveAgentTileTone(agent, toneOptions);
    if (agent.id === agentDashboardState.selectedAgentId) {
      item.classList.add('is-selected');
      item.style.borderColor = 'rgba(111, 243, 184, 0.65)';
    }
    const itemFocus = document.createElement('button');
    itemFocus.type = 'button';
    itemFocus.className = 'operator-agent-item-focus';
    itemFocus.setAttribute('aria-label', `Focus ${agent.id}`);
    itemFocus.addEventListener('click', () => {
      void focusDashboardAgent(agent.id).catch((error) => {
        setAgentDashboardStatus(error.message, 'warn');
        renderOperatorMobileAgentList();
      });
    });

    const header = document.createElement('header');
    header.className = 'operator-agent-item-header';
    const idEl = document.createElement('span');
    idEl.className = 'operator-agent-item-id';
    idEl.textContent = agent.id;
    const statusEl = document.createElement('span');
    statusEl.className = 'operator-agent-item-status';
    statusEl.textContent = summarizeAgentOperationalState(operationalState);
    header.append(idEl, statusEl);

    const messageEl = document.createElement('p');
    messageEl.className = 'operator-agent-item-message';
    messageEl.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'operator-agent-item-actions';
    for (const actionItem of listAgentLifecycleActions(agent)) {
      const button = createDashboardActionButton(agent, actionItem.label, actionItem.action, () => {});
      bindAgentActionButton(button, agent, actionItem.action, { stopPropagation: true });
      actions.appendChild(button);
    }
    itemFocus.append(header, messageEl);
    item.append(itemFocus, actions);
    operatorAgentListItemsEl.appendChild(item);
  }
}

async function refreshAgentDashboardState(options = {}) {
  if (agentDashboardLoadInFlight) {
    return agentDashboardLoadInFlight;
  }
  const silentStatus = options.silentStatus === true;
  agentDashboardLoadInFlight = (async () => {
    const previousAgents = agentDashboardState.agents;
    const agentsPromise = readAgentDashboardState();
    const nextDashboardState = await agentsPromise;
    const ownerInboxPromise = readOwnerInboxState(nextDashboardState.activeStreamId).catch((error) => {
      console.warn(`[face-app] owner inbox refresh failed: ${error.message}`);
      return null;
    });
    const assignmentPromise = readAgentAssignmentState(nextDashboardState.activeStreamId).catch((error) => {
      console.warn(`[face-app] agent assignment refresh failed: ${error.message}`);
      return null;
    });
    const [nextOwnerInboxState, nextAssignmentState] = await Promise.all([ownerInboxPromise, assignmentPromise]);
    syncAgentActivityFromDashboardState(previousAgents, nextDashboardState.agents, Date.now());
    agentDashboardState.agents = nextDashboardState.agents;
    agentDashboardState.activeStreamId = nextDashboardState.activeStreamId;
    agentDashboardState.activeTargetRepoRoot = nextDashboardState.activeTargetRepoRoot;
    agentDashboardState.hiddenAgentCount = nextDashboardState.hiddenAgentCount;
    ownerInboxViewState = nextOwnerInboxState ?? createEmptyOwnerInboxViewState();
    agentAssignmentViewState = nextAssignmentState ?? createEmptyAgentAssignmentViewState();
    agentDashboardState.loaded = true;
    ensureSelectedDashboardAgent();
    renderAgentDashboard();
    updateOperatorUi();
    if (!silentStatus) {
      const unresolvedCount = Number.isFinite(ownerInboxViewState?.summary?.unresolved_count)
        ? Math.max(0, Math.floor(ownerInboxViewState.summary.unresolved_count))
        : 0;
      const countText = formatDashboardVisibleCount();
      setAgentDashboardStatus(
        unresolvedCount > 0
          ? `${countText} · inbox ${unresolvedCount}`
          : countText,
        unresolvedCount > 0 ? 'warn' : 'ok'
      );
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

  if (agentDashboardCloseButtonEl) {
    agentDashboardCloseButtonEl.addEventListener('click', () => {
      closeDesktopAgentDashboardSurface();
      renderAgentDashboard();
      updateOperatorUi();
    });
  }
  if (agentDashboardAddToggleButtonEl) {
    agentDashboardAddToggleButtonEl.addEventListener('click', async () => {
      if (agentDashboardAddPending) {
        return;
      }
      agentDashboardAddPending = true;
      renderAgentDashboard();
      try {
        const json = await createManagedAgent();
        agentDashboardState.agents = resolveAgentsFromActionResult(agentDashboardState.agents, json?.result);
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
  if (operatorCurrentAgentButtonEl) {
    operatorCurrentAgentButtonEl.addEventListener('click', () => {
      toggleOperatorAgentPicker();
    });
  }
  if (operatorAgentListAddButtonEl) {
    operatorAgentListAddButtonEl.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (agentDashboardAddPending) {
        return;
      }
      agentDashboardAddPending = true;
      renderOperatorMobileAgentList();
      try {
        const json = await createManagedAgent();
        agentDashboardState.agents = resolveAgentsFromActionResult(agentDashboardState.agents, json?.result);
        setAgentDashboardStatus('agent created', 'ok');
        await refreshAgentDashboardState({ silentStatus: true });
      } catch (error) {
        setAgentDashboardStatus(error.message, 'warn');
      } finally {
        agentDashboardAddPending = false;
        renderOperatorMobileAgentList();
      }
    });
  }
}

function installOperatorStateRefreshHooks() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshAgentDashboardSoon();
    }
  });
  window.addEventListener('focus', () => {
    refreshAgentDashboardSoon();
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

function rememberOperatorBridgeSessionId(payload) {
  const sessionId = resolvePayloadSessionId(payload);
  if (sessionId !== '-') {
    operatorBridgeSessionId = sessionId;
  }
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

function normalizeOperatorKeyboardPttTriggerKey(event) {
  if (!event || typeof event !== 'object') {
    return '';
  }
  if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') {
    return 'Space';
  }
  return typeof event.key === 'string' ? event.key : '';
}

function resolveOperatorKeyboardPttDelayMs(event) {
  const triggerKey = normalizeOperatorKeyboardPttTriggerKey(event);
  if (triggerKey === 'Control' || triggerKey === 'Alt') {
    return OPERATOR_KEYBOARD_MODIFIER_PTT_DELAY_MS;
  }
  if (triggerKey === 'Space') {
    return OPERATOR_KEYBOARD_SPACE_PTT_DELAY_MS;
  }
  return 0;
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
    if (operatorCurrentAgentButtonEl) {
      operatorCurrentAgentButtonEl.classList.add('hidden');
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
  if (operatorCurrentAgentButtonEl) {
    operatorCurrentAgentButtonEl.classList.toggle('hidden', false);
  }
  if (operatorMirrorEl) {
    operatorMirrorEl.classList.toggle('hidden', false);
  }
  if (operatorMirrorToggleEl) {
    operatorMirrorToggleEl.classList.add('hidden');
  }
  const showKeyboardHelpToggle = shouldShowOperatorKeyboardHelpToggle();
  if (operatorHelpToggleEl) {
    operatorHelpToggleEl.classList.toggle('hidden', !showKeyboardHelpToggle);
    operatorHelpToggleEl.setAttribute('aria-expanded', showKeyboardHelpToggle && operatorKeyboardHelpOpen ? 'true' : 'false');
  }
  if (operatorKeyboardHelpEl) {
    operatorKeyboardHelpEl.hidden = !showKeyboardHelpToggle || !operatorKeyboardHelpOpen;
  }
  updateOperatorCurrentAgentBar();
  renderOperatorMobileAgentList();

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
  rememberOperatorBridgeSessionId(payload);

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
  rememberOperatorBridgeSessionId(payload);

  operatorRecoverPending = false;
  if (operatorRecoverPendingTimer !== null) {
    window.clearTimeout(operatorRecoverPendingTimer);
    operatorRecoverPendingTimer = null;
  }
  if (payload.ok === true) {
    handleCompletedOperatorFocusResult({
      pane: payload.pane,
      agentId: OPERATOR_DASHBOARD_AGENT_ID,
      ackText: 'ack: recovered',
      statusPrefix: 'recovered'
    });
    return;
  }

  const reason = typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : 'recover_failed';
  handleFailedOperatorFocusResult(reason, {
    ackPrefix: 'ack: recover failed',
    statusPrefix: 'recover failed',
    pendingAgentId: OPERATOR_DASHBOARD_AGENT_ID
  });
}

function handleOperatorTerminalSnapshot(payload) {
  if (!payload || !Array.isArray(payload.lines)) {
    return;
  }
  rememberOperatorBridgeSessionId(payload);
  operatorMirrorPaneId = typeof payload.pane === 'string' && payload.pane.trim() !== '' ? payload.pane.trim() : null;
  const agentId = resolveAgentIdForPane(operatorMirrorPaneId, agentDashboardState.agents, {
    operatorAgentId: OPERATOR_DASHBOARD_AGENT_ID
  });
  const nowMs = Date.now();
  const suppressMirrorActivity = Boolean(
    operatorMirrorActivitySuppression &&
      operatorMirrorPaneId &&
      operatorMirrorActivitySuppression.paneId === operatorMirrorPaneId &&
      operatorMirrorActivitySuppression.expiresAt > nowMs
  );
  if (operatorMirrorActivitySuppression && (!suppressMirrorActivity || operatorMirrorActivitySuppression.expiresAt <= nowMs)) {
    operatorMirrorActivitySuppression = null;
  }
  if (agentId && !suppressMirrorActivity) {
    markAgentMirrorActivity(agentId);
  }
  if (suppressMirrorActivity) {
    operatorMirrorActivitySuppression = null;
  }
  syncSelectedDashboardAgentToMirrorPane();
  operatorTerminalSnapshotLines = payload.lines.map((line) => String(line));
  renderOperatorTerminalSnapshot();
  updateOperatorCurrentAgentBar();
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
    return;
  }

  if (phase === 'play_start') {
    setTtsStatus('speaking', 'ok');
    setTtsPhase(phase, 'ok');
    return;
  }

  if (phase === 'play_stop') {
    if (reason === 'interrupted') {
      stopActiveBrowserAudio(payload.generation, sessionId);
    }
    setTtsStatus('ready', 'ok');
    setTtsPhase(phase, 'default');
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
    if (!hasActiveAgentSpeech()) {
      setTtsStatus('ready', 'default');
    }
    return;
  }

  if (phase === 'error') {
    stopActiveBrowserAudio(payload.generation, sessionId);
    setTtsStatus('error', 'warn');
    setTtsPhase(`error:${payload.reason ?? '-'}`, 'warn');
    return;
  }

  setTtsPhase(phase, 'default');
}

function handleTtsMouth(payload) {
  void payload;
}

function handleSayResult(payload) {
  const spoken = payload.spoken === true;
  if (!spoken) {
    setTtsPhase(`dropped:${payload.reason ?? '-'}`, 'warn');
    if (!hasActiveAgentSpeech()) {
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

  appendEvent(payload);
  trackAgentTileFromPayload(payload);
  applyPayloadToFaceRuntimeStore(payload, Date.now());

  if (payload.type === 'say' && typeof payload.text === 'string' && payload.text.trim() !== '') {
    if (shouldDisplaySay(payload)) {
      showUtterance(payload.text, payload.ttl_ms);
    }
  } else if (payload.type === 'say_result') {
    handleSayResult(payload);
  } else if (payload.type === 'operator_prompt') {
    rememberOperatorBridgeSessionId(payload);
    handleOperatorPrompt(payload);
  } else if (payload.type === 'operator_ack') {
    rememberOperatorBridgeSessionId(payload);
    handleOperatorAck(payload);
  } else if (payload.type === 'operator_state') {
    handleOperatorStatePayload(payload);
  } else if (payload.type === 'operator_recover_result') {
    handleOperatorRecoverResult(payload);
  } else if (payload.type === 'operator_set_pane_result') {
    rememberOperatorBridgeSessionId(payload);
    if (payload.ok === true) {
      handleCompletedOperatorFocusResult({
        pane: payload.pane,
        agentId: typeof payload.agent_id === 'string' ? payload.agent_id : null,
        ackText: 'ack: pane switched',
        statusPrefix: 'pane switched'
      });
    } else {
      handleFailedOperatorFocusResult(payload.reason, {
        ackPrefix: 'ack: pane switch failed',
        statusPrefix: 'pane switch failed'
      });
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
    const triggerKey = normalizeOperatorKeyboardPttTriggerKey(event);
    if (triggerKey === '') {
      return;
    }
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

    const delayMs = resolveOperatorKeyboardPttDelayMs(event);
    if (delayMs > 0) {
      operatorMicState.keyboardPendingKey = triggerKey;
      operatorMicState.keyboardPendingTimer = window.setTimeout(async () => {
        operatorMicState.keyboardPendingTimer = null;
        if (operatorMicState.keyboardPendingKey !== triggerKey) {
          return;
        }
        operatorMicState.keyboardPendingKey = null;
        if (operatorMicState.pointerArmed || operatorMicState.keyboardArmedKey !== null || operatorMicState.recording) {
          return;
        }
        if (document.activeElement === operatorTextInputEl) {
          operatorTextInputEl.blur();
        }
        setOperatorStatusLine(`keyboard PTT (${language})...`, 'default');
        operatorMicState.keyboardArmedKey = triggerKey;
        const started = await startOperatorRecording(language);
        if (!started) {
          if (operatorMicState.keyboardArmedKey === triggerKey) {
            operatorMicState.keyboardArmedKey = null;
          }
          return;
        }
        if (operatorMicState.keyboardArmedKey !== triggerKey) {
          await stopOperatorRecordingAndTranscribe();
        }
      }, delayMs);
      return;
    }

    event.preventDefault();
    if (document.activeElement === operatorTextInputEl) {
      operatorTextInputEl.blur();
    }
    setOperatorStatusLine(`keyboard PTT (${language})...`, 'default');
    operatorMicState.keyboardArmedKey = triggerKey;
    const started = await startOperatorRecording(language);
    if (!started) {
      if (operatorMicState.keyboardArmedKey === triggerKey) {
        operatorMicState.keyboardArmedKey = null;
      }
      return;
    }
    if (operatorMicState.keyboardArmedKey !== triggerKey) {
      await stopOperatorRecordingAndTranscribe();
    }
  }, true);

  window.addEventListener('keyup', async (event) => {
    const triggerKey = normalizeOperatorKeyboardPttTriggerKey(event);
    if (operatorMicState.keyboardPendingKey && triggerKey === operatorMicState.keyboardPendingKey) {
      event.preventDefault();
      cancelPendingOperatorKeyboardPttStart();
      return;
    }
    if (!operatorMicState.keyboardArmedKey || triggerKey !== operatorMicState.keyboardArmedKey) {
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

  const wallClockMs = Date.now();
  syncKnownAgentFaceRuntimes(wallClockMs);
  for (const runtime of agentFaceRuntimeById.values()) {
    stepAgentFaceRuntime(runtime, dtSeconds, wallClockMs);
  }

  const currentRuntime = getCurrentFaceRuntime(wallClockMs);
  faceState = currentRuntime.faceState;
  applyAppearanceToRig(rig, currentRuntime.appearance);

  if (typeof faceState.session_id === 'string' && faceState.session_id.trim() !== '') {
    sessionIdEl.textContent = faceState.session_id;
  } else {
    const currentAgent = getCurrentDashboardAgent();
    sessionIdEl.textContent = currentAgent?.session_id ?? '-';
  }

  targetControls = deriveFaceControls(faceState, nowMs + (currentRuntime.motion?.timeOffsetMs ?? 0));
  decayDragOffsets(dtSeconds);

  if (dragState.intensity > 0.01) {
    currentRuntime.faceState = applyDragEmotionBias(
      currentRuntime.faceState,
      {
        intensity: dragState.intensity,
        modeHint: dragState.modeHint
      },
      dtSeconds,
      wallClockMs
    );
    faceState = currentRuntime.faceState;
    targetControls = deriveFaceControls(faceState, nowMs + (currentRuntime.motion?.timeOffsetMs ?? 0));
  }

  applyDragOffsetsToControls(targetControls);
  applyAgentFaceRuntimeDragToControls(currentRuntime, targetControls);
  targetControls = applyIdleMotionToControls(targetControls, nowMs, currentRuntime.motion, {
    strength: operatorEffectiveUiMode === OPERATOR_UI_MODE_PC ? 0.8 : 1
  });

  const speechBlendOpen = clamp(currentRuntime.speech.mouthOpen, 0, 1);
  if (currentRuntime.speech.active || speechBlendOpen > 0.01) {
    targetControls.mouth.open = clamp(Math.max(targetControls.mouth.open * 0.46, speechBlendOpen * 1.08), 0, 1);
    targetControls.mouth.wide = clamp(Math.max(targetControls.mouth.wide, 0.44 + speechBlendOpen * 0.58), 0, 1);
  }

  blendControls(renderedControls, targetControls, Math.min(1, dtSeconds * 11.8));
  applyControlsToRig(rig, renderedControls);

  if (utteranceExpiresAt > 0 && Date.now() >= utteranceExpiresAt) {
    utteranceEl.classList.add('hidden');
    utteranceExpiresAt = 0;
  }

  if (wallClockMs - lastAgentDashboardRerenderAt >= AGENT_DASHBOARD_RERENDER_INTERVAL_MS) {
    renderAgentDashboard();
  }

  updateHud();
  if (operatorEffectiveUiMode !== OPERATOR_UI_MODE_PC) {
    renderer.render(scene, camera);
  } else {
    renderer.clear();
  }
  if (agentDashboardFaceRenderer && agentDashboardSurfaceOpen && operatorEffectiveUiMode === OPERATOR_UI_MODE_PC) {
    agentDashboardFaceRenderer.render(agentDashboardFaceDescriptors, {
      containerEl: agentDashboardEl,
      nowMs
    });
  } else if (agentDashboardFaceRenderer) {
    agentDashboardFaceRenderer.render([], {
      containerEl: agentDashboardEl,
      nowMs
    });
  }
}

let resizeObserver;

function markOperatorUiBootReady() {
  document.body.classList.remove('boot-pending');
}

function resetStartupOperatorFocus() {
  operatorMirrorPaneId = null;
  clearPendingOperatorFocus();
  if (operatorPanelEnabled) {
    agentDashboardState.selectedAgentId = OPERATOR_DASHBOARD_AGENT_ID;
  }
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
  installOperatorStateRefreshHooks();
  await refreshAgentDashboardState({ silentStatus: false });
  if (operatorPanelEnabled) {
    resetStartupOperatorFocus();
    renderAgentDashboard();
    updateOperatorUi();
    await requestOperatorRecoverDefault();
  }
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
  agentDashboardFaceRenderer?.dispose();
});
