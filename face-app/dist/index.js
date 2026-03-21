#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFaceWebSocketServer } from './ws_server.js';
import { createTtsController } from './tts_controller.js';
import { loadFaceAppConfig } from './config_loader.js';
import { resolveBrowserAudioMaxChannels } from './browser_audio_config.js';
import { createOperatorAsrProxy } from './operator_asr_proxy.js';
import { createOperatorRealtimeAsrProxy } from './operator_realtime_asr_proxy.js';
import { createAgentRuntimeStateStore } from './agent_runtime_state.js';
import { createAgentLifecycleApi, createAgentLifecycleRuntime } from './agent_lifecycle.js';
import { createAgentAssignmentStateStore } from './agent_assignment_state.js';
import { createAgentAssignmentApi } from './agent_assignment_api.js';
import { createOwnerInboxStateStore } from './owner_inbox_state.js';
import { createOwnerInboxApi } from './owner_inbox_api.js';

const host = process.env.FACE_WS_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.FACE_WS_PORT ?? '8765', 10);
const wsPath = process.env.FACE_WS_PATH ?? '/ws';
const audioTargetInput = process.env.FACE_AUDIO_TARGET ?? 'local';
const uiModeInput = process.env.FACE_UI_MODE ?? 'auto';

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

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload));
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
const operatorPanelEnabled = (process.env.FACE_OPERATOR_PANEL_ENABLED ?? '1') !== '0';
console.info(`[face-app] operator panel=${operatorPanelEnabled ? 'enabled' : 'disabled'}`);

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const staticDir = path.resolve(currentDir, '../public');
const repoRoot = path.resolve(currentDir, '../..');
const ttsEnabled = (process.env.FACE_TTS_ENABLED ?? '1') !== '0';
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
const operatorAsrProxy = createOperatorAsrProxy({
  baseUrl: operatorAsrBaseUrl,
  endpointUrl: operatorAsrEndpointUrl,
  modelJa: process.env.MH_OPERATOR_ASR_MODEL_JA ?? '',
  modelEn: process.env.MH_OPERATOR_ASR_MODEL_EN ?? '',
  requestTimeoutMs: Number.isNaN(operatorAsrTimeoutMs) ? 20_000 : operatorAsrTimeoutMs,
  log: console
});
let operatorRealtimeAsrProxy = null;

let ttsController = null;

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
  relayPayloads: true,
  onPayload(payload) {
    const realtimeDirective = operatorRealtimeAsrProxy?.handlePayload(payload);
    if (realtimeDirective) {
      return realtimeDirective;
    }

    if (!payload || payload.type !== 'say') {
      return;
    }

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
    if (parsedUrl.pathname === '/api/operator/ui-config') {
      writeJson(response, 200, {
        ok: true,
        uiMode,
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
        }
      });
      return true;
    }
    return operatorAsrProxy.handleHttpRequest(request, response);
  },
  log: console
});
liveServer = server;

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
  ttsController = createTtsController({
    log: console,
    audioTarget,
    broadcast(payload) {
      return server.broadcast(payload);
    },
    defaultTtlMs: faceConfig.tts.defaultTtlMs,
    autoInterruptAfterMs: faceConfig.tts.autoInterruptAfterMs,
    qwenBoundarySpeaker: process.env.MH_QWEN_TTS_BOUNDARY_SPEAKER ?? 'Ono_Anna',
    gateConfig: faceConfig.speechGate,
    workerCwd: repoRoot,
    workerEnv: {
      MH_AUDIO_TARGET: audioTarget,
      MH_KOKORO_MODEL: path.resolve(repoRoot, 'assets/kokoro/kokoro-v1.0.onnx'),
      MH_KOKORO_VOICES: path.resolve(repoRoot, 'assets/kokoro/voices-v1.0.bin')
    }
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
    if (ttsController) {
      await ttsController.stop();
    }
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
