#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/lib/env-defaults.sh"
source "$ROOT_DIR/scripts/lib/interpreter-tmux-env.sh"

MH_ENV_FILE="${MH_ENV_FILE:-$(mh_default_env_file)}"
export MH_ENV_FILE
mh_load_env_defaults "$MH_ENV_FILE"

SESSION_NAME="${MH_INTERPRETER_TMUX_SESSION:-interpreter}"
WINDOW_NAME="${MH_INTERPRETER_TMUX_WINDOW:-stack}"
PRESET="${INTERPRETER_PRESET:-gemma4-supertonic}"
PORT_RELEASE_WAIT_SECONDS="${MH_INTERPRETER_PORT_RELEASE_WAIT_SECONDS:-10}"

usage() {
  cat <<'EOF'
Usage: ./scripts/restart-interpreter-stack-in-place.sh [options]

Respawn only the right-hand interpreter stack pane in place. The left shell,
tmux window, and attached client remain intact.

Options:
  --preset <name>   gemma4-supertonic | gemma4-qwen3 |
                    nemotron-gemma4-supertonic | nemotron-gemma4-qwen3
  --session <name>  tmux session name (default: interpreter)
  --window <name>   tmux window name (default: stack)
  --host <host>     replace the interpreter UI bind host
  --port <port>     replace the interpreter UI port
  --gemma-mtp <mode>
                    off | on | auto
  --draft-tokens <n>
                    replace the Gemma MTP draft-token maximum
  --supertonic-voice <voice>
                    replace the Supertonic voice, for example F2
  -h, --help        show this help
EOF
}

