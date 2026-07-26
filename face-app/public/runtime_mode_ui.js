const LABELS = {
  operator: {
    default: 'Default · Kokoro',
    realtime: 'Realtime ASR · Kokoro',
    supertonic: 'Supertonic',
    'supertonic-realtime': 'Realtime ASR · Supertonic',
    qwen3: 'Qwen3-TTS',
    'qwen3-realtime': 'Realtime ASR · Qwen3-TTS'
  },
  interpreter: {
    'gemma4-supertonic': 'Gemma ASR · Gemma · Supertonic',
    'gemma4-qwen3': 'Gemma ASR · Gemma · Qwen3-TTS',
    'nemotron-gemma4-supertonic':
      'Nemotron ASR · Gemma · Supertonic',
    'nemotron-gemma4-qwen3':
      'Nemotron ASR · Gemma · Qwen3-TTS'
  }
};

const POLL_INTERVAL_MS = 750;
const POLL_TIMEOUT_MS = 390_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function setDialogStatus(elements, message, { error = false } = {}) {
  elements.status.textContent = message;
  elements.status.classList.toggle('is-error', error);
}

function selectionList(config, mode) {
  return mode === 'operator'
    ? config.operatorProfiles
    : config.interpreterPresets;
}

function selectedRecipe(config, mode) {
  if (config.mode === mode) {
    return config.selection;
  }
  return config.savedSelections?.[mode]
    ?? selectionList(config, mode)?.[0]
    ?? '';
}

function populateSelections(elements, config, mode) {
  elements.selection.replaceChildren();
  for (const value of selectionList(config, mode) ?? []) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = LABELS[mode]?.[value] ?? value;
    elements.selection.append(option);
  }
  elements.selection.value = selectedRecipe(config, mode);
}

function updateSubmitState(elements, config) {
  const sameTarget = elements.mode.value === config.mode
    && elements.selection.value === config.selection;
  const switching = config.transition?.state === 'switching';
  elements.submit.disabled = sameTarget || switching || !config.available;
  elements.mode.disabled = switching;
  elements.selection.disabled = switching;
  if (!config.available) {
    setDialogStatus(
      elements,
      'Mode switching is available in the two-pane tmux launcher only.',
      { error: true }
    );
  } else if (switching) {
    setDialogStatus(elements, 'Switching… You can leave this dialog open.');
  } else if (sameTarget) {
    setDialogStatus(elements, 'This backend is already active.');
  } else {
    setDialogStatus(
      elements,
      'The current backend stops before the selected backend starts.'
    );
  }
}

async function readRuntimeConfig(fetchImpl) {
  const response = await fetchImpl('/api/runtime/mode', {
    method: 'GET',
    cache: 'no-store'
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

async function pollSwitch({
  fetchImpl,
  elements,
  transitionId,
  targetMode,
  targetSelection
}) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let config;
    try {
      config = await readRuntimeConfig(fetchImpl);
    } catch {
      setDialogStatus(elements, 'Switching… Reconnecting to 8765.');
      continue;
    }
    const transition = config.transition ?? {};
    if (
      config.mode === targetMode
      && config.selection === targetSelection
      && transition.state === 'ready'
    ) {
      setDialogStatus(elements, 'Ready. Reloading…');
      window.location.reload();
      return;
    }
    if (
      transition.id === transitionId
      && transition.state === 'rolled_back'
    ) {
      elements.mode.disabled = false;
      elements.selection.disabled = false;
      elements.submit.disabled = false;
      setDialogStatus(
        elements,
        'The selected backend did not become ready. The previous mode was restored.',
        { error: true }
      );
      return;
    }
    if (
      transition.id === transitionId
      && transition.state === 'failed'
    ) {
      setDialogStatus(
        elements,
        'Switch failed. Use the local tmux launcher to recover.',
        { error: true }
      );
      return;
    }
  }
  setDialogStatus(
    elements,
    'The switch is taking longer than expected. Check the backend pane.',
    { error: true }
  );
}

export function setupRuntimeModeUi(options = {}) {
  const trigger = document.querySelector(
    '#runtime-mode-trigger, #operator-title.runtime-mode-trigger'
  );
  const dialog = document.querySelector('#runtime-mode-dialog');
  if (!trigger || !dialog) {
    return null;
  }
  const elements = {
    trigger,
    dialog,
    close: dialog.querySelector('#runtime-mode-close'),
    cancel: dialog.querySelector('#runtime-mode-cancel'),
    form: dialog.querySelector('#runtime-mode-form'),
    mode: dialog.querySelector('#runtime-mode-select'),
    selection: dialog.querySelector('#runtime-backend-select'),
    status: dialog.querySelector('#runtime-mode-status'),
    submit: dialog.querySelector('#runtime-mode-submit')
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  let config = null;

  async function refresh() {
    config = await readRuntimeConfig(fetchImpl);
    elements.mode.value = config.mode;
    populateSelections(elements, config, config.mode);
    updateSubmitState(elements, config);
    elements.trigger.dataset.runtimeAvailable = config.available
      ? 'true'
      : 'false';
    return config;
  }

  async function open() {
    elements.trigger.setAttribute('aria-expanded', 'true');
    dialog.showModal();
    setDialogStatus(elements, 'Loading runtime options…');
    try {
      await refresh();
    } catch (error) {
      elements.mode.disabled = true;
      elements.selection.disabled = true;
      elements.submit.disabled = true;
      setDialogStatus(
        elements,
        `Could not load runtime options: ${error.message}.`,
        { error: true }
      );
    }
  }

  function close() {
    if (dialog.open) {
      dialog.close();
    }
  }

  elements.trigger.addEventListener('click', () => void open());
  elements.close.addEventListener('click', close);
  elements.cancel.addEventListener('click', close);
  dialog.addEventListener('close', () => {
    elements.trigger.setAttribute('aria-expanded', 'false');
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      close();
    }
  });
  elements.mode.addEventListener('change', () => {
    if (!config) {
      return;
    }
    populateSelections(elements, config, elements.mode.value);
    updateSubmitState(elements, config);
  });
  elements.selection.addEventListener('change', () => {
    if (config) {
      updateSubmitState(elements, config);
    }
  });
  elements.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!config || elements.submit.disabled) {
      return;
    }
    const targetMode = elements.mode.value;
    const targetSelection = elements.selection.value;
    elements.mode.disabled = true;
    elements.selection.disabled = true;
    elements.submit.disabled = true;
    setDialogStatus(elements, `Switching to ${targetMode}…`);
    try {
      const response = await fetchImpl('/api/runtime/switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: targetMode,
          selection: targetSelection
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status !== 202 || payload.ok === false) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      void pollSwitch({
        fetchImpl,
        elements,
        transitionId: payload.transitionId,
        targetMode,
        targetSelection
      });
    } catch (error) {
      elements.mode.disabled = false;
      elements.selection.disabled = false;
      elements.submit.disabled = false;
      setDialogStatus(elements, `Could not start switch: ${error.message}.`, {
        error: true
      });
    }
  });

  void refresh().catch(() => {
    elements.trigger.dataset.runtimeAvailable = 'false';
  });
  return { open, close, refresh };
}
