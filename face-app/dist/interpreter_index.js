#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAtomAudioVadBridge,
  createRmsVadBackend,
  createSileroVadBackend
} from './atom_audio_vad_bridge.js';
import { createAtomVolumeApi } from './atom_volume_api.js';
import { createInterpreterApi } from './interpreter_api.js';
import { createInterpreterAtomVolumeController } from './interpreter_atom_volume.js';
import { createAtomEndpointRegistry } from './interpreter_audio_route.js';
import { createGemma4InterpreterProviders } from './interpreter_gemma4_provider.js';
import {
  createNemotronAsrProvider
} from './interpreter_nemotron_provider.js';
import { createInterpreterPipeline } from './interpreter_pipeline.js';
import {
  atomInterpreterSessionId,
  resolveInterpreterPreset
} from './interpreter_runtime_config.js';
import {
  createInterpreterTtsGate,
  interpreterManualPairLanguages,
  interpreterTtsSupportedLanguages,
  interpreterTtsSupportsLanguage
} from './interpreter_tts_support.js';
import { createTtsAudioStore } from './tts_audio_store.js';
import { createTtsController } from './tts_controller.js';
import { startFaceWebSocketServer } from './ws_server.js';
import { createRuntimeModeApi } from './runtime_mode_api.js';

function optionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value, fallback) {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeAtomTtsCodecMode(value) {
  const normalized = String(value ?? 'auto').trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'pcm16' || normalized === 'ima_adpcm') {
    return normalized;
  }
  throw new Error('MH_ATOM_TTS_CODEC must be auto, pcm16, or ima_adpcm');
}

function parseAllowedOrigins(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }
  const result = [];
  for (const item of value.split(',')) {
    try {
      result.push(new URL(item.trim()).origin);
    } catch {}
  }
  return [...new Set(result)];
}

function isLoopbackHost(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === ''
    || normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

async function probeHealth(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(2000)
    });
    return { ready: response.ok, status: response.status };
  } catch (error) {
    return {
      ready: false,
      error: error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'timeout'
        : 'unreachable'
    };
  }
}

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const repoRoot = path.resolve(currentDir, '../..');
const staticDir = path.resolve(currentDir, '../public');

let preset;
try {
  preset = resolveInterpreterPreset(
    process.env.INTERPRETER_PRESET ?? process.env.MH_INTERPRETER_PRESET
  );
} catch (error) {
  console.error(`[interpreter] ${error.message}`);
  process.exit(2);
}
const runtimeModeApi = createRuntimeModeApi({
  mode: 'interpreter',
  selection: preset.name,
  repoRoot
});

const host = process.env.INTERPRETER_HOST ?? process.env.FACE_WS_HOST ?? '127.0.0.1';
const port = positiveInt(
  process.env.INTERPRETER_PORT ?? process.env.FACE_WS_PORT,
  8765
);
const wsPath = process.env.INTERPRETER_WS_PATH ?? process.env.FACE_WS_PATH ?? '/ws';
const authToken = optionalString(
  process.env.MH_INTERPRETER_AUTH_TOKEN
  ?? process.env.MH_FACE_AUTH_TOKEN
  ?? process.env.FACE_AUTH_TOKEN
);
const allowedOrigins = parseAllowedOrigins(
  process.env.MH_INTERPRETER_ALLOWED_ORIGINS
  ?? process.env.MH_FACE_ALLOWED_ORIGINS
);
if (!isLoopbackHost(host) && !authToken) {
  console.error(
    `[interpreter] MH_INTERPRETER_AUTH_TOKEN is required when binding to ${host}`
  );
  process.exit(2);
}

const nemotronBaseUrl =
  process.env.MH_NEMOTRON_ASR_BASE_URL ?? 'http://127.0.0.1:8095';
const gemmaBaseUrl =
  process.env.MH_GEMMA4_BASE_URL ?? 'http://127.0.0.1:8093/v1';
const gemmaModel =
  process.env.MH_GEMMA4_MODEL ?? 'gemma-4-12b-it-qat-q4_0.gguf';
const sileroBaseUrl =
  process.env.MH_INTERPRETER_SILERO_BASE_URL ?? 'http://127.0.0.1:8094';
