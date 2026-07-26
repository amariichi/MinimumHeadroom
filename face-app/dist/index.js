#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFaceWebSocketServer } from './ws_server.js';
import { createTtsController } from './tts_controller.js';
import { createTtsAudioStore } from './tts_audio_store.js';
import { loadFaceAppConfig } from './config_loader.js';
import { resolveBrowserAudioMaxChannels } from './browser_audio_config.js';
import { createOperatorAsrProxy } from './operator_asr_proxy.js';
import { createOperatorRealtimeAsrProxy } from './operator_realtime_asr_proxy.js';
import { chooseFixedAck } from './fixed_ack.js';
import {
  createAtomAudioVadBridge,
  createRmsVadBackend,
  createSileroVadBackend
} from './atom_audio_vad_bridge.js';
import { createAgentRuntimeStateStore } from './agent_runtime_state.js';
import { createAgentLifecycleApi, createAgentLifecycleRuntime } from './agent_lifecycle.js';
import { createAgentAssignmentStateStore } from './agent_assignment_state.js';
import { createAgentAssignmentApi } from './agent_assignment_api.js';
import { createOwnerInboxStateStore } from './owner_inbox_state.js';
import { createOwnerInboxApi } from './owner_inbox_api.js';
import { createHookBridge } from './hook_bridge.js';
import { createHelperStuckDetector } from './helper_stuck_detector.js';
import { createMediaController, parseMediaAllowedEndpoints } from './media_controller.js';
import { createMediaProxy } from './media_proxy.js';
import { createMediaApi } from './media_api.js';
import { createAudioFocusController } from './audio_focus_controller.js';
import { createRuntimeModeApi } from './runtime_mode_api.js';
import { isRuntimeSelection } from './runtime_mode_config.js';

const host = process.env.FACE_WS_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.FACE_WS_PORT ?? '8765', 10);
const wsPath = process.env.FACE_WS_PATH ?? '/ws';
const authToken = normalizeOptionalString(process.env.MH_FACE_AUTH_TOKEN);
const allowedOrigins = parseAllowedOrigins(process.env.MH_FACE_ALLOWED_ORIGINS);
const audioTargetInput = process.env.FACE_AUDIO_TARGET ?? 'local';
const uiModeInput = process.env.FACE_UI_MODE ?? 'auto';
const faceDisplayInput = process.env.FACE_FACE_DISPLAY ?? 'full';

function normalizeAudioTarget(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'local' || normalized === 'browser' || normalized === 'both') {
    return normalized;
  }
  return null;
}

function normalizeUiMode(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'pc' || normalized === 'mobile') {
    return normalized;
  }
  return null;
}

function normalizeFaceDisplay(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'full' || normalized === 'mini' || normalized === 'hidden') {
    return normalized;
  }
  return null;
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

async function readJsonRequestBody(request, { maxBytes = 32_768 } = {}) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    byteLength += chunk.length;
    if (byteLength > maxBytes) {
      const error = new Error('request_body_too_large');
      error.code = 'request_body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (byteLength === 0) {
    const error = new Error('empty_body');
    error.code = 'empty_body';
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks, byteLength).toString('utf8'));
  } catch {
    const error = new Error('invalid_json');
    error.code = 'invalid_json';
    throw error;
  }
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseAllowedOrigins(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }
  const origins = [];
  for (const item of value.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    try {
      origins.push(new URL(trimmed).origin);
    } catch {
      console.warn(`[face-app] ignoring invalid MH_FACE_ALLOWED_ORIGINS item: ${trimmed}`);
    }
  }
  return [...new Set(origins)];
}

