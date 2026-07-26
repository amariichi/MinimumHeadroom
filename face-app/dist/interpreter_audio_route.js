const DEFAULT_PRESENCE_TTL_MS = 15_000;
const PCM16_WAV_CODEC = 'pcm16_wav';
const IMA_ADPCM_WAV_CODEC = 'ima_adpcm_wav';

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function presenceFingerprint(presence) {
  return JSON.stringify({
    connected: presence.connected,
    endpoint: presence.endpoint,
    devices: presence.devices.map((device) => ({
      deviceId: device.deviceId,
      source: device.source,
      playbackCodecs: device.playbackCodecs,
      speakerVolume: device.speakerVolume,
      volumeControl: device.volumeControl
    }))
  });
}

function emitIfChanged(registry, previousPresence) {
  const current = registry.getPresence();
  if (presenceFingerprint(current) === presenceFingerprint(previousPresence)) {
    return;
  }
  registry.onChange?.(current);
}

function normalizePlaybackCodecs(value) {
  if (!Array.isArray(value)) {
    return [PCM16_WAV_CODEC];
  }
  const codecs = [...new Set(
    value.filter((item) => item === PCM16_WAV_CODEC || item === IMA_ADPCM_WAV_CODEC)
  )];
  return codecs.length > 0 ? codecs : [PCM16_WAV_CODEC];
}

function recordKey(source, deviceId) {
  return `${source}:${deviceId}`;
}

function normalizeSpeakerVolume(value) {
  return Number.isInteger(value) && value >= 0 && value <= 200
    ? value
    : null;
}

export function resolveInterpreterAudioEndpoint({ inputSource, atomPresence } = {}) {
  if (inputSource === 'atom') {
    return 'atom';
  }
  return atomPresence?.connected === true ? 'atom' : 'browser';
}

export function normalizeInterpreterAudioEndpoint(value, fallback = null) {
  if (value === 'atom' || value === 'browser') {
    return value;
  }
  return fallback;
}