const ttsEnabled = (process.env.MH_INTERPRETER_TTS_ENABLED ?? '1') !== '0';
let atomTtsCodecMode;
try {
  atomTtsCodecMode = normalizeAtomTtsCodecMode(process.env.MH_ATOM_TTS_CODEC);
} catch (error) {
  console.error(`[interpreter] ${error.message}`);
  process.exit(2);
}

let asr;
let intent;
let translation;
const needsGemma = (
  preset.asr === 'gemma4'
  || preset.intent === 'gemma4'
  || preset.translation === 'gemma4'
);
const gemmaProviders = needsGemma
  ? createGemma4InterpreterProviders({
    baseUrl: gemmaBaseUrl,
    model: gemmaModel,
    requestTimeoutMs: positiveInt(process.env.MH_GEMMA4_TIMEOUT_MS, 60_000),
    acceptExternalTranscripts: preset.asr !== 'gemma4'
  })
  : null;

if (preset.asr === 'gemma4') {
  asr = gemmaProviders.asr;
} else {
  asr = createNemotronAsrProvider({
    baseUrl: nemotronBaseUrl,
    requestTimeoutMs: positiveInt(process.env.MH_NEMOTRON_ASR_TIMEOUT_MS, 45_000),
    fallbackAsr: gemmaProviders.asr,
    log: console
  });
}
intent = gemmaProviders.intent;
translation = gemmaProviders.translation;

let liveServer = null;
const broadcast = (payload) => liveServer?.broadcast(payload) ?? false;
const atomVadSessionByInterpreterSession = new Map();

const atomRegistry = createAtomEndpointRegistry({
  ttlMs: positiveInt(process.env.MH_INTERPRETER_ATOM_TTL_MS, 15_000),
  onChange(presence) {
    broadcast({
      v: 1,
      type: 'interpreter_audio_endpoint_changed',
      audioEndpoint: presence.endpoint,
      atom: presence,
      ts: Date.now()
    });
  }
});
const atomVolumeController = createInterpreterAtomVolumeController({
  registry: atomRegistry,
  timeoutMs: positiveInt(process.env.MH_INTERPRETER_ATOM_VOLUME_TIMEOUT_MS, 3_000),
  sendPayload(socket, payload) {
    return liveServer?.sendToSocket(socket, payload) ?? false;
  }
});
const atomVolumeApi = createAtomVolumeApi({
  registry: atomRegistry,
  setVolume(input) {
    return atomVolumeController.setVolume(input);
  },
  log: console
});

const ttsAudioStore = createTtsAudioStore({
  ttlMs: positiveInt(process.env.MH_TTS_AUDIO_REF_TTL_MS, 60_000)
});
let ttsController = null;
if (ttsEnabled) {
  ttsController = createTtsController({
    log: console,
    audioTarget: 'browser',
    broadcast,
    audioStore: ttsAudioStore,
    browserAudioEncoderOptions: {
      command: process.env.MH_INTERPRETER_FFMPEG_COMMAND ?? 'ffmpeg'
    },
    atomAudioCodecResolver() {
      if (atomTtsCodecMode === 'ima_adpcm') {
        return 'ima_adpcm_wav';
      }
      if (atomTtsCodecMode === 'pcm16') {
        return 'pcm16_wav';
      }
      return atomRegistry.getPreferredPlaybackCodec();
    },
    // The default say gate is intentionally strict for agent notifications
    // (one low-priority item per session per minute). Interpreter turns are
    // already idempotent by turn ID and must remain conversational, so only
    // this dedicated controller bypasses notification rate limits.
    gate: createInterpreterTtsGate(),
    defaultTtlMs: 60_000,
    autoInterruptAfterMs: null,
    maxChunkChars: positiveInt(process.env.MH_TTS_CHUNK_MAX_CHARS, 120),
    workerCwd: repoRoot,
    workerEnv: {
      MH_AUDIO_TARGET: 'browser',
      TTS_ENGINE: preset.tts,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_DATASETS_OFFLINE: '1'
    }
  });
}