function isLoopbackBindHost(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '' || normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

const audioTarget = normalizeAudioTarget(audioTargetInput);
if (!audioTarget) {
  console.error(`[face-app] invalid FACE_AUDIO_TARGET: ${audioTargetInput} (expected local|browser|both)`);
  process.exit(2);
}

console.info(`[face-app] audio target=${audioTarget}`);
const uiMode = normalizeUiMode(uiModeInput);
if (!uiMode) {
  console.error(`[face-app] invalid FACE_UI_MODE: ${uiModeInput} (expected auto|pc|mobile)`);
  process.exit(2);
}
console.info(`[face-app] ui mode=${uiMode}`);
const faceDisplay = normalizeFaceDisplay(faceDisplayInput);
if (!faceDisplay) {
  console.error(`[face-app] invalid FACE_FACE_DISPLAY: ${faceDisplayInput} (expected full|mini|hidden)`);
  process.exit(2);
}
console.info(`[face-app] face display=${faceDisplay}`);
const operatorPanelEnabled = (process.env.FACE_OPERATOR_PANEL_ENABLED ?? '1') !== '0';
console.info(`[face-app] operator panel=${operatorPanelEnabled ? 'enabled' : 'disabled'}`);
if (!isLoopbackBindHost(host) && !authToken) {
  console.error(
    `[face-app] MH_FACE_AUTH_TOKEN is required when FACE_WS_HOST is ${host}. ` +
      'Set a long random token or bind to 127.0.0.1.'
  );
  process.exit(2);
}
console.info(`[face-app] auth=${authToken ? 'enabled' : 'disabled'}`);
if (allowedOrigins.length > 0) {
  console.info(`[face-app] allowed origins=${allowedOrigins.join(',')}`);
}

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const staticDir = path.resolve(currentDir, '../public');
const repoRoot = path.resolve(currentDir, '../..');
const requestedOperatorProfile =
  process.env.MH_RUNTIME_OPERATOR_PROFILE ?? 'default';
const operatorProfile = isRuntimeSelection(
  'operator',
  requestedOperatorProfile
)
  ? requestedOperatorProfile
  : 'default';
const runtimeModeApi = createRuntimeModeApi({
  mode: 'operator',
  selection: operatorProfile,
  repoRoot
});
const ttsEnabled = (process.env.FACE_TTS_ENABLED ?? '1') !== '0';
const fixedAckEnabled = (process.env.MH_FIXED_ACK_ENABLED ?? '1') !== '0';
const operatorAsrBaseUrl = process.env.MH_OPERATOR_ASR_BASE_URL ?? 'http://127.0.0.1:8091';
const operatorAsrEndpointUrl = process.env.MH_OPERATOR_ASR_ENDPOINT_URL ?? '';
const operatorAsrTimeoutMs = Number.parseInt(process.env.MH_OPERATOR_ASR_TIMEOUT_MS ?? '20000', 10);
const operatorRealtimeAsrEnabled = (process.env.MH_OPERATOR_REALTIME_ASR_ENABLED ?? '0') === '1';
const operatorRealtimeAsrEndpointUrl = process.env.MH_OPERATOR_REALTIME_ASR_WS_URL ?? '';
const operatorRealtimeAsrModel =
  process.env.MH_OPERATOR_REALTIME_ASR_MODEL ?? 'mistralai/Voxtral-Mini-4B-Realtime-2602';
const operatorRealtimeAsrDebug = (process.env.MH_OPERATOR_REALTIME_ASR_DEBUG ?? '0') === '1';
const operatorRealtimeAsrSampleRateHz = Number.parseInt(process.env.MH_OPERATOR_REALTIME_ASR_SAMPLE_RATE_HZ ?? '16000', 10);
const browserAudioMaxChannels = resolveBrowserAudioMaxChannels({ env: process.env, uiMode });
const faceConfig = loadFaceAppConfig({ repoRoot, env: process.env, log: console });
const agentStatePath = process.env.MH_AGENT_STATE_PATH ?? '';
const agentAssignmentStatePath = process.env.MH_AGENT_ASSIGNMENT_STATE_PATH ?? '';
const ownerInboxStatePath = process.env.MH_OWNER_INBOX_STATE_PATH ?? '';
const activeTargetRepoRoot = process.env.MH_AGENT_SOURCE_REPO_DEFAULT ?? '';
const activeStreamId = process.env.MH_AGENT_STREAM_ID ?? '';
const agentRuntimeState = createAgentRuntimeStateStore({
  repoRoot,
  statePath: agentStatePath,
  activeTargetRepoRoot,
  activeStreamId,
  hardCap: Number.parseInt(process.env.MH_AGENT_HARD_CAP ?? '7', 10),
  log: console
});
agentRuntimeState.load();
const agentAssignmentState = createAgentAssignmentStateStore({
  repoRoot,
  statePath: agentAssignmentStatePath,
  log: console
});
agentAssignmentState.load();
const ownerInboxState = createOwnerInboxStateStore({
  repoRoot,
  statePath: ownerInboxStatePath,
  assignmentStateStore: agentAssignmentState,
  log: console
});
ownerInboxState.load();
let liveServer = null;
const mediaAllowedEndpoints = parseMediaAllowedEndpoints(process.env.MH_MEDIA_ALLOWED_ENDPOINTS, { log: console });
const mediaController = createMediaController({
  allowedEndpoints: mediaAllowedEndpoints,
  broadcast(payload) {
    return liveServer?.broadcast(payload) ?? false;
  }
});
const mediaProxy = createMediaProxy({ controller: mediaController, log: console });
const mediaApi = createMediaApi({ controller: mediaController, proxy: mediaProxy });
const audioFocusController = createAudioFocusController({
  releaseDelayMs: 1500,
  broadcast(payload) {
    return liveServer?.broadcast(payload) ?? false;
  }
});
console.info(`[face-app] generic media=${mediaAllowedEndpoints.length > 0 ? 'enabled' : 'disabled'} endpoints=${mediaAllowedEndpoints.length}`);
const agentLifecycleRuntime = createAgentLifecycleRuntime({
  stateStore: agentRuntimeState,
  assignmentStateStore: agentAssignmentState,
  ownerInboxStateStore: ownerInboxState,
  repoRoot,
  activeTargetRepoRoot,
  activeStreamId,
  defaultSourceRepoPath: process.env.MH_AGENT_SOURCE_REPO_DEFAULT ?? '',
  worktreesRoot: process.env.MH_AGENT_WORKTREES_ROOT ?? '',
  tmuxSession: process.env.MH_AGENT_TMUX_SESSION ?? 'agent',
  defaultAgentCommand: process.env.MH_AGENT_DEFAULT_CMD ?? 'codex',
  tmuxEnabled: (process.env.MH_AGENT_TMUX_ENABLED ?? '1') === '1',
  worktreeEnabled: (process.env.MH_AGENT_WORKTREE_ENABLED ?? '1') === '1',
  allowExternalDelete: (process.env.MH_AGENT_ALLOW_EXTERNAL_DELETE ?? '0') === '1',
  helperInjectWaitForReady: (process.env.MH_AGENT_INJECT_WAIT_FOR_READY ?? '1') === '1',
  helperInjectReadyTimeoutMs: Number.parseInt(process.env.MH_AGENT_INJECT_READY_TIMEOUT_MS ?? '4000', 10),
  helperInjectReadyPollMs: Number.parseInt(process.env.MH_AGENT_INJECT_READY_POLL_MS ?? '150', 10),
  helperInjectReadyCaptureLines: Number.parseInt(process.env.MH_AGENT_INJECT_READY_CAPTURE_LINES ?? '80', 10),
  helperInjectReadyStablePolls: Number.parseInt(process.env.MH_AGENT_INJECT_READY_STABLE_POLLS ?? '2', 10),
  helperInjectProbeTimeoutMs: Number.parseInt(process.env.MH_AGENT_INJECT_PROBE_TIMEOUT_MS ?? '1500', 10),
  helperInjectProbePollMs: Number.parseInt(process.env.MH_AGENT_INJECT_PROBE_POLL_MS ?? '75', 10),
  helperInjectProbeCaptureLines: Number.parseInt(process.env.MH_AGENT_INJECT_PROBE_CAPTURE_LINES ?? '80', 10),
  async onFocus({ agentId, paneId, sessionId }) {
    if (!liveServer || typeof liveServer.broadcast !== 'function') {
      const error = new Error('face server is unavailable for focus handoff');
      error.code = 'invalid_state';
      throw error;
    }
    liveServer.broadcast({
      v: 1,
      type: 'operator_bridge_set_pane',
      session_id: sessionId,
      pane: paneId,
      agent_id: agentId,
      ts: Date.now()
    });
  },
  log: console
});
const agentLifecycleApi = createAgentLifecycleApi({
  runtime: agentLifecycleRuntime
});

const helperStuckDetectorEnabled = (process.env.MH_HELPER_STUCK_DETECTOR ?? '1') !== '0'
  && (process.env.MH_HELPER_STUCK_DETECTOR ?? '').toLowerCase() !== 'off';
const helperStuckDetectorIntervalMs = Number.parseInt(process.env.MH_HELPER_STUCK_DETECTOR_INTERVAL_MS ?? '5000', 10);
const helperStuckDetector = helperStuckDetectorEnabled
  ? createHelperStuckDetector({
      runtime: agentLifecycleRuntime,
      inboxStore: ownerInboxState,
      assignmentStore: agentAssignmentState,
      intervalMs: Number.isFinite(helperStuckDetectorIntervalMs) && helperStuckDetectorIntervalMs >= 250
        ? helperStuckDetectorIntervalMs
        : 5000,
      log: console
    })
  : null;
if (helperStuckDetector) {
  helperStuckDetector.start();
  console.info(`[face-app] helper stuck detector started (interval=${helperStuckDetector.intervalMs}ms)`);
} else {
  console.info('[face-app] helper stuck detector disabled by MH_HELPER_STUCK_DETECTOR');
}
const agentAssignmentApi = createAgentAssignmentApi({
  store: agentAssignmentState,
  lifecycleRuntime: agentLifecycleRuntime
});
const ownerInboxApi = createOwnerInboxApi({
  store: ownerInboxState,
  async onSubmitReport({ result }) {
    if (!result || result.transport_state !== 'accepted' || !result.report) {
      return;
    }
    agentAssignmentState.noteReport(result.report);
  }
});
const hookBridge = createHookBridge({ log: console });
const fixedAckCounters = new Map();

function nextFixedAckIndex(language, source) {
  const normalizedLanguage = typeof language === 'string' && language.trim().toLowerCase().startsWith('ja') ? 'ja' : 'en';
  const normalizedSource = typeof source === 'string' && source.trim() !== '' ? source.trim() : 'operator_asr_proxy';
  const key = normalizedSource + ':' + normalizedLanguage;
  const index = fixedAckCounters.get(key) ?? 0;
  fixedAckCounters.set(key, index + 1);
  return index;
}

async function handleAcceptedSpeechAck({ language, source = 'operator_asr_proxy' } = {}) {
  if (!fixedAckEnabled) {
    return;
  }
  const ackIndex = nextFixedAckIndex(language, source);
  const ack = chooseFixedAck({ language, kind: 'accepted', index: ackIndex });
  const now = Date.now();
  await handleInternalSay({
    v: 1,
    type: 'say',
    session_id: source + '_ack',
    ...(process.env.MH_FACE_AGENT_ID ? { agent_id: process.env.MH_FACE_AGENT_ID } : {}),
    ...(process.env.MH_FACE_AGENT_LABEL ? { agent_label: process.env.MH_FACE_AGENT_LABEL } : {}),
    text: ack.text,
    priority: 1,
    policy: 'replace',
    ttl_ms: 4000,
    dedupe_key: source + '_ack:' + ack.language + ':' + ackIndex,
    message_id: source + '-ack-' + now,
    revision: now
  }, { broadcastSay: true });
}

function emitAcceptedSpeechAck(args) {
  handleAcceptedSpeechAck(args).catch((error) => {
    console.error('[face-app] fixed ack failed: ' + error.message);
  });
}

async function handleInternalSay(payload, options = {}) {
  const broadcastSay = options.broadcastSay === true;
  const sayPayload = normalizeSayPayload(payload);
  if (broadcastSay) {
    server.broadcast(sayPayload);
  }
  if (!ttsController) {
    const result = { accepted: false, spoken: false, reason: 'tts_disabled' };
    server.broadcast(toSayResultPayload(sayPayload, result));
    return result;
  }
  try {
    const result = await ttsController.handleSayPayload(sayPayload);
    server.broadcast(toSayResultPayload(sayPayload, result));
    return result;
  } catch (error) {
    console.error('[face-app] internal say failed: ' + error.message);
    const result = { accepted: false, spoken: false, reason: 'controller_error' };
    server.broadcast(toSayResultPayload(sayPayload, result, 'controller_error'));
    return result;
  }
}

// Atom VAD backend selection. Default 'rms' keeps the historical
// deterministic RMS-energy gate. 'silero' routes every frame through the
// silero-vad-worker HTTP service for ML-based speech/non-speech
// classification — pick this in noisy environments where ambient sound
// would otherwise sit above the RMS threshold.
const atomVadBackendKind = (process.env.MH_ATOM_VAD_BACKEND ?? 'rms').trim().toLowerCase();
const sileroBaseUrl = (process.env.MH_SILERO_VAD_BASE_URL ?? 'http://127.0.0.1:8092').trim();
const sileroThresholdEnv = Number.parseFloat(process.env.MH_SILERO_VAD_THRESHOLD ?? '');
// PC-side RMS speech threshold for the default (non-Silero) Atom backend.
// The firmware uses the identical RMS formula as its own bandwidth gate, so
// both must sit below the speaker's actual frame energy. 0.025 (the backend
// default) suits a mic held close; lower it (~0.01) for normal talking
// distance. NaN (unset) falls through to the createRmsVadBackend default.
const atomRmsThreshold = Number.parseFloat(process.env.MH_ATOM_VAD_THRESHOLD_RMS ?? '');
// Atom VAD utterance segmentation tuning. endSilenceMs is how long a pause may
// last before the bridge finalizes an utterance; too low (default was 400 ms)
// cuts natural speech at every breath. NaN here falls through to the bridge's
// own defaults, so an unset env var changes nothing.
const atomEndSilenceMs = Number.parseInt(process.env.MH_ATOM_VAD_END_SILENCE_MS ?? '', 10);
const atomMinSpeechMs = Number.parseInt(process.env.MH_ATOM_VAD_MIN_SPEECH_MS ?? '', 10);
// Hard cap on a single CONTINUOUS utterance (one with no >= endSilence pause).
// The bridge force-finalizes at this length, so the 12 s default cut off long
// monologues. Raise via env; NaN falls through to the bridge default.
const atomMaxUtteranceMs = Number.parseInt(process.env.MH_ATOM_VAD_MAX_UTTERANCE_MS ?? '', 10);
const atomVadBackend = atomVadBackendKind === 'silero'
  ? createSileroVadBackend({
      baseUrl: sileroBaseUrl,
      threshold: Number.isFinite(sileroThresholdEnv) ? sileroThresholdEnv : 0.5
    })
  : createRmsVadBackend({ thresholdRms: atomRmsThreshold });
console.info(`[face-app] Atom VAD backend=${atomVadBackend.name}`);

const atomAudioVadBridge = createAtomAudioVadBridge({
  asrBaseUrl: operatorAsrBaseUrl,
  asrEndpointUrl: operatorAsrEndpointUrl,
  vadBackend: atomVadBackend,
  endSilenceMs: atomEndSilenceMs,
  minSpeechMs: atomMinSpeechMs,
  maxUtteranceMs: atomMaxUtteranceMs,
  onAcceptedSpeech: ({ language }) => emitAcceptedSpeechAck({ language, source: 'atom_vad' }),
  onOperatorResponse: (payload) => {
    server.broadcast(payload);
  },
  log: console
});

// Drive the bridge's wall-clock finalize so an utterance still completes when
// the device goes silent (firmware silence-skip) and stops sending frames.
// This is what lets MH_ATOM_VAD_END_SILENCE_MS be tuned from the PC alone,
// independent of the firmware speech-tail length (vad_tail).
const atomVadTimeoutTimer = setInterval(() => {
  try {
    atomAudioVadBridge.checkUtteranceTimeouts();
  } catch (error) {
    console.warn(`[face-app] Atom VAD timeout check failed: ${error?.message ?? error}`);
  }
}, 200);
atomVadTimeoutTimer.unref?.();

const operatorAsrProxy = createOperatorAsrProxy({
  baseUrl: operatorAsrBaseUrl,
  endpointUrl: operatorAsrEndpointUrl,
  modelJa: process.env.MH_OPERATOR_ASR_MODEL_JA ?? '',
  modelEn: process.env.MH_OPERATOR_ASR_MODEL_EN ?? '',
  requestTimeoutMs: Number.isNaN(operatorAsrTimeoutMs) ? 20_000 : operatorAsrTimeoutMs,
  onBargeIn: (reason) => {
    // Lazily resolved: ttsController is created after this proxy.
    if (ttsController && typeof ttsController.flushForBargeIn === 'function') {
      Promise.resolve(ttsController.flushForBargeIn(reason)).catch((error) => {
        console.error(`[face-app] tts barge-in flush failed: ${error.message}`);
      });
    }
  },
  onAcceptedSpeech: ({ language }) => emitAcceptedSpeechAck({ language, source: 'operator_asr' }),
  log: console
});
let operatorRealtimeAsrProxy = null;

let ttsController = null;
const ttsAudioStore = createTtsAudioStore({
  ttlMs: Number.parseInt(process.env.MH_TTS_AUDIO_REF_TTL_MS ?? '60000', 10)
});

function normalizeSayPayload(payload) {
  const normalized = { ...payload };

  if (typeof normalized.message_id !== 'string' || normalized.message_id.trim() === '') {
    normalized.message_id = randomUUID();
  } else {
    normalized.message_id = normalized.message_id.trim();
  }

  if (!Number.isFinite(normalized.revision)) {
    const fallbackRevision = Number.isFinite(normalized.ts) ? Math.floor(normalized.ts) : Date.now();
    normalized.revision = fallbackRevision;
  } else {
    normalized.revision = Math.floor(normalized.revision);
  }

  if (typeof normalized.agent_id === 'string') {
    normalized.agent_id = normalized.agent_id.trim();
    if (normalized.agent_id === '') {
      delete normalized.agent_id;
    }
  } else if (normalized.agent_id !== undefined) {
    delete normalized.agent_id;
  }

  if (typeof normalized.agent_label === 'string') {
    normalized.agent_label = normalized.agent_label.trim();
    if (normalized.agent_label === '') {
      delete normalized.agent_label;
    }
  } else if (normalized.agent_label !== undefined) {
    delete normalized.agent_label;
  }

  return normalized;
}

function normalizeSessionId(payload) {
  if (typeof payload?.session_id !== 'string') {
    return '-';
  }
  const trimmed = payload.session_id.trim();
  return trimmed === '' ? '-' : trimmed;
}

function toSayResultPayload(payload, result, reasonOverride = null) {
  const reason = reasonOverride ?? (typeof result?.reason === 'string' ? result.reason : null);
  const accepted = Boolean(result?.accepted);
  const spoken = typeof result?.spoken === 'boolean' ? result.spoken : accepted;

  return {
    v: 1,
    type: 'say_result',
    session_id: normalizeSessionId(payload),
    ...(typeof payload?.agent_id === 'string' ? { agent_id: payload.agent_id } : {}),
    ...(typeof payload?.agent_label === 'string' ? { agent_label: payload.agent_label } : {}),
    utterance_id: typeof payload?.utterance_id === 'string' ? payload.utterance_id : null,
    message_id: typeof payload?.message_id === 'string' ? payload.message_id : null,
    revision: Number.isFinite(payload?.revision) ? Math.floor(payload.revision) : null,
    accepted,
    spoken,
    reason,
    generation: Number.isInteger(result?.generation) ? result.generation : null,
    queued: Boolean(result?.queued),
    ts: Date.now()
  };
}

const server = await startFaceWebSocketServer({
  host,
  port: Number.isNaN(port) ? 8765 : port,
  path: wsPath,
  staticDir,
  authToken,
  allowedOrigins,
  requireOriginCheck: true,
  relayPayloads: true,
  onAtomTtsDispatch: (payload) => {
    // Drop any partial Atom-VAD utterance before the device plays the
    // TTS audio. Without this, microphone bleed buffered before the
    // dispatch could still finalize into ASR once the silence threshold
    // fires post-playback. Always-on: when the device is not streaming
    // mic frames (its persisted continuous_vad_enabled is off), the
    // bridge buffers are empty and resetSession is a no-op.
    const sessionId = typeof payload?.session_id === 'string' && payload.session_id.trim() !== ''
      ? payload.session_id.trim()
      : 'atom-headroom';
    atomAudioVadBridge.resetSession(sessionId, { reason: 'tts_dispatch' });
  },
  onPayload(payload) {
    const atomVadDirective = atomAudioVadBridge.handlePayload(payload);
    if (atomVadDirective) {
      return atomVadDirective;
    }

    const realtimeDirective = operatorRealtimeAsrProxy?.handlePayload(payload);
    if (realtimeDirective) {
      return realtimeDirective;
    }

    if (payload && payload.type === 'hook') {
      hookBridge
        .handleHook({ payload, server, ttsController, ownerInboxStore: ownerInboxState, assignmentStore: agentAssignmentState })
        .catch((error) => {
          console.warn(`[face-app] hook bridge failed: ${error.message}`);
        });
      return;
    }

    if (!payload || payload.type !== 'say') {
      return;
    }

    hookBridge.observePayload(payload);

    const sayPayload = normalizeSayPayload(payload);
    payload.message_id = sayPayload.message_id;
    payload.revision = sayPayload.revision;

    if (!ttsController) {
      server.broadcast(toSayResultPayload(sayPayload, { accepted: false, spoken: false, reason: 'tts_disabled' }));
      return;
    }

    ttsController
      .handleSayPayload(sayPayload)
      .then((result) => {
        server.broadcast(toSayResultPayload(sayPayload, result));
      })
      .catch((error) => {
        console.error(`[face-app] tts handleSay error: ${error.message}`);
        server.broadcast(toSayResultPayload(sayPayload, { accepted: false, spoken: false }, 'controller_error'));
      });
  },
  async onHttpRequest(request, response) {
    const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (parsedUrl.pathname === '/healthz') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writeJson(response, 405, {
          ok: false,
          error: 'method_not_allowed'
        });
        return true;
      }
      writeJson(response, 200, {
        ok: true,
        service: 'operator',
        profile: operatorProfile
      });
      return true;
    }
    if (await runtimeModeApi.handleHttpRequest(request, response)) {
      return true;
    }
    if (await mediaApi.handleHttpRequest(request, response)) {
      return true;
    }
    if (await agentLifecycleApi.handleHttpRequest(request, response)) {
      return true;
    }
    if (await agentAssignmentApi.handleHttpRequest(request, response)) {
      return true;
    }
    if (await ownerInboxApi.handleHttpRequest(request, response)) {
      return true;
    }
    if (parsedUrl.pathname === '/api/operator/recover-default') {
      if (request.method !== 'POST') {
        writeJson(response, 405, {
          ok: false,
          error: 'method_not_allowed'
        });
        return true;
      }
      const sessionId = typeof parsedUrl.searchParams.get('session_id') === 'string' && parsedUrl.searchParams.get('session_id').trim() !== ''
        ? parsedUrl.searchParams.get('session_id').trim()
        : 'default';
      server.broadcast({
        v: 1,
        type: 'operator_bridge_recover_default',
        session_id: sessionId,
        ts: Date.now()
      });
      writeJson(response, 200, {
        ok: true,
        session_id: sessionId
      });
      return true;
    }
    if (parsedUrl.pathname === '/api/operator/response') {
      if (request.method !== 'POST') {
        writeJson(response, 405, {
          ok: false,
          error: 'method_not_allowed'
        });
        return true;
      }
      let payload = null;
      try {
        payload = await readJsonRequestBody(request);
      } catch (error) {
        writeJson(response, error.code === 'request_body_too_large' ? 413 : 400, {
          ok: false,
          error: error.code ?? 'invalid_request_body'
        });
        return true;
      }
      if (!payload || payload.type !== 'operator_response') {
        writeJson(response, 400, {
          ok: false,
          error: 'invalid_operator_response'
        });
        return true;
      }
      if (typeof payload.value !== 'string' || payload.value.trim() === '') {
        writeJson(response, 400, {
          ok: false,
          error: 'empty_value'
        });
        return true;
      }
      const normalized = {
        ...payload,
        v: payload.v ?? 1,
        type: 'operator_response',
        session_id: normalizeSessionId(payload),
        response_kind: typeof payload.response_kind === 'string' ? payload.response_kind : 'text',
        value: payload.value.trim(),
        source: typeof payload.source === 'string' && payload.source.trim() !== '' ? payload.source.trim() : 'http',
        ts: Date.now()
      };
      server.broadcast(normalized);
      writeJson(response, 202, {
        ok: true
      });
      return true;
    }
    if (parsedUrl.pathname === '/api/operator/ui-config') {
      writeJson(response, 200, {
        ok: true,
        uiMode,
        faceDisplay,
        operatorPanelEnabled,
        batchAsr: {
          enabled: operatorAsrProxy?.enabled === true
        },
        realtimeAsr: {
          enabled: operatorRealtimeAsrProxy?.enabled === true,
          sampleRateHz: Number.isNaN(operatorRealtimeAsrSampleRateHz) ? 16_000 : operatorRealtimeAsrSampleRateHz
        },
        browserAudio: {
          maxChannels: browserAudioMaxChannels
        },
        media: {
          enabled: mediaAllowedEndpoints.length > 0,
          mimeType: 'audio/mpeg',
          bitrate: 128000
        },
        auth: {
          required: Boolean(authToken),
          tokenQueryParam: 'auth_token'
        }
      });
      return true;
    }
    if (ttsAudioStore.handleHttpRequest(request, response)) {
      return true;
    }
    return operatorAsrProxy.handleHttpRequest(request, response);
  },
  log: console
});
liveServer = server;
mediaController.replay();
audioFocusController.replay();

