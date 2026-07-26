export const RUNTIME_MODES = Object.freeze(['operator', 'interpreter']);

export const OPERATOR_PROFILES = Object.freeze([
  'default',
  'realtime',
  'supertonic',
  'supertonic-realtime',
  'qwen3',
  'qwen3-realtime'
]);

export const INTERPRETER_PRESETS = Object.freeze([
  'gemma4-supertonic',
  'gemma4-qwen3',
  'nemotron-gemma4-supertonic',
  'nemotron-gemma4-qwen3'
]);

export const RUNTIME_TMUX_OPTIONS = Object.freeze({
  shellPane: '@minimum_headroom_runtime_shell_pane',
  stackPane: '@minimum_headroom_runtime_stack_pane',
  activeMode: '@minimum_headroom_runtime_mode',
  operatorProfile: '@minimum_headroom_runtime_operator_profile',
  interpreterPreset: '@minimum_headroom_runtime_interpreter_preset',
  bindHost: '@minimum_headroom_runtime_bind_host',
  bindPort: '@minimum_headroom_runtime_bind_port',
  operatorUiMode: '@minimum_headroom_runtime_operator_ui_mode',
  operatorAudioTarget: '@minimum_headroom_runtime_operator_audio_target',
  operatorAsrDevice: '@minimum_headroom_runtime_operator_asr_device',
  operatorKokoroVoice: '@minimum_headroom_runtime_operator_kokoro_voice',
  agentRepoRoot: '@minimum_headroom_runtime_agent_repo_root',
  interpreterMtp: '@minimum_headroom_runtime_interpreter_mtp',
  interpreterDraftTokens: '@minimum_headroom_runtime_interpreter_draft_tokens',
  interpreterSupertonicVoice: '@minimum_headroom_runtime_interpreter_supertonic_voice',
  transitionId: '@minimum_headroom_runtime_transition_id',
  transitionState: '@minimum_headroom_runtime_transition_state',
  transitionTargetMode: '@minimum_headroom_runtime_transition_target_mode',
  transitionTargetSelection: '@minimum_headroom_runtime_transition_target_selection',
  transitionError: '@minimum_headroom_runtime_transition_error'
});

export function runtimeSelections(mode) {
  if (mode === 'operator') {
    return OPERATOR_PROFILES;
  }
  if (mode === 'interpreter') {
    return INTERPRETER_PRESETS;
  }
  return [];
}

export function isRuntimeMode(value) {
  return RUNTIME_MODES.includes(value);
}

export function isRuntimeSelection(mode, value) {
  return runtimeSelections(mode).includes(value);
}
