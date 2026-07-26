#!/usr/bin/env bash
set -euo pipefail

CALLER_DIR="$(pwd -P)"
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
SHELL_COMMAND="${MH_INTERPRETER_SHELL_CMD:-bash}"
SHELL_CWD="${MH_INTERPRETER_SHELL_CWD:-$CALLER_DIR}"
ATTACH=1

usage() {
  cat <<'EOF'
Usage: ./scripts/run-interpreter-once.sh [options]

Create one dedicated two-pane tmux session for the interpreter stack.
The left pane is an interactive shell and the right pane shows stack logs.

Options:
  --preset <name>       gemma4-supertonic | gemma4-qwen3 |
                        nemotron-gemma4-supertonic | nemotron-gemma4-qwen3
  --session <name>      tmux session name (default: interpreter)
  --window <name>       tmux window name (default: stack)
  --host <host>         interpreter UI bind host
  --port <port>         interpreter UI port
  --gemma-mtp <mode>    off | on | auto
  --draft-tokens <n>    Gemma MTP draft-token maximum
  --supertonic-voice <voice>
                         Supertonic voice, for example F2
  --shell-cmd <cmd>     left-pane command (default: bash)
  --shell-cwd <path>    left-pane directory (default: caller directory)
  --no-attach           start both panes in the background
  -h, --help            show this help

Use restart-interpreter-stack-in-place.sh when the session already exists.

Persistent defaults are read automatically from:
  ${MH_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/minimum-headroom.env}

An explicitly supplied environment value always wins over the file. For
example:
  ./scripts/run-interpreter-once.sh --preset gemma4-supertonic \
    --host 0.0.0.0 --port 8765 --gemma-mtp on --draft-tokens 8 \
    --supertonic-voice F2
EOF
}

