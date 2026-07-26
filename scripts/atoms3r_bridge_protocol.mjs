export const ATOM_BRIDGE_SUBPROTOCOL = 'mh-atom-http-bridge-v1';
const KNOWN_PLAYBACK_CODECS = new Set(['pcm16_wav', 'ima_adpcm_wav']);
const MAX_ATOM_SPEAKER_VOLUME = 200;

export function shouldForwardAudioToAtom(payload) {
  return payload?.audio_endpoint !== 'browser';
}

export function buildAtomAudioPostHeaders(payload = {}, authToken = '') {
  const headers = {
    'content-type':
      typeof payload.mime_type === 'string' && payload.mime_type.trim() !== ''
        ? payload.mime_type.trim()
        : 'audio/wav'
  };
  if (typeof authToken === 'string' && authToken !== '') {
    headers['x-headroom-auth'] = authToken;
  }
  if (typeof payload.utterance_id === 'string' && payload.utterance_id !== '') {
    headers['x-utterance-id'] = payload.utterance_id;
  }
  if (Number.isInteger(payload.generation)) {
    headers['x-generation'] = String(payload.generation);
  }
  if (typeof payload.audio_id === 'string' && payload.audio_id.trim() !== '') {
    headers['x-audio-id'] = payload.audio_id.trim();
  }
  if (typeof payload.audio_codec === 'string' && payload.audio_codec.trim() !== '') {
    headers['x-audio-codec'] = payload.audio_codec.trim();
  }
  return headers;
}

export function websocketServiceEndpointMatches(left, right) {
  try {
    const first = new URL(left);
    const second = new URL(right);
    if (!['ws:', 'wss:'].includes(first.protocol) || !['ws:', 'wss:'].includes(second.protocol)) {
      return false;
    }
    const firstPort = first.port || (first.protocol === 'wss:' ? '443' : '80');
    const secondPort = second.port || (second.protocol === 'wss:' ? '443' : '80');
    const normalizePath = (value) => {
      const normalized = value.replace(/\/+$/u, '');
      return normalized || '/';
    };
    // The bridge normally reaches the same PC service through loopback while
    // Atom uses a LAN/Tailscale address, so hostnames intentionally differ.
    return firstPort === secondPort
      && normalizePath(first.pathname) === normalizePath(second.pathname);
  } catch {
    return false;
  }
}

export function buildAtomEndpointState({
  connected,
  audioInput = false,
  health = null,
  deviceId = null,
  reason = null,
  now = Date.now
} = {}) {
  const isConnected = connected === true;
  const advertisedCodecs = Array.isArray(health?.playback_codecs)
    ? [...new Set(health.playback_codecs.filter((codec) => KNOWN_PLAYBACK_CODECS.has(codec)))]
    : [];
  const speakerVolume = Number.isInteger(health?.speaker_volume)
    && health.speaker_volume >= 0
    && health.speaker_volume <= MAX_ATOM_SPEAKER_VOLUME
    ? health.speaker_volume
    : null;
  return {
    v: 1,
    type: 'atom_endpoint_state',
    connected: isConnected,
    device_id: health?.device_id ?? deviceId ?? null,
    audio_input: isConnected && audioInput === true,
    audio_output: isConnected,
    playback_codecs: advertisedCodecs.length > 0 ? advertisedCodecs : ['pcm16_wav'],
    speaker_volume: speakerVolume,
    volume_control: isConnected && speakerVolume !== null,
    reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null,
    ts: now()
  };
}

export function parseAtomVolumeSet(payload, expectedDeviceId = null) {
  const requestId =
    typeof payload?.request_id === 'string' && payload.request_id.trim() !== ''
      ? payload.request_id.trim()
      : null;
  const volume = payload?.volume;
  if (
    !requestId
    || !Number.isInteger(volume)
    || volume < 0
    || volume > MAX_ATOM_SPEAKER_VOLUME
  ) {
    return {
      ok: false,
      requestId,
      error: 'invalid_atom_volume'
    };
  }
  const requestedDeviceId =
    typeof payload?.device_id === 'string' && payload.device_id.trim() !== ''
      ? payload.device_id.trim()
      : null;
  if (
    requestedDeviceId
    && expectedDeviceId
    && requestedDeviceId !== expectedDeviceId
  ) {
    return {
      ok: false,
      requestId,
      error: 'atom_device_mismatch'
    };
  }
  return {
    ok: true,
    requestId,
    volume
  };
}

export function buildAtomVolumeResult({
  requestId,
  deviceId,
  ok,
  speakerVolume = null,
  error = null,
  now = Date.now
} = {}) {
  return {
    v: 1,
    type: 'atom_volume_result',
    request_id: requestId ?? null,
    device_id: deviceId ?? null,
    ok: ok === true,
    speaker_volume:
      Number.isInteger(speakerVolume)
      && speakerVolume >= 0
      && speakerVolume <= MAX_ATOM_SPEAKER_VOLUME
        ? speakerVolume
        : null,
    error: typeof error === 'string' && error !== '' ? error : null,
    persistent: false,
    ts: now()
  };
}