try {
  const cleanupResult = await agentLifecycleRuntime.cleanupAgentsOnStartup();
  const deleted = cleanupResult.results.filter((item) => item.disposition === 'deleted').length;
  const purged = cleanupResult.results.filter((item) => item.disposition === 'purged_hidden' || item.disposition === 'purged_state_only').length;
  const failed = cleanupResult.results.filter((item) => item.disposition === 'failed').length;
  const orphanAssignments = Number.isFinite(cleanupResult.orphan_assignments?.removed_count)
    ? cleanupResult.orphan_assignments.removed_count
    : 0;
  const orphanInbox =
    (Number.isFinite(cleanupResult.orphan_inbox?.removed?.missions) ? cleanupResult.orphan_inbox.removed.missions : 0)
    + (Number.isFinite(cleanupResult.orphan_inbox?.removed?.reports) ? cleanupResult.orphan_inbox.removed.reports : 0);
  if (deleted > 0 || purged > 0 || failed > 0 || orphanAssignments > 0 || orphanInbox > 0) {
    console.info(
      `[face-app] startup helper cleanup: deleted=${deleted} purged=${purged} failed=${failed} assignments=${orphanAssignments} inbox=${orphanInbox} total=${cleanupResult.results.length}`
    );
  }
} catch (error) {
  console.warn(`[face-app] startup helper cleanup failed: ${error.message}`);
}