resolve_shell_cwd() {
  local requested="$1"
  local resolved="$requested"

  if [[ "$requested" == \~/* ]]; then
    resolved="${HOME}/${requested#~/}"
  elif [[ "$requested" != /* ]]; then
    resolved="${CALLER_DIR}/${requested}"
  fi

  if [[ ! -d "$resolved" ]]; then
    echo "[run-interpreter-once] shell directory not found: ${requested}" >&2
    exit 2
  fi

  (
    cd "$resolved"
    pwd -P
  )
}

while (($# > 0)); do
  case "$1" in
    --preset)
      [[ -n "${2:-}" ]] || { echo "[run-interpreter-once] --preset requires a value" >&2; exit 2; }
      PRESET="$2"
      shift 2
      ;;
    --session)
      [[ -n "${2:-}" ]] || { echo "[run-interpreter-once] --session requires a value" >&2; exit 2; }
      SESSION_NAME="$2"
      shift 2
      ;;
    --window)
      [[ -n "${2:-}" ]] || { echo "[run-interpreter-once] --window requires a value" >&2; exit 2; }
      WINDOW_NAME="$2"
      shift 2
      ;;
    --host)
      [[ -n "${2:-}" ]] || { echo "[run-interpreter-once] --host requires a value" >&2; exit 2; }
      export INTERPRETER_HOST="$2"
      shift 2
      ;;
    --port)
      [[ -n "${2:-}" ]] || { echo "[run-interpreter-once] --port requires a value" >&2; exit 2; }
      export INTERPRETER_PORT="$2"
      shift 2
      ;;
    --gemma-mtp)
      [[ -n "${2:-}" ]] || { echo "[run-interpreter-once] --gemma-mtp requires a value" >&2; exit 2; }
      export GEMMA4_MTP="$2"
      shift 2
      ;;
    --draft-tokens)
      [[ -n "${2:-}" ]] || { echo "[run-interpreter-once] --draft-tokens requires a value" >&2; exit 2; }
      export GEMMA4_INTERPRETER_DRAFT_TOKENS="$2"
      shift 2
      ;;
    --supertonic-voice)
      [[ -n "${2:-}" ]] || { echo "[run-interpreter-once] --supertonic-voice requires a value" >&2; exit 2; }
      export MH_SUPERTONIC_VOICE="$2"
      shift 2
      ;;
    --shell-cmd)
      [[ -n "${2:-}" ]] || { echo "[run-interpreter-once] --shell-cmd requires a value" >&2; exit 2; }
      SHELL_COMMAND="$2"
      shift 2
      ;;
    --shell-cwd)
      [[ -n "${2:-}" ]] || { echo "[run-interpreter-once] --shell-cwd requires a value" >&2; exit 2; }
      SHELL_CWD="$2"
      shift 2
      ;;
    --no-attach)
      ATTACH=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[run-interpreter-once] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

SHELL_CWD="$(resolve_shell_cwd "$SHELL_CWD")"
RUNTIME_AGENT_REPO_ROOT="$SHELL_CWD"
if git -C "$SHELL_CWD" rev-parse --show-toplevel >/dev/null 2>&1; then
  RUNTIME_AGENT_REPO_ROOT="$(git -C "$SHELL_CWD" rev-parse --show-toplevel)"
fi

command -v tmux >/dev/null 2>&1 || {
  echo "[run-interpreter-once] tmux is required" >&2
  exit 2
}
if [[ -z "$SESSION_NAME" || -z "$WINDOW_NAME" || -z "$PRESET" || -z "$SHELL_COMMAND" ]]; then
  echo "[run-interpreter-once] session/window/preset/shell command must be non-empty" >&2
  exit 2
fi
if [[ -n "${INTERPRETER_PORT:-}" ]] \
  && { [[ ! "$INTERPRETER_PORT" =~ ^[0-9]+$ ]] \
    || ((10#$INTERPRETER_PORT < 1 || 10#$INTERPRETER_PORT > 65535)); }; then
  echo "[run-interpreter-once] interpreter port must be between 1 and 65535" >&2
  exit 2
fi
if [[ -n "${GEMMA4_MTP:-}" && ! "$GEMMA4_MTP" =~ ^(off|on|auto)$ ]]; then
  echo "[run-interpreter-once] --gemma-mtp must be off, on, or auto" >&2
  exit 2
fi
if [[ -n "${GEMMA4_INTERPRETER_DRAFT_TOKENS:-}" ]] \
  && { [[ ! "$GEMMA4_INTERPRETER_DRAFT_TOKENS" =~ ^[0-9]+$ ]] \
    || ((10#$GEMMA4_INTERPRETER_DRAFT_TOKENS < 1 || 10#$GEMMA4_INTERPRETER_DRAFT_TOKENS > 32)); }; then
  echo "[run-interpreter-once] draft tokens must be between 1 and 32" >&2
  exit 2
fi
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "[run-interpreter-once] session already exists: ${SESSION_NAME}" >&2
  echo "[run-interpreter-once] use ./scripts/restart-interpreter-stack-in-place.sh --session ${SESSION_NAME} --preset ${PRESET}" >&2
  exit 2
fi

created_session=0
cleanup_failed_start() {
  local status=$?
  trap - EXIT
  if ((status != 0 && created_session == 1)); then
    tmux kill-session -t "$SESSION_NAME" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup_failed_start EXIT

tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$SHELL_CWD"
created_session=1

WINDOW_TARGET="${SESSION_NAME}:${WINDOW_NAME}"
SHELL_PANE="$(tmux display-message -p -t "${WINDOW_TARGET}.0" '#{pane_id}')"
[[ -n "$SHELL_PANE" ]] || {
  echo "[run-interpreter-once] unable to resolve the shell pane" >&2
  exit 2
}

export INTERPRETER_PRESET="$PRESET"
export MH_RUNTIME_ACTIVE_MODE="interpreter"
export MH_RUNTIME_INTERPRETER_PRESET="$PRESET"
mh_sync_interpreter_tmux_environment "$SESSION_NAME" reset

# The first pane is created only to establish the session. Respawning it after
# the environment sync lets the visible shell inherit the same persistent
# defaults as the stack, even when the tmux server predates this launcher.
tmux respawn-pane -k -c "$SHELL_CWD" -t "$SHELL_PANE" "$SHELL_COMMAND"
tmux set-option -w -t "$WINDOW_TARGET" remain-on-exit on

STACK_COMMAND="exec ./scripts/run-interpreter-stack.sh --preset $(printf '%q' "$PRESET")"
STACK_PANE="$(
  tmux split-window -d -h -t "$SHELL_PANE" -c "$ROOT_DIR" \
    -P -F '#{pane_id}' "$STACK_COMMAND"
)"
[[ -n "$STACK_PANE" ]] || {
  echo "[run-interpreter-once] unable to create the interpreter stack pane" >&2
  exit 2
}

tmux set-option -w -t "$WINDOW_TARGET" "$MH_INTERPRETER_SHELL_PANE_OPTION" "$SHELL_PANE"
tmux set-option -w -t "$WINDOW_TARGET" "$MH_INTERPRETER_STACK_PANE_OPTION" "$STACK_PANE"
tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_shell_pane "$SHELL_PANE"
tmux set-option -w -t "$WINDOW_TARGET" @minimum_headroom_runtime_stack_pane "$STACK_PANE"
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
tmux select-pane -t "$SHELL_PANE" -T "shell"
tmux select-pane -t "$STACK_PANE" -T "interpreter stack"
tmux select-layout -t "$WINDOW_TARGET" even-horizontal >/dev/null
tmux select-pane -t "$SHELL_PANE"

created_session=0
trap - EXIT

echo "[run-interpreter-once] started ${WINDOW_TARGET} preset=${PRESET}"
echo "[run-interpreter-once] shell pane=${SHELL_PANE} cwd=${SHELL_CWD} command=${SHELL_COMMAND}"
echo "[run-interpreter-once] stack pane=${STACK_PANE} cwd=${ROOT_DIR}"
if [[ -n "$MH_ENV_FILE" && -r "$MH_ENV_FILE" ]]; then
  echo "[run-interpreter-once] config=${MH_ENV_FILE} (defaults; explicit environment wins)"
fi

if ((ATTACH == 1)); then
  if [[ -n "${TMUX:-}" ]]; then
    tmux select-window -t "$WINDOW_TARGET"
    tmux select-pane -t "$SHELL_PANE"
    tmux switch-client -t "$WINDOW_TARGET"
  else
    tmux attach-session -t "$SESSION_NAME"
  fi
else
  echo "[run-interpreter-once] attach skipped (--no-attach)."
  echo "[run-interpreter-once] attach command: tmux attach -t ${SESSION_NAME}"
fi
