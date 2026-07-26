#!/usr/bin/env bash

MH_INTERPRETER_STACK_PANE_OPTION="@minimum_headroom_interpreter_stack_pane"
MH_INTERPRETER_SHELL_PANE_OPTION="@minimum_headroom_interpreter_shell_pane"

mh_interpreter_env_key_is_managed() {
  case "$1" in
    PATH|HOME|USER|SHELL|LANG|LC_*|TZ|\
    XDG_CACHE_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|\
    HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|\
    http_proxy|https_proxy|all_proxy|no_proxy|\
    SSL_CERT_FILE|REQUESTS_CA_BUNDLE|CUDA_VISIBLE_DEVICES|\
    HF_*|HUGGINGFACE_*|TRANSFORMERS_*|UV_*|\
    AGY_BIN|LLAMA_CPP_DIR|\
    ATOM_*|FACE_*|MH_*|INTERPRETER_*|GEMMA4_*|\
    NEMOTRON_ASR_*|SILERO_VAD_*|SUPERTONIC_*|QWEN3_TTS_*|TTS_*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

mh_sync_interpreter_tmux_environment() {
  local session_name="$1"
  local mode="${2:-merge}"
  local entry key

  case "$mode" in
    reset)
      # A new session may have copied stale interpreter settings from a tmux
      # server that predates this launch. Clear only managed keys before
      # applying the launcher's current environment.
      while IFS= read -r entry; do
        key="${entry%%=*}"
        key="${key#-}"
        [[ -n "$key" ]] || continue
        if mh_interpreter_env_key_is_managed "$key"; then
          tmux set-environment -u -t "$session_name" "$key"
        fi
      done < <(tmux show-environment -t "$session_name" 2>/dev/null || true)
      ;;
    merge)
      # Restarts preserve settings supplied only to the original one-shot
      # command, while current explicit/config values replace matching keys.
      ;;
    *)
      echo "[interpreter-tmux-env] unknown sync mode: ${mode}" >&2
      return 2
      ;;
  esac

  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    if mh_interpreter_env_key_is_managed "$key"; then
      tmux set-environment -t "$session_name" "$key" "${!key}"
    fi
  done < <(compgen -e | sort -u)
}