const tts = ttsController
  ? {
      enqueue(input) {
        if (!interpreterTtsSupportsLanguage(preset.tts, input.language)) {
          return Promise.resolve({
            accepted: false,
            reason: 'unsupported_language'
          });
        }
        const purpose = optionalString(input.purpose) ?? 'translation';
        const sequenceIndex = Number.isInteger(input.sequenceIndex)
          ? Math.max(0, input.sequenceIndex)
          : 0;
        const utteranceSuffix = purpose === 'language_pair_announcement'
          ? `${purpose}:${sequenceIndex + 1}`
          : purpose;
        const utteranceId = `interpreter:${input.turnId}:${utteranceSuffix}`;
        const revision = Date.now();
        return ttsController.handleSayPayload({
          v: 1,
          type: 'say',
          session_id: input.sessionId,
          utterance_id: utteranceId,
          message_id: utteranceId,
          revision,
          ts: revision,
          text: input.text,
          language: input.language,
          audio_endpoint: input.audioEndpoint,
          priority: 2,
          policy: 'replace',
          append_to_queue: input.queueMode === 'append',
          ttl_ms: 60_000
        });
      }
    }
  : null;

const pipeline = createInterpreterPipeline({
  asr,
  intent,
  translation,
  tts,
  supportedPairLanguages: ttsEnabled
    ? interpreterManualPairLanguages(preset.name)
    : [],
  atomRegistry,
  broadcast,
  log: console
});

const atomVadBackendKind =
  (process.env.MH_INTERPRETER_VAD_BACKEND ?? 'silero').trim().toLowerCase();
const atomVadBackend = atomVadBackendKind === 'rms'
  ? createRmsVadBackend({
      thresholdRms: finiteNumber(
        process.env.MH_INTERPRETER_VAD_THRESHOLD_RMS,
        0.025
      )
    })
  : createSileroVadBackend({
      baseUrl: sileroBaseUrl,
      threshold: finiteNumber(
        process.env.MH_INTERPRETER_SILERO_THRESHOLD,
        0.5
      )
    });

const atomAudioVadBridge = createAtomAudioVadBridge({
  vadBackend: atomVadBackend,
  preRollMs: finiteNumber(
    process.env.MH_INTERPRETER_VAD_PRE_ROLL_MS,
    256
  ),
  endSilenceMs: positiveInt(
    process.env.MH_INTERPRETER_VAD_END_SILENCE_MS,
    700
  ),
  minSpeechMs: positiveInt(
    process.env.MH_INTERPRETER_VAD_MIN_SPEECH_MS,
    350
  ),
  maxUtteranceMs: positiveInt(
    process.env.MH_INTERPRETER_VAD_MAX_UTTERANCE_MS,
    12_000
  ),
  async onUtterance(utterance) {
    const sessionId = atomInterpreterSessionId(utterance.sessionId);
    atomVadSessionByInterpreterSession.set(sessionId, utterance.sessionId);
    try {
      await pipeline.processTurn({
        audio: utterance.wav,
        mimeType: utterance.mimeType,
        sessionId,
        turnId: randomUUID(),
        inputSource: 'atom',
        speechMs: utterance.speechMs
      });
    } catch (error) {
      console.warn(`[interpreter] Atom turn failed: ${error.message}`);
    }
    return { handled: true };
  },
  log: console
});

const api = createInterpreterApi({
  pipeline,
  log: console,
  atomSessionId: atomInterpreterSessionId,
  createTurnId: randomUUID,
  setAtomVolume(input) {
    return atomVolumeController.setVolume(input);
  },
  getConfig() {
    const atom = atomRegistry.getPresence();
    return {
      service: 'interpreter',
      preset: preset.name,
      providers: {
        asr: preset.asr,
        intent: preset.intent,
        translation: preset.translation,
        tts: ttsEnabled ? preset.tts : 'disabled'
      },
      ttsSupportedLanguages: ttsEnabled
        ? interpreterTtsSupportedLanguages(preset.tts)
        : [],
      manualPairLanguages: ttsEnabled
        ? interpreterManualPairLanguages(preset.name)
        : [],
      audioEndpoint: atom.endpoint,
      atomTtsCodec: atomTtsCodecMode === 'auto'
        ? atomRegistry.getPreferredPlaybackCodec()
        : `${atomTtsCodecMode}_wav`,
      atom: {
        ...atom,
        sessionId: atom.connected && atom.devices[0]
          ? atomInterpreterSessionId(atom.devices[0].deviceId)
          : null
      },
      auth: {
        required: Boolean(authToken)
      }
    };
  },
  async getHealth() {
    const gemmaHealthPromise = needsGemma
      ? probeHealth(new URL('/health', gemmaBaseUrl).toString())
      : Promise.resolve({ ready: true, unused: true });
    const [gemmaHealth, externalAsrHealth] = await Promise.all([
      gemmaHealthPromise,
      preset.asr === 'gemma4'
        ? Promise.resolve(null)
        : asr.health()
    ]);
    const asrHealth = preset.asr === 'gemma4'
      ? gemmaHealth
      : externalAsrHealth;
    const ttsSnapshot = ttsController?.snapshot() ?? { workerReady: false };
    const ttsReady = !ttsEnabled || ttsSnapshot.workerReady === true;
    const textReady = gemmaHealth.ready !== false;
    return {
      ok: asrHealth.ready !== false && textReady && ttsReady,
      service: 'interpreter',
      preset: preset.name,
      providers: {
        asr: asrHealth.ready === false ? 'unavailable' : 'ready',
        intent: textReady ? 'ready' : 'unavailable',
        translation: textReady ? 'ready' : 'unavailable',
        tts: ttsReady ? (ttsEnabled ? 'ready' : 'disabled') : 'starting'
      },
      audioEndpoint: atomRegistry.getPresence().endpoint,
      details: {
        asr: asrHealth,
        gemma: gemmaHealth,
        tts: ttsSnapshot
      }
    };
  }
});