while (($# > 0)); do
  case "$1" in
    --preset)
      [[ -n "${2:-}" ]] || { echo "[restart-interpreter-stack] --preset requires a value" >&2; exit 2; }
      PRESET="$2"
      shift 2
      ;;
    --session)
      [[ -n "${2:-}" ]] || { echo "[restart-interpreter-stack] --session requires a value" >&2; exit 2; }
      SESSION_NAME="$2"
      shift 2
      ;;
    --window)
      [[ -n "${2:-}" ]] || { echo "[restart-interpreter-stack] --window requires a value" >&2; exit 2; }
      WINDOW_NAME="$2"
      shift 2
      ;;
    --host)
      [[ -n "${2:-}" ]] || { echo "[restart-interpreter-stack] --host requires a value" >&2; exit 2; }
      export INTERPRETER_HOST="$2"
      shift 2
      ;;
    --port)
      [[ -n "${2:-}" ]] || { echo "[restart-interpreter-stack] --port requires a value" >&2; exit 2; }
      export INTERPRETER_PORT="$2"
      shift 2
      ;;
    --gemma-mtp)
      [[ -n "${2:-}" ]] || { echo "[restart-interpreter-stack] --gemma-mtp requires a value" >&2; exit 2; }
      export GEMMA4_MTP="$2"
      shift 2
      ;;
    --draft-tokens)
      [[ -n "${2:-}" ]] || { echo "[restart-interpreter-stack] --draft-tokens requires a value" >&2; exit 2; }
      export GEMMA4_INTERPRETER_DRAFT_TOKENS="$2"
      shift 2
      ;;
    --supertonic-voice)
      [[ -n "${2:-}" ]] || { echo "[restart-interpreter-stack] --supertonic-voice requires a value" >&2; exit 2; }
      export MH_SUPERTONIC_VOICE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[restart-interpreter-stack] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v tmux >/dev/null 2>&1 || {
  echo "[restart-interpreter-stack] tmux is required" >&2
  exit 2
}
if [[ -n "${INTERPRETER_PORT:-}" ]] \
  && { [[ ! "$INTERPRETER_PORT" =~ ^[0-9]+$ ]] \
    || ((10#$INTERPRETER_PORT < 1 || 10#$INTERPRETER_PORT > 65535)); }; then
  echo "[restart-interpreter-stack] interpreter port must be between 1 and 65535" >&2
  exit 2
fi
if [[ -n "${GEMMA4_MTP:-}" && ! "$GEMMA4_MTP" =~ ^(off|on|auto)$ ]]; then
  echo "[restart-interpreter-stack] --gemma-mtp must be off, on, or auto" >&2
  exit 2
fi
if [[ -n "${GEMMA4_INTERPRETER_DRAFT_TOKENS:-}" ]] \
  && { [[ ! "$GEMMA4_INTERPRETER_DRAFT_TOKENS" =~ ^[0-9]+$ ]] \
    || ((10#$GEMMA4_INTERPRETER_DRAFT_TOKENS < 1 || 10#$GEMMA4_INTERPRETER_DRAFT_TOKENS > 32)); }; then
  echo "[restart-interpreter-stack] draft tokens must be between 1 and 32" >&2
  exit 2
fi
tmux has-session -t "$SESSION_NAME" 2>/dev/null || {
  echo "[restart-interpreter-stack] session not found: ${SESSION_NAME}" >&2
  echo "[restart-interpreter-stack] use ./scripts/run-interpreter-once.sh first" >&2
  exit 2
}

WINDOW_TARGET="${SESSION_NAME}:${WINDOW_NAME}"
tmux list-panes -t "$WINDOW_TARGET" -F '#{pane_id}' >/dev/null 2>&1 || {
  echo "[restart-interpreter-stack] window not found: ${SESSION_NAME}:${WINDOW_NAME}" >&2
  exit 2
}
RUNTIME_ACTIVE_MODE="$(
  tmux show-option -wqv -t "$WINDOW_TARGET" \
    @minimum_headroom_runtime_mode 2>/dev/null || true
)"
if [[ "$RUNTIME_ACTIVE_MODE" == "operator" ]]; then
  echo "[restart-interpreter-stack] active runtime mode is ${RUNTIME_ACTIVE_MODE}; use the authenticated Mode dialog to switch first" >&2
  exit 2
fi

mapfile -t WINDOW_PANES < <(tmux list-panes -t "$WINDOW_TARGET" -F '#{pane_id}')
TARGET="$(
  tmux show-option -wqv -t "$WINDOW_TARGET" \
    "$MH_INTERPRETER_STACK_PANE_OPTION" 2>/dev/null || true
)"

if [[ -n "$TARGET" ]]; then
  target_found=0
  for pane_id in "${WINDOW_PANES[@]}"; do
    if [[ "$pane_id" == "$TARGET" ]]; then
      target_found=1
      break
    fi
  done
  if ((target_found == 0)); then
    echo "[restart-interpreter-stack] recorded stack pane is missing: ${TARGET}" >&2
    exit 2
  fi
elif ((${#WINDOW_PANES[@]} == 1)); then
  # Compatibility with interpreter sessions created by the older one-pane
  # launcher. A fresh start creates and records both panes.
  TARGET="${WINDOW_PANES[0]}"
else
  echo "[restart-interpreter-stack] stack pane marker is missing in ${WINDOW_TARGET}; no pane was restarted" >&2
  echo "[restart-interpreter-stack] stop the dedicated interpreter window, then run run-interpreter-once.sh" >&2
  exit 2
fi

SHELL_TARGET="$(
  tmux show-option -wqv -t "$WINDOW_TARGET" \
    "$MH_INTERPRETER_SHELL_PANE_OPTION" 2>/dev/null || true
)"
if [[ -z "$SHELL_TARGET" || "$SHELL_TARGET" == "$TARGET" ]]; then
  SHELL_TARGET=""
  for pane_id in "${WINDOW_PANES[@]}"; do
    if [[ "$pane_id" != "$TARGET" ]]; then
      SHELL_TARGET="$pane_id"
      break
    fi
  done
fi
HAS_RUNTIME_SHELL=1
if [[ -z "$SHELL_TARGET" ]]; then
  if ((${#WINDOW_PANES[@]} == 1)); then
    HAS_RUNTIME_SHELL=0
  else
    echo "[restart-interpreter-stack] shell pane marker is missing in ${WINDOW_TARGET}" >&2
    exit 2
  fi
fi
SHELL_CWD=""
if ((HAS_RUNTIME_SHELL == 1)); then
  SHELL_CWD="$(tmux display-message -p -t "$SHELL_TARGET" '#{pane_current_path}' 2>/dev/null || true)"
fi
RUNTIME_AGENT_REPO_ROOT="${SHELL_CWD:-$ROOT_DIR}"
if git -C "$RUNTIME_AGENT_REPO_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  RUNTIME_AGENT_REPO_ROOT="$(git -C "$RUNTIME_AGENT_REPO_ROOT" rev-parse --show-toplevel)"
fi

export INTERPRETER_PRESET="$PRESET"
export MH_RUNTIME_ACTIVE_MODE="interpreter"
export MH_RUNTIME_INTERPRETER_PRESET="$PRESET"
export MH_INTERPRETER_PORT_RELEASE_WAIT_SECONDS="$PORT_RELEASE_WAIT_SECONDS"
mh_sync_interpreter_tmux_environment "$SESSION_NAME" merge

tmux set-option -w -t "$WINDOW_TARGET" remain-on-exit on
tmux set-option -w -t "$WINDOW_TARGET" "$MH_INTERPRETER_STACK_PANE_OPTION" "$TARGET"
if ((HAS_RUNTIME_SHELL == 1)); then
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_shell_pane "$SHELL_TARGET"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_stack_pane "$TARGET"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_mode interpreter
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_operator_profile "${MH_RUNTIME_OPERATOR_PROFILE:-default}"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_interpreter_preset "$PRESET"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_bind_host "${INTERPRETER_HOST:-127.0.0.1}"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_bind_port "${INTERPRETER_PORT:-8765}"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_operator_ui_mode "${MH_RUNTIME_OPERATOR_UI_MODE:-${FACE_UI_MODE:-auto}}"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_operator_audio_target "${MH_RUNTIME_OPERATOR_AUDIO_TARGET:-${FACE_AUDIO_TARGET:-browser}}"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_operator_asr_device "${MH_RUNTIME_OPERATOR_ASR_DEVICE:-${MH_ASR_DEVICE:-cpu}}"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_operator_kokoro_voice "${MH_KOKORO_VOICE:-}"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_agent_repo_root "$RUNTIME_AGENT_REPO_ROOT"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_interpreter_mtp "${GEMMA4_MTP:-off}"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_interpreter_draft_tokens "${GEMMA4_INTERPRETER_DRAFT_TOKENS:-8}"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_interpreter_supertonic_voice "${MH_SUPERTONIC_VOICE:-F2}"
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_transition_state ready
  tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_transition_error ""
fi
STACK_COMMAND="exec ./scripts/run-interpreter-stack.sh --preset $(printf '%q' "$PRESET")"
tmux respawn-pane -k -c "$ROOT_DIR" -t "$TARGET" "$STACK_COMMAND"
echo "[restart-interpreter-stack] restarted ${TARGET} preset=${PRESET}"
