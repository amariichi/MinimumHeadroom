import { createInterpreterAudioPlayer } from './interpreter_audio.js';
import { setupRuntimeModeUi } from './runtime_mode_ui.js';

const elements = {
  anchorLanguage: document.querySelector('#anchor-language'),
  audioEndpoint: document.querySelector('#audio-endpoint'),
  connectionDot: document.querySelector('#connection-dot'),
  connectionLabel: document.querySelector('#connection-label'),
  controlHint: document.querySelector('#control-hint'),
  pairAnchorSelect: document.querySelector('#pair-anchor-select'),
  pairApply: document.querySelector('#pair-apply'),
  pairCancel: document.querySelector('#pair-cancel'),
  pairDialog: document.querySelector('#pair-dialog'),
  pairDialogClose: document.querySelector('#pair-dialog-close'),
  pairDialogStatus: document.querySelector('#pair-dialog-status'),
  pairForm: document.querySelector('#pair-form'),
  pairPartnerSelect: document.querySelector('#pair-partner-select'),
  pairTrigger: document.querySelector('#pair-trigger'),
  partnerLanguage: document.querySelector('#partner-language'),
  providerLabel: document.querySelector('#provider-label'),
  replayButton: document.querySelector('#replay-button'),
  resetButton: document.querySelector('#reset-button'),
  sourceLanguage: document.querySelector('#source-language'),
  statusLine: document.querySelector('#status-line'),
  talkButton: document.querySelector('#talk-button'),
  talkButtonLabel: document.querySelector('#talk-button-label'),
  targetLanguage: document.querySelector('#target-language'),
  transcript: document.querySelector('#transcript'),
  translation: document.querySelector('#translation'),
  volumeClose: document.querySelector('#volume-close'),
  volumeDialog: document.querySelector('#volume-dialog'),
  volumeSlider: document.querySelector('#volume-slider'),
  volumeStatus: document.querySelector('#volume-status'),
  volumeTrigger: document.querySelector('#volume-trigger'),
  volumeTriggerValue: document.querySelector('#volume-trigger-value'),
  volumeValue: document.querySelector('#volume-value'),
  volumeWarning: document.querySelector('#volume-warning')
};

const SESSION_STORAGE_KEY = 'mh-interpreter-session-id-v1';
const MAX_ATOM_SPEAKER_VOLUME = 200;
const state = {
  atom: {
    connected: false,
    deviceId: null,
    devices: [],
    sessionId: null,
    speakerVolume: null,
    volumeControl: false
  },
  browserSessionId: loadBrowserSessionId(),
  busy: false,
  manualPairLanguages: [],
  pair: {
    anchorLanguage: null,
    partnerLanguage: null
  },
  pairRequestInFlight: false,
  pairRevision: -1,
  pairSessionId: null,
  recording: null,
  sessionSyncInFlight: null,
  sessionSyncPending: false,
  turnActivityRevision: 0,
  turnInProgressId: null,
  turnInProgressSessionId: null,
  turnSessionId: null,
  volumeRequestInFlight: false,
  volumeRequestPending: null,
  websocket: null
};

const languageNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['en'], { type: 'language' })
  : null;

const audioPlayer = createInterpreterAudioPlayer({
  onBlocked(_error, payload) {
    if (!payload || state.atom.connected) {
      elements.replayButton.hidden = true;
      setDefaultStatus();
      return;
    }
    elements.replayButton.hidden = false;
    setStatus('Tap play to hear the last translation.', true);
  },
  onPlaying() {
    elements.replayButton.hidden = true;
    setStatus('Playing translation.');
  },
  onIdle() {
    if (!state.busy && !state.recording) {
      setDefaultStatus();
    }
  }
});
audioPlayer.installGestureUnlock();

