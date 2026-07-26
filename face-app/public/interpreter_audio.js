function audioKey(payload) {
  return [
    payload?.generation ?? '',
    payload?.utterance_id ?? '',
    payload?.message_id ?? '',
    payload?.revision ?? ''
  ].join(':');
}

const SILENT_WAV_SAMPLE_RATE = 24_000;
const SILENT_WAV_DURATION_MS = 60;
const UNLOCK_TIMEOUT_MS = 1_200;

function configureAudioElement(player) {
  player.preload = 'auto';
  player.playsInline = true;
  player.setAttribute?.('playsinline', 'true');
  player.setAttribute?.('webkit-playsinline', 'true');
  player.volume = 1;
  return player;
}

export function createInterpreterSilentWavDataUrl() {
  const sampleCount = Math.max(
    1,
    Math.floor((SILENT_WAV_SAMPLE_RATE * SILENT_WAV_DURATION_MS) / 1000)
  );
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
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
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = globalThis.setTimeout(
        () => reject(new Error('audio unlock timeout')),
        timeoutMs
      );
    })
  ]).finally(() => {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
    }
  });
}

export function isBrowserInterpreterAudio(payload) {
  if (payload?.audio_endpoint !== 'browser') {
    return false;
  }
  if (payload.type === 'tts_audio') {
    return typeof payload.audio_base64 === 'string'
      && payload.audio_base64.trim() !== '';
  }
  return payload.type === 'tts_audio_ref'
    && payload.mime_type === 'audio/mpeg'
    && payload.audio_codec === 'mp3'
    && Number(payload.bitrate) === 128_000
    && typeof payload.url === 'string'
    && /^\/api\/tts\/audio\/[0-9a-fA-F-]+\.mp3$/.test(payload.url);
}

export function shouldInterruptInterpreterAudio(payload) {
  if (payload?.type !== 'tts_state') {
    return false;
  }
  return payload.phase === 'interrupt_requested'
    || payload.phase === 'interrupted'
    || payload.reason === 'barge_in';
}

function base64ToBlob(base64, mimeType) {
  const bytes = atob(base64);
  const data = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    data[index] = bytes.charCodeAt(index);
  }
  return new Blob([data], { type: mimeType || 'audio/wav' });
}

function playbackSource(payload) {
  if (payload.type === 'tts_audio_ref') {
    return {
      src: payload.url,
      release: null
    };
  }
  const objectUrl = URL.createObjectURL(
    base64ToBlob(payload.audio_base64, payload.mime_type)
  );
  return {
    src: objectUrl,
    release: () => URL.revokeObjectURL(objectUrl)
  };
}

export function createInterpreterAudioPlayer(options = {}) {
  const player = configureAudioElement(options.player ?? new Audio());
  const onBlocked = typeof options.onBlocked === 'function' ? options.onBlocked : () => {};
  const onPlaying = typeof options.onPlaying === 'function' ? options.onPlaying : () => {};
  const onIdle = typeof options.onIdle === 'function' ? options.onIdle : () => {};
  const queue = [];
  const seen = new Set();
  let unlockPlayer = options.unlockPlayer
    ? configureAudioElement(options.unlockPlayer)
    : null;
  let unlockInFlight = null;
  let releaseActiveSource = null;
  let playing = false;
  let lastPayload = null;
  let blockedPayload = null;
  let unlocked = false;

  function ensureUnlockPlayer() {
    if (!unlockPlayer) {
      unlockPlayer = configureAudioElement(new Audio());
    }
    return unlockPlayer;
  }

  function releaseActiveUrl() {
    if (releaseActiveSource) {
      releaseActiveSource();
      releaseActiveSource = null;
    }
  }

  async function unlock() {
    if (unlocked) {
      return true;
    }
    if (unlockInFlight) {
      return unlockInFlight;
    }
    const probe = ensureUnlockPlayer();
    const previousSource = probe.src;
    unlockInFlight = (async () => {
      try {
        probe.src = createInterpreterSilentWavDataUrl();
        probe.currentTime = 0;
        await withTimeout(Promise.resolve(probe.play()), UNLOCK_TIMEOUT_MS);
        unlocked = true;
        return true;
      } catch {
        return false;
      } finally {
        try {
          probe.pause();
        } catch {}
        try {
          probe.currentTime = 0;
        } catch {}
        if (previousSource) {
          probe.src = previousSource;
        } else {
          probe.removeAttribute?.('src');
          try {
            probe.load?.();
          } catch {}
        }
        unlockInFlight = null;
      }
    })();
    return unlockInFlight;
  }

  async function playNext() {
    if (playing || queue.length === 0) {
      if (!playing && queue.length === 0) {
        onIdle();
      }
      return;
    }
    const payload = queue.shift();
    lastPayload = payload;
    blockedPayload = null;
    releaseActiveUrl();
    const source = playbackSource(payload);
    releaseActiveSource = source.release;
    player.src = source.src;
    player.currentTime = 0;
    player.load?.();
    playing = true;
    try {
      await player.play();
      unlocked = true;
      onPlaying(payload);
    } catch (error) {
      playing = false;
      blockedPayload = payload;
      onBlocked(error, payload);
    }
  }

  player.addEventListener('ended', () => {
    playing = false;
    blockedPayload = null;
    releaseActiveUrl();
    void playNext();
  });
  player.addEventListener('error', () => {
    if (!playing || !lastPayload) {
      return;
    }
    playing = false;
    releaseActiveUrl();
    blockedPayload = lastPayload;
    onBlocked(new Error('audio playback failed'), lastPayload);
  });

  function interrupt() {
    queue.length = 0;
    try {
      player.pause();
    } catch {}
    try {
      player.currentTime = 0;
    } catch {}
    playing = false;
    lastPayload = null;
    blockedPayload = null;
    releaseActiveUrl();
    onIdle();
  }

  function handlePayload(payload) {
    if (shouldInterruptInterpreterAudio(payload)) {
      interrupt();
      return true;
    }
    if (!isBrowserInterpreterAudio(payload)) {
      return false;
    }
    const key = audioKey(payload);
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
    if (seen.size > 128) {
      seen.delete(seen.values().next().value);
    }
    queue.push(payload);
    void playNext();
    return true;
  }

  async function replayLast() {
    const payload = blockedPayload;
    if (!payload) {
      return false;
    }
    try {
      playing = true;
      player.currentTime = 0;
      await player.play();
      unlocked = true;
      blockedPayload = null;
      onPlaying(payload);
      return true;
    } catch {
      playing = false;
    }
    if (!await unlock()) {
      blockedPayload = payload;
      return false;
    }
    blockedPayload = null;
    queue.unshift(payload);
    void playNext();
    return true;
  }

  function installGestureUnlock(target = document) {
    const tryUnlock = () => {
      void unlock();
    };
    target.addEventListener('pointerdown', tryUnlock, { capture: true, passive: true });
    target.addEventListener('touchstart', tryUnlock, { capture: true, passive: true });
    target.addEventListener('touchend', tryUnlock, { capture: true, passive: true });
    target.addEventListener('click', tryUnlock, { capture: true, passive: true });
    target.addEventListener('keydown', tryUnlock, { capture: true });
    target.addEventListener('visibilitychange', () => {
      if (target.visibilityState === 'visible') {
        unlocked = false;
        void unlock();
      }
    });
  }

  return {
    handlePayload,
    installGestureUnlock,
    interrupt,
    replayLast,
    unlock,
    hasReplay() {
      return Boolean(blockedPayload);
    }
  };
}