export function createAtomEndpointRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ttlMs = Number.isFinite(options.ttlMs)
    ? Math.max(1_000, Math.floor(options.ttlMs))
    : DEFAULT_PRESENCE_TTL_MS;
  const records = new Map();
  const socketDevices = new Map();

  function rememberSocketRecord(socket, key) {
    if (!socket) {
      return;
    }
    let keys = socketDevices.get(socket);
    if (!keys) {
      keys = new Set();
      socketDevices.set(socket, keys);
    }
    keys.add(key);
  }

  function currentRecords(atMs = now()) {
    return [...records.values()].filter((record) => atMs - record.lastSeenAt <= ttlMs);
  }

  function preferredRecords(atMs = now()) {
    const live = currentRecords(atMs);
    const source = live.some((record) => record.source === 'direct') ? 'direct' : 'bridge';
    return live.filter((record) => record.source === source);
  }

  const registry = {
    onChange: typeof options.onChange === 'function' ? options.onChange : null,
    observeDirectFrame({ socket = null, deviceId, sessionId } = {}) {
      const previousPresence = registry.getPresence();
      const id = asNonEmptyString(deviceId) ?? asNonEmptyString(sessionId) ?? 'atom-headroom';
      const key = recordKey('direct', id);
      const existing = records.get(key);
      records.set(key, {
        deviceId: id,
        source: 'direct',
        socket,
        playbackCodecs: existing?.playbackCodecs ?? [PCM16_WAV_CODEC],
        speakerVolume: existing?.speakerVolume ?? null,
        volumeControl: existing?.volumeControl === true,
        lastSeenAt: now()
      });
      if (socket) {
        rememberSocketRecord(socket, key);
        socket.__mhAtomClient = true;
      }
      emitIfChanged(registry, previousPresence);
      return registry.getPresence();
    },
    observeDirectState(payload, { socket = null } = {}) {
      if (!payload || payload.type !== 'atom_endpoint_state') {
        return false;
      }
      const id = asNonEmptyString(payload.device_id ?? payload.deviceId);
      if (!id || typeof payload.connected !== 'boolean') {
        return false;
      }
      const previousPresence = registry.getPresence();
      const key = recordKey('direct', id);
      if (payload.connected) {
        if (payload.audio_input !== true || payload.audio_output !== true) {
          return false;
        }
        records.set(key, {
          deviceId: id,
          source: 'direct',
          socket,
          playbackCodecs: normalizePlaybackCodecs(payload.playback_codecs),
          speakerVolume: normalizeSpeakerVolume(payload.speaker_volume),
          volumeControl:
            payload.volume_control === true
            && normalizeSpeakerVolume(payload.speaker_volume) !== null,
          lastSeenAt: now()
        });
        if (socket) {
          socket.__mhAtomClient = true;
          rememberSocketRecord(socket, key);
        }
      } else {
        const existing = records.get(key);
        if (!existing || !socket || existing.socket === socket) {
          records.delete(key);
        }
      }
      emitIfChanged(registry, previousPresence);
      return true;
    },
    observeBridgeState(payload, { socket = null } = {}) {
      if (!payload || payload.type !== 'atom_endpoint_state') {
        return false;
      }
      const id = asNonEmptyString(payload.device_id ?? payload.deviceId);
      if (!id || typeof payload.connected !== 'boolean') {
        return false;
      }
      const previousPresence = registry.getPresence();
      const key = recordKey('bridge', id);
      if (payload.connected) {
        if (payload.audio_input !== true || payload.audio_output !== true) {
          return false;
        }
        records.set(key, {
          deviceId: id,
          source: 'bridge',
          socket,
          playbackCodecs: normalizePlaybackCodecs(payload.playback_codecs),
          speakerVolume: normalizeSpeakerVolume(payload.speaker_volume),
          volumeControl:
            payload.volume_control === true
            && normalizeSpeakerVolume(payload.speaker_volume) !== null,
          lastSeenAt: now()
        });
        if (socket) {
          socket.__mhAtomBridgeClient = true;
          rememberSocketRecord(socket, key);
        }
      } else {
        const existing = records.get(key);
        if (!existing || !socket || existing.socket === socket) {
          records.delete(key);
        }
      }
      emitIfChanged(registry, previousPresence);
      return true;
    },
    forgetSocket(socket) {
      if (!socket) {
        return;
      }
      const previousPresence = registry.getPresence();
      const keys = socketDevices.get(socket);
      if (keys) {
        for (const key of keys) {
          if (records.get(key)?.socket === socket) {
            records.delete(key);
          }
        }
      }
      socketDevices.delete(socket);
      emitIfChanged(registry, previousPresence);
    },
    prune(atMs = now()) {
      const previousPresence = registry.getPresence();
      for (const [key, record] of records) {
        if (atMs - record.lastSeenAt > ttlMs) {
          records.delete(key);
          if (record.socket) {
            socketDevices.get(record.socket)?.delete(key);
          }
        }
      }
      emitIfChanged(registry, previousPresence);
      return registry.getPresence();
    },
    getPresence() {
      const atMs = now();
      const preferred = preferredRecords(atMs);
      const devices = preferred
        .map((record) => ({
          deviceId: record.deviceId,
          source: record.source,
          playbackCodecs: [...record.playbackCodecs],
          speakerVolume: record.speakerVolume ?? null,
          volumeControl: record.volumeControl === true,
          lastSeenAt: record.lastSeenAt
        }))
        .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
      return {
        connected: devices.length > 0,
        endpoint: devices.length > 0 ? 'atom' : 'browser',
        devices
      };
    },
    getPreferredPlaybackCodec() {
      const active = preferredRecords();
      if (
        active.length > 0
        && active.every((record) => record.playbackCodecs.includes(IMA_ADPCM_WAV_CODEC))
      ) {
        return IMA_ADPCM_WAV_CODEC;
      }
      return PCM16_WAV_CODEC;
    },
    getVolumeControlTarget(deviceId = null) {
      const requestedId = asNonEmptyString(deviceId);
      const candidates = currentRecords()
        .filter((record) => (
          record.socket
          && record.volumeControl === true
          && normalizeSpeakerVolume(record.speakerVolume) !== null
          && (!requestedId || record.deviceId === requestedId)
        ))
        .sort((left, right) => {
          if (left.source !== right.source) {
            return left.source === 'direct' ? -1 : 1;
          }
          return left.deviceId.localeCompare(right.deviceId);
        });
      const selected = candidates[0];
      return selected
        ? {
            deviceId: selected.deviceId,
            source: selected.source,
            socket: selected.socket,
            speakerVolume: selected.speakerVolume
          }
        : null;
    },
    updateSpeakerVolume({ socket = null, deviceId, speakerVolume } = {}) {
      const normalizedDeviceId = asNonEmptyString(deviceId);
      const normalizedVolume = normalizeSpeakerVolume(speakerVolume);
      if (!normalizedDeviceId || normalizedVolume === null) {
        return false;
      }
      const previousPresence = registry.getPresence();
      const candidates = [
        records.get(recordKey('direct', normalizedDeviceId)),
        records.get(recordKey('bridge', normalizedDeviceId))
      ].filter(Boolean);
      const record = candidates.find((item) => !socket || item.socket === socket);
      if (!record || (socket && record.socket !== socket)) {
        return false;
      }
      record.speakerVolume = normalizedVolume;
      record.volumeControl = true;
      record.lastSeenAt = now();
      emitIfChanged(registry, previousPresence);
      return true;
    },
    clear() {
      const previousPresence = registry.getPresence();
      records.clear();
      socketDevices.clear();
      emitIfChanged(registry, previousPresence);
    }
  };

  return registry;
}

export const INTERPRETER_ATOM_PRESENCE_TTL_MS = DEFAULT_PRESENCE_TTL_MS;
