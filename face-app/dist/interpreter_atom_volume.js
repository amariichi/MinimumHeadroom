import { randomUUID } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_ATOM_SPEAKER_VOLUME = 200;

export class InterpreterAtomVolumeError extends Error {
  constructor(code, statusCode = 500) {
    super(code);
    this.name = 'InterpreterAtomVolumeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeDeviceId(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeVolume(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_ATOM_SPEAKER_VOLUME
    ? value
    : null;
}

export function createInterpreterAtomVolumeController(options = {}) {
  const registry = options.registry;
  const sendPayload = typeof options.sendPayload === 'function'
    ? options.sendPayload
    : () => false;
  const requestId = typeof options.requestId === 'function'
    ? options.requestId
    : () => randomUUID();
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(100, Math.floor(options.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const setTimer = options.setTimer ?? globalThis.setTimeout;
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout;
  const pending = new Map();

  if (!registry || typeof registry.getVolumeControlTarget !== 'function') {
    throw new TypeError('Atom volume controller requires an endpoint registry');
  }

  function rejectPending(entry, error) {
    clearTimer(entry.timer);
    pending.delete(entry.requestId);
    entry.reject(error);
  }

  async function setVolume({ deviceId = null, volume } = {}) {
    const normalizedVolume = normalizeVolume(volume);
    if (normalizedVolume === null) {
      throw new InterpreterAtomVolumeError('invalid_atom_volume', 400);
    }
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const target = registry.getVolumeControlTarget(normalizedDeviceId);
    if (!target) {
      const connected = registry.getPresence?.().connected === true;
      throw new InterpreterAtomVolumeError(
        connected ? 'atom_volume_unavailable' : 'atom_not_connected',
        409
      );
    }

    const id = requestId();
    return new Promise((resolve, reject) => {
      const entry = {
        requestId: id,
        socket: target.socket,
        deviceId: target.deviceId,
        volume: normalizedVolume,
        resolve,
        reject,
        timer: null
      };
      entry.timer = setTimer(() => {
        rejectPending(
          entry,
          new InterpreterAtomVolumeError('atom_volume_timeout', 504)
        );
      }, timeoutMs);
      pending.set(id, entry);

      const sent = sendPayload(target.socket, {
        v: 1,
        type: 'atom_volume_set',
        request_id: id,
        device_id: target.deviceId,
        volume: normalizedVolume,
        ts: Date.now()
      });
      if (!sent) {
        rejectPending(
          entry,
          new InterpreterAtomVolumeError('atom_volume_send_failed', 503)
        );
      }
    });
  }

  function handlePayload(payload, context = {}) {
    if (payload?.type !== 'atom_volume_result') {
      return false;
    }
    const id = normalizeDeviceId(payload.request_id);
    const entry = id ? pending.get(id) : null;
    if (!entry) {
      return true;
    }
    if (
      context.isAtom !== true
      || context.socket !== entry.socket
    ) {
      return true;
    }

    if (payload.ok !== true) {
      rejectPending(
        entry,
        new InterpreterAtomVolumeError('atom_volume_failed', 502)
      );
      return true;
    }
    const speakerVolume = normalizeVolume(payload.speaker_volume);
    const responseDeviceId = normalizeDeviceId(payload.device_id);
    if (
      speakerVolume !== entry.volume
      || (responseDeviceId && responseDeviceId !== entry.deviceId)
    ) {
      rejectPending(
        entry,
        new InterpreterAtomVolumeError('atom_volume_mismatch', 502)
      );
      return true;
    }

    clearTimer(entry.timer);
    pending.delete(id);
    registry.updateSpeakerVolume?.({
      socket: entry.socket,
      deviceId: entry.deviceId,
      speakerVolume
    });
    entry.resolve({
      ok: true,
      deviceId: entry.deviceId,
      speakerVolume,
      persistent: false
    });
    return true;
  }

  function failSocket(socket) {
    for (const entry of [...pending.values()]) {
      if (entry.socket === socket) {
        rejectPending(
          entry,
          new InterpreterAtomVolumeError('atom_disconnected', 503)
        );
      }
    }
  }

  function dispose() {
    for (const entry of [...pending.values()]) {
      rejectPending(
        entry,
        new InterpreterAtomVolumeError('interpreter_shutting_down', 503)
      );
    }
  }

  return {
    dispose,
    failSocket,
    handlePayload,
    pendingCount() {
      return pending.size;
    },
    setVolume
  };
}

export const INTERPRETER_ATOM_VOLUME_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