function loadBrowserSessionId() {
  let existing = null;
  try {
    existing = localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {}
  if (existing) {
    return existing;
  }
  const created = globalThis.crypto?.randomUUID?.()
    ?? `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, created);
  } catch {}
  return created;
}

function nextTurnId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function activeSessionId() {
  return state.atom.connected && state.atom.sessionId
    ? state.atom.sessionId
    : state.browserSessionId;
}

function normalizedLanguageTag(tag) {
  if (typeof tag !== 'string') {
    return null;
  }
  const primary = tag.trim().toLowerCase().split('-')[0];
  return primary || null;
}

function languageName(tag, fallback = 'Waiting') {
  const primary = normalizedLanguageTag(tag);
  if (!primary) {
    return fallback;
  }
  try {
    return languageNames?.of(primary) ?? primary.toUpperCase();
  } catch {
    return primary.toUpperCase();
  }
}

function setConnection(kind, label) {
  elements.connectionDot.classList.toggle('is-online', kind === 'online');
  elements.connectionDot.classList.toggle('is-error', kind === 'error');
  elements.connectionLabel.textContent = label;
}

function setStatus(message, isError = false) {
  elements.statusLine.textContent = message;
  elements.statusLine.classList.toggle('is-error', isError);
}

function setDefaultStatus() {
  if (state.atom.connected) {
    setStatus('Atom is listening for the next speaker.');
  } else {
    setStatus('Hold the button while speaking.');
  }
}

function normalizedVolume(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_ATOM_SPEAKER_VOLUME
    ? parsed
    : null;
}

function renderVolume(value, { updateSlider = true } = {}) {
  const volume = normalizedVolume(value);
  if (volume === null) {
    return false;
  }
  elements.volumeTriggerValue.textContent = String(volume);
  elements.volumeValue.textContent = String(volume);
  if (updateSlider) {
    elements.volumeSlider.value = String(volume);
  }
  elements.volumeWarning.hidden = volume < MAX_ATOM_SPEAKER_VOLUME;
  return true;
}

function setVolumeStatus(message, isError = false) {
  elements.volumeStatus.textContent = message;
  elements.volumeStatus.classList.toggle('is-error', isError);
}

function closeVolumeDialog() {
  if (typeof elements.volumeDialog.close === 'function' && elements.volumeDialog.open) {
    elements.volumeDialog.close();
  } else {
    elements.volumeDialog.removeAttribute('open');
  }
  elements.volumeTrigger.setAttribute('aria-expanded', 'false');
}

function updateVolumeControl() {
  const available =
    state.atom.connected
    && state.atom.volumeControl
    && normalizedVolume(state.atom.speakerVolume) !== null;
  elements.volumeTrigger.hidden = !available;
  if (!available) {
    closeVolumeDialog();
    return;
  }
  renderVolume(state.atom.speakerVolume);
}

function updateAudioEndpoint(atom) {
  const wasConnected = state.atom.connected;
  state.atom.connected = atom?.connected === true;
  if (Array.isArray(atom?.devices)) {
    state.atom.devices = atom.devices;
    const selected =
      atom.devices.find((device) => (
        device?.volumeControl === true
        && normalizedVolume(device?.speakerVolume) !== null
      ))
      ?? atom.devices[0]
      ?? null;
    state.atom.deviceId = selected?.deviceId ?? null;
    state.atom.speakerVolume = normalizedVolume(selected?.speakerVolume);
    state.atom.volumeControl =
      selected?.volumeControl === true
      && state.atom.speakerVolume !== null;
  }
  state.atom.sessionId = atom?.sessionId
    ?? (state.atom.connected && atom?.devices?.[0]?.deviceId
      ? `atom:${atom.devices[0].deviceId}`
      : null);
  if (state.atom.connected && !wasConnected) {
    audioPlayer.interrupt();
  }
  elements.audioEndpoint.textContent = state.atom.connected
    ? 'Audio: Atom'
    : 'Audio: Phone';
  elements.talkButton.disabled = state.atom.connected || state.busy;
  elements.talkButtonLabel.textContent = state.atom.connected
    ? 'Listening on Atom'
    : state.busy
      ? 'Translating'
      : 'Hold to speak';
  elements.controlHint.textContent = state.atom.connected
    ? 'Speak naturally. Atom ends each turn after a short pause.'
    : 'Say “translate to Spanish” at any time to change the pair.';
  if (state.atom.connected) {
    elements.replayButton.hidden = true;
  }
  updateVolumeControl();
  setDefaultStatus();
}

function atomVolumeErrorMessage(code) {
  if (code === 'atom_not_connected' || code === 'atom_disconnected') {
    return 'Atom disconnected before the volume changed.';
  }
  if (code === 'atom_volume_unavailable') {
    return 'Volume control requires the updated Atom firmware.';
  }
  if (code === 'atom_volume_timeout') {
    return 'Atom did not confirm the volume change.';
  }
  return 'Could not change Atom volume.';
}

async function flushAtomVolumeQueue() {
  if (state.volumeRequestInFlight) {
    return;
  }
  while (
    state.volumeRequestPending !== null
    && state.atom.connected
    && state.atom.volumeControl
  ) {
    const requested = state.volumeRequestPending;
    state.volumeRequestPending = null;
    state.volumeRequestInFlight = true;
    setVolumeStatus(`Setting volume to ${requested}…`);
    try {
      const response = await fetch('/api/interpreter/atom/volume', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          ...(state.atom.deviceId ? { deviceId: state.atom.deviceId } : {}),
          volume: requested
        })
      });
      const payload = await response.json().catch(() => ({
        ok: false,
        error: 'invalid_response'
      }));
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error ?? `status_${response.status}`);
      }
      const confirmed = normalizedVolume(payload.speakerVolume);
      if (confirmed === null) {
        throw new Error('invalid_response');
      }
      state.atom.speakerVolume = confirmed;
      renderVolume(confirmed);
      setVolumeStatus(
        `Volume ${confirmed}. Temporary until Atom restarts.`
      );
    } catch (error) {
      renderVolume(state.atom.speakerVolume);
      setVolumeStatus(atomVolumeErrorMessage(error.message), true);
    } finally {
      state.volumeRequestInFlight = false;
    }
  }
}

function queueAtomVolume(value) {
  const volume = normalizedVolume(value);
  if (
    volume === null
    || !state.atom.connected
    || !state.atom.volumeControl
  ) {
    return false;
  }
  renderVolume(volume);
  state.volumeRequestPending = volume;
  void flushAtomVolumeQueue();
  return true;
}

function openVolumeDialog() {
  if (elements.volumeTrigger.hidden) {
    return;
  }
  renderVolume(state.atom.speakerVolume);
  setVolumeStatus('Changes are temporary and reset after Atom restarts.');
  elements.volumeTrigger.setAttribute('aria-expanded', 'true');
  if (typeof elements.volumeDialog.showModal === 'function') {
    elements.volumeDialog.showModal();
  } else {
    elements.volumeDialog.setAttribute('open', '');
  }
}

function setPairDialogStatus(message, isError = false) {
  elements.pairDialogStatus.textContent = message;
  elements.pairDialogStatus.classList.toggle('is-error', isError);
}

function pairLanguageEntries(values) {
  const languages = [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizedLanguageTag(value))
      .filter(Boolean)
  )];
  return languages
    .map((language) => ({
      language,
      label: languageName(language, language.toUpperCase())
    }))
    .sort((left, right) => (
      left.label.localeCompare(right.label, 'en', { sensitivity: 'base' })
    ));
}

function replacePairOptions(select, entries) {
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose language';
  select.replaceChildren(placeholder);
  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.language;
    option.textContent = entry.label;
    select.append(option);
  }
}

function selectedPair() {
  return {
    anchorLanguage: normalizedLanguageTag(elements.pairAnchorSelect.value),
    partnerLanguage: normalizedLanguageTag(elements.pairPartnerSelect.value)
  };
}

function validatePairSelection({ showIncomplete = false } = {}) {
  const pair = selectedPair();
  let message = '';
  let isError = false;
  if (!pair.anchorLanguage || !pair.partnerLanguage) {
    if (showIncomplete) {
      message = 'Choose two languages.';
    }
  } else if (pair.anchorLanguage === pair.partnerLanguage) {
    message = 'Choose two different languages.';
    isError = true;
  }
  const valid =
    Boolean(pair.anchorLanguage)
    && Boolean(pair.partnerLanguage)
    && pair.anchorLanguage !== pair.partnerLanguage;
  elements.pairApply.disabled = state.pairRequestInFlight || !valid;
  if (!state.pairRequestInFlight) {
    setPairDialogStatus(message, isError);
  }
  return valid ? pair : null;
}

function syncPairDialog() {
  const allowed = new Set(state.manualPairLanguages);
  elements.pairAnchorSelect.value = allowed.has(state.pair.anchorLanguage)
    ? state.pair.anchorLanguage
    : '';
  elements.pairPartnerSelect.value = allowed.has(state.pair.partnerLanguage)
    ? state.pair.partnerLanguage
    : !state.pair.anchorLanguage && allowed.has('en')
      ? 'en'
      : '';
  validatePairSelection();
}

function setManualPairLanguages(values) {
  const entries = pairLanguageEntries(values);
  state.manualPairLanguages = entries.map((entry) => entry.language);
  replacePairOptions(elements.pairAnchorSelect, entries);
  replacePairOptions(elements.pairPartnerSelect, entries);
  elements.pairTrigger.disabled = entries.length < 2;
  syncPairDialog();
}

function closePairDialog() {
  if (typeof elements.pairDialog.close === 'function' && elements.pairDialog.open) {
    elements.pairDialog.close();
  } else {
    elements.pairDialog.removeAttribute('open');
  }
  elements.pairTrigger.setAttribute('aria-expanded', 'false');
}

function openPairDialog() {
  if (elements.pairTrigger.disabled) {
    return;
  }
  syncPairDialog();
  elements.pairTrigger.setAttribute('aria-expanded', 'true');
  if (typeof elements.pairDialog.showModal === 'function') {
    elements.pairDialog.showModal();
  } else {
    elements.pairDialog.setAttribute('open', '');
  }
}

function pairRequestErrorMessage(code) {
  if (code === 'turn_in_progress') {
    return 'Wait for the current speech turn to finish.';
  }
  if (code === 'pair_languages_must_differ') {
    return 'Choose two different languages.';
  }
  if (code === 'unsupported_pair_language') {
    return 'This pair is not available in the current preset.';
  }
  if (code === 'anchor_language_required' || code === 'partner_language_required') {
    return 'Choose two languages.';
  }
  return 'Could not update the language pair.';
}

async function submitManualPair() {
  if (state.pairRequestInFlight) {
    return;
  }
  const pair = validatePairSelection({ showIncomplete: true });
  if (!pair) {
    return;
  }
  const sessionId = activeSessionId();
  state.pairRequestInFlight = true;
  elements.pairAnchorSelect.disabled = true;
  elements.pairPartnerSelect.disabled = true;
  elements.pairApply.disabled = true;
  setPairDialogStatus('Updating language pair…');
  let failureMessage = null;
  try {
    const response = await fetch('/api/interpreter/session/pair', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-interpreter-session-id': sessionId,
        'x-interpreter-turn-id': nextTurnId()
      },
      body: JSON.stringify(pair)
    });
    const payload = await response.json().catch(() => ({
      ok: false,
      error: 'invalid_response'
    }));
    if (!response.ok || payload.ok !== true || !payload.state) {
      throw new Error(payload.error ?? `status_${response.status}`);
    }
    if (sessionId === activeSessionId()) {
      updatePair(payload.state, { sessionId });
    } else {
      await loadSessionState();
    }
    closePairDialog();
    setStatus(
      payload.pairAnnouncement?.reason === 'pair_unchanged'
        ? 'Language pair is already active.'
        : 'Language pair updated.'
    );
  } catch (error) {
    failureMessage = pairRequestErrorMessage(error.message);
  } finally {
    state.pairRequestInFlight = false;
    elements.pairAnchorSelect.disabled = false;
    elements.pairPartnerSelect.disabled = false;
    validatePairSelection();
    if (failureMessage) {
      setPairDialogStatus(failureMessage, true);
    }
  }
}

function updatePair(pair = {}, { sessionId = activeSessionId() } = {}) {
  const revision = Number.isInteger(pair.revision)
    ? Math.max(0, pair.revision)
    : null;
  if (
    state.pairSessionId === sessionId
    && revision !== null
    && revision < state.pairRevision
  ) {
    return false;
  }
  state.pairSessionId = sessionId;
  if (revision !== null) {
    state.pairRevision = revision;
  }
  state.pair.anchorLanguage = normalizedLanguageTag(pair.anchorLanguage);
  state.pair.partnerLanguage = normalizedLanguageTag(pair.partnerLanguage);
  elements.anchorLanguage.textContent = languageName(state.pair.anchorLanguage);
  elements.partnerLanguage.textContent = languageName(
    state.pair.partnerLanguage,
    state.pair.anchorLanguage ? 'Waiting' : 'English'
  );
  if (elements.pairDialog.open) {
    syncPairDialog();
  }
  return true;
}

function setText(element, value, placeholder) {
  const text = typeof value === 'string' ? value.trim() : '';
  element.textContent = text || placeholder;
  element.classList.toggle('muted', !text);
}

function updateTurn(payload, { sessionId = activeSessionId() } = {}) {
  state.turnActivityRevision += 1;
  state.turnSessionId = sessionId;
  const turnId = payloadTurnId(payload);
  if (
    turnId
    && state.turnInProgressSessionId === sessionId
    && state.turnInProgressId === turnId
  ) {
    state.turnInProgressId = null;
    state.turnInProgressSessionId = null;
  }
  if (payload.transcript !== undefined) {
    setText(elements.transcript, payload.transcript, 'No speech detected.');
  }
  if (payload.translation !== undefined) {
    setText(
      elements.translation,
      payload.translation,
      payload.commandOnly
        ? 'Language pair updated.'
        : 'Waiting for a target language.'
    );
  }
  if (payload.sourceLanguage) {
    elements.sourceLanguage.textContent = languageName(payload.sourceLanguage, '—');
  }
  elements.targetLanguage.textContent = payload.targetLanguage
    ? languageName(payload.targetLanguage, '—')
    : '—';
  if (payload.state) {
    updatePair(payload.state, { sessionId });
  }
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  if (payload.tts?.status === 'unsupported') {
    setStatus(
      payload.tts?.purpose === 'target_language_prompt'
        ? 'Say a target language for this conversation.'
        : 'Translation is ready. Speech is unavailable for this language.'
    );
  } else if (payload.tts?.status === 'failed') {
    setStatus(
      payload.tts?.purpose === 'target_language_prompt'
        ? 'Target-language question could not be played.'
        : 'Translation is ready, but speech playback failed.',
      true
    );
  } else if (warnings.includes('target_required')) {
    setStatus('Say a target language for this conversation.');
  } else if (warnings.includes('language_uncertain')) {
    setStatus('Language was uncertain. Please speak a little longer.');
  } else if (payload.translation) {
    setStatus(`Translated to ${languageName(payload.targetLanguage)}.`);
  }
}

function clearTurn({ sessionId = activeSessionId() } = {}) {
  state.turnActivityRevision += 1;
  state.turnSessionId = sessionId;
  if (state.turnInProgressSessionId === sessionId) {
    state.turnInProgressId = null;
    state.turnInProgressSessionId = null;
  }
  elements.sourceLanguage.textContent = '—';
  elements.targetLanguage.textContent = '—';
  setText(elements.transcript, '', 'Speak to begin.');
  setText(elements.translation, '', 'The first target is English.');
}

function payloadSessionId(payload) {
  return payload?.sessionId ?? payload?.session_id ?? null;
}

function payloadTurnId(payload) {
  return payload?.turnId ?? payload?.turn_id ?? null;
}

function isVisibleSession(payload) {
  const sessionId = payloadSessionId(payload);
  if (!sessionId) {
    return true;
  }
  return sessionId === activeSessionId();
}

function handleWebSocketPayload(payload) {
  if (payload?.type === 'interpreter_audio_endpoint_changed') {
    const previousSessionId = activeSessionId();
    updateAudioEndpoint(payload.atom);
    if (activeSessionId() !== previousSessionId) {
      loadSessionState().catch((error) => {
        setStatus(`Could not sync language pair: ${error.message}.`, true);
      });
    }
    return;
  }
  if (!isVisibleSession(payload)) {
    return;
  }
  if (
    payload?.type === 'interpreter_turn_started'
    || payload?.type === 'interpreter_transcript'
    || payload?.type === 'interpreter_target_prompt'
    || payload?.type === 'interpreter_translation'
    || payload?.type === 'interpreter_turn_failed'
    || payload?.type === 'interpreter_turn_ignored'
    || payload?.type === 'interpreter_turn_completed'
  ) {
    const sessionId = payloadSessionId(payload) ?? activeSessionId();
    const turnId = payloadTurnId(payload);
    state.turnActivityRevision += 1;
    state.turnSessionId = sessionId;
    if (
      payload?.type === 'interpreter_turn_failed'
      || payload?.type === 'interpreter_turn_ignored'
      || payload?.type === 'interpreter_turn_completed'
    ) {
      if (
        state.turnInProgressSessionId === sessionId
        && (!turnId || state.turnInProgressId === turnId)
      ) {
        state.turnInProgressId = null;
        state.turnInProgressSessionId = null;
      }
    } else if (turnId) {
      state.turnInProgressId = turnId;
      state.turnInProgressSessionId = sessionId;
    }
  }
  audioPlayer.handlePayload(payload);
  if (payload?.type === 'interpreter_turn_started') {
    setStatus('Understanding speech.');
  } else if (payload?.type === 'interpreter_transcript') {
    setText(elements.transcript, payload.transcript, 'No speech detected.');
    elements.sourceLanguage.textContent = languageName(payload.sourceLanguage, '—');
    setStatus('Translating.');
  } else if (payload?.type === 'interpreter_target_prompt') {
    setStatus(
      payload.tts?.status === 'failed'
        ? 'Target-language question could not be played.'
        : 'Say a target language for this conversation.',
      payload.tts?.status === 'failed'
    );
  } else if (payload?.type === 'interpreter_translation') {
    setText(elements.translation, payload.translation, 'No translation.');
    elements.targetLanguage.textContent = languageName(payload.targetLanguage, '—');
  } else if (payload?.type === 'interpreter_state_changed') {
    updatePair(payload.state, {
      sessionId: payloadSessionId(payload) ?? activeSessionId()
    });
  } else if (payload?.type === 'interpreter_turn_failed') {
    setStatus(`Translation failed at ${payload.stage ?? 'the current step'}.`, true);
  } else if (payload?.type === 'interpreter_turn_ignored') {
    setStatus('Speech was unclear. Please try again.');
  } else if (payload?.type === 'interpreter_tts_failed') {
    setStatus(
      payload.purpose === 'target_language_prompt'
        ? 'Target-language question could not be played.'
        : 'Translation is ready, but speech playback failed.',
      true
    );
  } else if (payload?.type === 'interpreter_tts_unsupported') {
    setStatus(
      payload.purpose === 'target_language_prompt'
        ? 'Say a target language for this conversation.'
        : 'Translation is ready. Speech is unavailable for this language.'
    );
  }
}

function websocketUrl() {
  const url = new URL(window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function connectWebSocket() {
  const socket = new WebSocket(websocketUrl());
  state.websocket = socket;
  socket.addEventListener('open', () => {
    setConnection('online', 'Connected');
    void scheduleSessionSync();
  });
  socket.addEventListener('message', (event) => {
    try {
      handleWebSocketPayload(JSON.parse(event.data));
    } catch {}
  });
  socket.addEventListener('close', () => {
    if (state.websocket === socket) {
      setConnection('error', 'Reconnecting');
      window.setTimeout(connectWebSocket, 1200);
    }
  });
  socket.addEventListener('error', () => setConnection('error', 'Connection issue'));
}

async function loadSessionState() {
  const sessionId = activeSessionId();
  const turnActivityRevision = state.turnActivityRevision;
  const response = await fetch('/api/interpreter/session', {
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'x-interpreter-session-id': sessionId
    }
  });
  const payload = await response.json().catch(() => ({
    ok: false,
    error: 'invalid_response'
  }));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `status_${response.status}`);
  }
  if (sessionId !== activeSessionId()) {
    return false;
  }
  const pairUpdated = updatePair(payload.state, { sessionId });
  const snapshotTurnId = payloadTurnId(payload.latestTurn);
  const hasNewerInProgressTurn = Boolean(
    state.turnInProgressSessionId === sessionId
    && state.turnInProgressId
    && state.turnInProgressId !== snapshotTurnId
  );
  if (
    turnActivityRevision === state.turnActivityRevision
    && !hasNewerInProgressTurn
  ) {
    if (payload.latestTurn) {
      updateTurn(payload.latestTurn, { sessionId });
    } else {
      clearTurn({ sessionId });
    }
  }
  return pairUpdated;
}

function scheduleSessionSync() {
  state.sessionSyncPending = true;
  if (state.sessionSyncInFlight) {
    return state.sessionSyncInFlight;
  }
  state.sessionSyncInFlight = (async () => {
    while (state.sessionSyncPending) {
      state.sessionSyncPending = false;
      await loadSessionState();
    }
  })()
    .catch((error) => {
      setStatus(`Could not refresh this conversation: ${error.message}.`, true);
    })
    .finally(() => {
      state.sessionSyncInFlight = null;
      if (state.sessionSyncPending) {
        void scheduleSessionSync();
      }
    });
  return state.sessionSyncInFlight;
}

async function loadConfig() {
  const response = await fetch('/api/interpreter/config', {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`config status ${response.status}`);
  }
  const config = await response.json();
  elements.providerLabel.textContent = config.preset ?? 'Interpreter';
  setManualPairLanguages(config.manualPairLanguages);
  updateAudioEndpoint(config.atom);
  await loadSessionState();
}

function floatToPcm16(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
  }
  return pcm;
}

function resample(samples, sourceRate, targetRate = 16000) {
  if (sourceRate === targetRate) {
    return samples;
  }
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.max(1, Math.floor(samples.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const sourcePosition = index * ratio;
    const left = Math.floor(sourcePosition);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = sourcePosition - left;
    output[index] = samples[left] * (1 - fraction) + samples[right] * fraction;
  }
  return output;
}

function encodeWav(pcm, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

async function startRecording() {
  if (state.recording || state.busy || state.atom.connected) {
    return;
  }
  await audioPlayer.unlock();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;
  const context = new AudioContextClass();
  await context.resume();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const sink = context.createGain();
  sink.gain.value = 0;
  const chunks = [];
  processor.addEventListener('audioprocess', (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  });
  source.connect(processor);
  processor.connect(sink);
  sink.connect(context.destination);
  state.recording = {
    chunks,
    context,
    processor,
    sink,
    source,
    stream,
    startedAt: performance.now()
  };
  elements.talkButton.classList.add('is-recording');
  elements.talkButtonLabel.textContent = 'Release to translate';
  setStatus('Listening.');
}

async function stopRecording({ discard = false } = {}) {
  const recording = state.recording;
  if (!recording) {
    return;
  }
  state.recording = null;
  recording.processor.disconnect();
  recording.source.disconnect();
  recording.sink.disconnect();
  recording.stream.getTracks().forEach((track) => track.stop());
  const sourceRate = recording.context.sampleRate;
  await recording.context.close();
  elements.talkButton.classList.remove('is-recording');
  elements.talkButtonLabel.textContent = 'Hold to speak';
  if (discard) {
    setDefaultStatus();
    return;
  }
  const totalLength = recording.chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of recording.chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const samples = resample(merged, sourceRate);
  if (samples.length < 4000) {
    setStatus('That was too short. Hold the button a little longer.', true);
    return;
  }
  await submitTurn(encodeWav(floatToPcm16(samples)));
}

async function submitTurn(wav) {
  state.busy = true;
  elements.talkButton.disabled = true;
  elements.talkButtonLabel.textContent = 'Translating';
  setStatus('Understanding speech.');
  try {
    const response = await fetch('/api/interpreter/turn', {
      method: 'POST',
      headers: {
        'content-type': 'audio/wav',
        'x-interpreter-session-id': state.browserSessionId,
        'x-interpreter-turn-id': nextTurnId()
      },
      body: wav
    });
    const payload = await response.json().catch(() => ({ ok: false, error: 'invalid_response' }));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error ?? `status_${response.status}`);
    }
    updateTurn(payload, { sessionId: state.browserSessionId });
  } catch (error) {
    setStatus(`Could not translate: ${error.message}.`, true);
  } finally {
    state.busy = false;
    elements.talkButton.disabled = state.atom.connected;
    elements.talkButtonLabel.textContent = state.atom.connected
      ? 'Listening on Atom'
      : 'Hold to speak';
    setDefaultStatus();
  }
}

async function resetPair() {
  if (state.busy) {
    return;
  }
  const turnId = nextTurnId();
  try {
    const response = await fetch('/api/interpreter/session/reset', {
      method: 'POST',
      headers: {
        'x-interpreter-session-id': activeSessionId(),
        'x-interpreter-turn-id': turnId
      }
    });
    if (!response.ok) {
      throw new Error(`status_${response.status}`);
    }
    const payload = await response.json().catch(() => ({
      ok: false,
      error: 'invalid_response'
    }));
    if (payload.ok === false || !payload.state) {
      throw new Error(payload.error ?? 'invalid_response');
    }
    updatePair(payload.state, { sessionId: activeSessionId() });
    clearTurn({ sessionId: activeSessionId() });
    setStatus('Language pair reset.');
  } catch (error) {
    setStatus(`Could not reset: ${error.message}.`, true);
  }
}

elements.talkButton.addEventListener('pointerdown', (event) => {
  if (elements.talkButton.disabled) {
    return;
  }
  elements.talkButton.setPointerCapture?.(event.pointerId);
  startRecording().catch((error) => {
    setStatus(`Microphone unavailable: ${error.message}.`, true);
  });
});
elements.talkButton.addEventListener('pointerup', () => {
  stopRecording().catch((error) => setStatus(error.message, true));
});
elements.talkButton.addEventListener('pointercancel', () => {
  stopRecording({ discard: true }).catch(() => {});
});
elements.talkButton.addEventListener('keydown', (event) => {
  if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
    event.preventDefault();
    startRecording().catch((error) => setStatus(error.message, true));
  }
});
elements.talkButton.addEventListener('keyup', (event) => {
  if (event.key === ' ' || event.key === 'Enter') {
    event.preventDefault();
    stopRecording().catch((error) => setStatus(error.message, true));
  }
});
elements.resetButton.addEventListener('click', () => void resetPair());
elements.replayButton.addEventListener('click', async () => {
  if (!await audioPlayer.replayLast()) {
    elements.replayButton.hidden = true;
    setDefaultStatus();
  }
});
elements.pairTrigger.addEventListener('click', openPairDialog);
elements.pairDialogClose.addEventListener('click', closePairDialog);
elements.pairCancel.addEventListener('click', closePairDialog);
elements.pairForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitManualPair();
});
elements.pairAnchorSelect.addEventListener('change', () => {
  validatePairSelection({ showIncomplete: true });
});
elements.pairPartnerSelect.addEventListener('change', () => {
  validatePairSelection({ showIncomplete: true });
});
elements.pairDialog.addEventListener('close', () => {
  elements.pairTrigger.setAttribute('aria-expanded', 'false');
});
elements.pairDialog.addEventListener('click', (event) => {
  if (event.target === elements.pairDialog) {
    closePairDialog();
  }
});
elements.volumeTrigger.addEventListener('click', openVolumeDialog);
elements.volumeClose.addEventListener('click', closeVolumeDialog);
elements.volumeDialog.addEventListener('close', () => {
  elements.volumeTrigger.setAttribute('aria-expanded', 'false');
  renderVolume(state.atom.speakerVolume);
});
elements.volumeDialog.addEventListener('click', (event) => {
  if (event.target === elements.volumeDialog) {
    closeVolumeDialog();
  }
});
elements.volumeSlider.addEventListener('input', () => {
  renderVolume(elements.volumeSlider.value, { updateSlider: false });
  setVolumeStatus(`Release to set volume ${elements.volumeSlider.value}.`);
});
elements.volumeSlider.addEventListener('change', () => {
  queueAtomVolume(elements.volumeSlider.value);
});
for (const button of document.querySelectorAll('[data-volume-delta]')) {
  button.addEventListener('click', () => {
    const current = normalizedVolume(elements.volumeSlider.value) ?? 0;
    const delta = Number(button.dataset.volumeDelta);
    queueAtomVolume(Math.max(0, Math.min(MAX_ATOM_SPEAKER_VOLUME, current + delta)));
  });
}
for (const button of document.querySelectorAll('[data-volume-preset]')) {
  button.addEventListener('click', () => {
    queueAtomVolume(button.dataset.volumePreset);
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void scheduleSessionSync();
  }
});
window.addEventListener('pageshow', () => void scheduleSessionSync());
window.addEventListener('focus', () => void scheduleSessionSync());
window.addEventListener('online', () => void scheduleSessionSync());

setConnection('pending', 'Connecting');
setupRuntimeModeUi();
connectWebSocket();
loadConfig().catch((error) => {
  setConnection('error', 'Configuration issue');
  setStatus(`Could not load interpreter: ${error.message}.`, true);
});
