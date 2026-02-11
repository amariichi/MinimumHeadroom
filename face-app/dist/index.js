#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFaceWebSocketServer } from './ws_server.js';
import { createTtsController } from './tts_controller.js';

const host = process.env.FACE_WS_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.FACE_WS_PORT ?? '8765', 10);
const wsPath = process.env.FACE_WS_PATH ?? '/ws';

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const staticDir = path.resolve(currentDir, '../public');
const repoRoot = path.resolve(currentDir, '../..');
const ttsEnabled = (process.env.FACE_TTS_ENABLED ?? '1') !== '0';

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
  log: console
});

if (ttsEnabled) {
  ttsController = createTtsController({
    log: console,
    broadcast(payload) {
      return server.broadcast(payload);
    },
    workerCwd: repoRoot,
    workerEnv: {
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
