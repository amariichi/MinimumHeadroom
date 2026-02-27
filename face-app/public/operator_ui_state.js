function ensureState(state) {
  if (!state || typeof state !== 'object') {
    return createInitialOperatorUiState();
  }
  return state;
}

export function createInitialOperatorUiState() {
  return {
    panelOpen: true,
    awaiting: false,
    bridgeOnline: false,
    recoveryMode: false,
    noResponse: false,
    activeRequestId: null,
    activePrompt: null,
    showMirror: false
  };
}

export function reduceOperatorUiState(inputState, action) {
  const state = ensureState(inputState);
  if (!action || typeof action !== 'object') {
    return state;
  }

  switch (action.type) {
    case 'socket_open':
      return {
        ...state,
        bridgeOnline: true
      };
    case 'socket_close':
      return {
        ...state,
        bridgeOnline: false
      };
    case 'operator_state':
      return {
        ...state,
        bridgeOnline: action.bridgeOnline ?? state.bridgeOnline,
        recoveryMode: action.recoveryMode ?? state.recoveryMode,
        noResponse: action.noResponse ?? state.noResponse,
        awaiting: action.awaiting ?? state.awaiting,
        activeRequestId: action.requestId ?? state.activeRequestId
      };
    case 'prompt_received':
      return {
        ...state,
        panelOpen: true,
        awaiting: true,
        activeRequestId: action.requestId ?? state.activeRequestId,
        activePrompt: action.prompt ?? state.activePrompt
      };
    case 'clear_prompt':
      return {
        ...state,
        awaiting: false,
        activeRequestId: null,
        activePrompt: null
      };
    case 'ack_received': {
      if (!(action.ok === true && action.stage === 'sent_to_tmux')) {
        return state;
      }
      if (state.activeRequestId && action.requestId && state.activeRequestId !== action.requestId) {
        return state;
      }
      return {
        ...state,
        panelOpen: false,
        awaiting: false,
        activeRequestId: null,
        activePrompt: null
      };
    }
    case 'panel_open':
      return {
        ...state,
        panelOpen: true
      };
    case 'panel_close':
      return {
        ...state,
        panelOpen: false
      };
    case 'mirror_toggle':
      return {
        ...state,
        showMirror: !state.showMirror
      };
    default:
      return state;
  }
}

export function deriveOperatorUiFlags(inputState) {
  const state = ensureState(inputState);
  return {
    showEsc: true,
    showPanel: state.panelOpen,
    showHandle: !state.panelOpen,
    showClose: state.awaiting,
    showRestart: !state.bridgeOnline || state.recoveryMode || state.noResponse,
    showMirror: state.showMirror
  };
}