operatorRealtimeAsrProxy = createOperatorRealtimeAsrProxy({
  enabled: operatorRealtimeAsrEnabled,
  endpointUrl: operatorRealtimeAsrEndpointUrl,
  model: operatorRealtimeAsrModel,
  debug: operatorRealtimeAsrDebug,
  broadcast(payload) {
    return server.broadcast(payload);
  },
  log: console
});

if (ttsEnabled) {
  const explicitKokoroVoice = typeof process.env.MH_KOKORO_VOICE === 'string' && process.env.MH_KOKORO_VOICE.trim() !== '' ? process.env.MH_KOKORO_VOICE.trim() : null;
  const kokoroVoice = explicitKokoroVoice ?? ((process.env.MH_LANG ?? '').trim().toLowerCase() === 'en' ? 'af_heart' : 'jf_alpha');
  const workerEnv = {
    MH_AUDIO_TARGET: audioTarget,
    MH_KOKORO_MODEL: path.resolve(repoRoot, 'assets/kokoro/kokoro-v1.0.onnx'),
    MH_KOKORO_VOICES: path.resolve(repoRoot, 'assets/kokoro/voices-v1.0.bin')
  };
  if (explicitKokoroVoice) {
    workerEnv.MH_KOKORO_VOICE = explicitKokoroVoice;
  }
  ttsController = createTtsController({
    log: console,
    audioTarget,
    broadcast(payload) {
      return server.broadcast(payload);
    },
    audioStore: ttsAudioStore,
    onActivityChange(activity) {
      audioFocusController.update(activity);
    },
    defaultTtlMs: faceConfig.tts.defaultTtlMs,
    autoInterruptAfterMs: faceConfig.tts.autoInterruptAfterMs,
    qwenBoundarySpeaker: process.env.MH_QWEN_TTS_BOUNDARY_SPEAKER ?? 'Ono_Anna',
    defaultWorkerVoice: kokoroVoice,
    maxChunkChars: Number.parseInt(process.env.MH_TTS_CHUNK_MAX_CHARS ?? '120', 10),
    gateConfig: faceConfig.speechGate,
    workerCwd: repoRoot,
    workerEnv
  });
} else {
  console.info('[face-app] tts disabled by FACE_TTS_ENABLED=0');
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.info(`[face-app] ${signal} received, shutting down`);

  try {
    if (helperStuckDetector) {
      helperStuckDetector.stop();
    }
    if (ttsController) {
      await ttsController.stop();
    }
    audioFocusController.close();
    mediaController.close();
    if (operatorRealtimeAsrProxy) {
      await operatorRealtimeAsrProxy.closeAll();
    }
    await server.stop();
  } catch (error) {
    console.error(`[face-app] shutdown error: ${error.message}`);
    process.exitCode = 1;
  }
}

process.on('SIGINT', () => {
  shutdown('SIGINT').finally(() => process.exit());
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').finally(() => process.exit());
});