liveServer = await startFaceWebSocketServer({
  host,
  port,
  path: wsPath,
  staticDir,
  defaultDocument: 'interpreter.html',
  documentRoutes: {
    '/interpreter': 'interpreter.html',
    '/interpreter/': 'interpreter.html'
  },
  authToken,
  allowedOrigins,
  requireOriginCheck: true,
  relayPayloads: true,
  onPayload(payload, context) {
    if (payload?.type === 'operator_response' && context?.isAtom) {
      return api.handlePttPayload(payload, context);
    }
    if (payload?.type === 'atom_volume_result') {
      atomVolumeController.handlePayload(payload, context);
      return { relay: false };
    }
    if (payload?.type === 'atom_endpoint_state') {
      if (context?.isAtomBridge) {
        atomRegistry.observeBridgeState(payload, context);
      } else if (context?.isAtom) {
        atomRegistry.observeDirectState(payload, context);
      }
      return { relay: false };
    }
    if (payload?.type === 'atom_audio_frame') {
      atomRegistry.observeDirectFrame({
        socket: context?.socket,
        deviceId: payload.device_id,
        sessionId: payload.session_id
      });
      return atomAudioVadBridge.handlePayload(payload);
    }
    return null;
  },
  onClientClose(context) {
    atomVolumeController.failSocket(context?.socket);
    atomRegistry.forgetSocket(context?.socket);
  },
  onAtomTtsDispatch(payload) {
    const vadSessionId = atomVadSessionByInterpreterSession.get(payload?.session_id);
    if (vadSessionId) {
      atomAudioVadBridge.resetSession(vadSessionId, {
        reason: 'interpreter_tts_dispatch'
      });
    }
  },
  async onHttpRequest(request, response) {
    if (await runtimeModeApi.handleHttpRequest(request, response)) {
      return true;
    }
    if (await atomVolumeApi.handleHttpRequest(request, response)) {
      return true;
    }
    if (ttsAudioStore.handleHttpRequest(request, response)) {
      return true;
    }
    return api.handleHttpRequest(request, response);
  },
  log: console
});

broadcast({
  v: 1,
  type: 'interpreter_audio_endpoint_changed',
  audioEndpoint: atomRegistry.getPresence().endpoint,
  atom: atomRegistry.getPresence(),
  ts: Date.now()
});

console.info(
  `[interpreter] preset=${preset.name} vad=${atomVadBackend.name} ui=${liveServer.httpUrl}`
);

const atomVadTimer = setInterval(() => {
  atomAudioVadBridge.checkUtteranceTimeouts();
}, 200);
atomVadTimer.unref?.();
const atomPresenceTimer = setInterval(() => {
  atomRegistry.prune();
}, 5_000);
atomPresenceTimer.unref?.();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.info(`[interpreter] ${signal} received, shutting down`);
  clearInterval(atomVadTimer);
  clearInterval(atomPresenceTimer);
  atomVolumeController.dispose();
  try {
    await ttsController?.stop();
    await liveServer?.stop();
  } catch (error) {
    console.error(`[interpreter] shutdown failed: ${error.message}`);
    process.exitCode = 1;
  }
}

process.on('SIGINT', () => {
  shutdown('SIGINT').finally(() => process.exit());
});
process.on('SIGTERM', () => {
  shutdown('SIGTERM').finally(() => process.exit());
});
