#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SESSION_NAME="agent"
WINDOW_NAME="operator"
STACK_CMD="./scripts/run-operator-stack.sh"
PROFILE_NAME="default"
STACK_CMD_SET=0
FACE_UI_MODE=""
FACE_AUDIO_TARGET="${MH_FACE_AUDIO_TARGET:-browser}"
KOKORO_VOICE="${MH_KOKORO_VOICE:-}"
SUPERTONIC_VENV_OVERRIDE="${SUPERTONIC_VENV:-}"
SUPERTONIC_CACHE_DIR_OVERRIDE="${SUPERTONIC_CACHE_DIR:-}"
SUPERTONIC_MODEL_REVISION_OVERRIDE="${SUPERTONIC_MODEL_REVISION:-}"
SUPERTONIC_VOICE="${MH_SUPERTONIC_VOICE:-}"
SUPERTONIC_LANGUAGE="${MH_SUPERTONIC_LANGUAGE:-}"
SUPERTONIC_STEPS="${MH_SUPERTONIC_STEPS:-}"
SUPERTONIC_SPEED="${MH_SUPERTONIC_SPEED:-}"
SUPERTONIC_INTRA_OP_THREADS="${MH_SUPERTONIC_INTRA_OP_THREADS:-}"
SUPERTONIC_INTER_OP_THREADS="${MH_SUPERTONIC_INTER_OP_THREADS:-}"
CAPTURE_ANOMALY="${MH_TTS_CAPTURE_ANOMALY:-}"
ASR_BASE_URL=""
OPERATOR_FACE_AGENT_ID="${MH_OPERATOR_FACE_AGENT_ID:-__operator__}"
OPERATOR_FACE_AGENT_LABEL="${MH_OPERATOR_FACE_AGENT_LABEL:-Operator}"

list_profiles() {
  cat <<'EOF'
Available profiles:
  default         Codex + default operator stack (legacy-compatible baseline)
  realtime        Default TTS + built-in Voxtral realtime ASR + Parakeet fallback
  supertonic      Supertonic 3 CPU TTS + default operator stack
  supertonic-realtime
                  Supertonic 3 CPU TTS + built-in Voxtral realtime ASR + Parakeet fallback
  qwen3           Qwen3 TTS + default operator stack
  qwen3-realtime  Qwen3 TTS + built-in Voxtral realtime ASR + Parakeet fallback (recommended)
EOF
}

apply_profile_defaults() {
  case "$PROFILE_NAME" in
    default)
      ;;
    realtime)
      if [[ "$STACK_CMD_SET" -eq 0 ]]; then
        STACK_CMD="MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 ./scripts/run-operator-stack.sh"
      fi
      ;;
    supertonic)
      if [[ "$STACK_CMD_SET" -eq 0 ]]; then
        STACK_CMD="TTS_ENGINE=supertonic ./scripts/run-operator-stack.sh"
      fi
      ;;
    supertonic-realtime)
      if [[ "$STACK_CMD_SET" -eq 0 ]]; then
        STACK_CMD="TTS_ENGINE=supertonic MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 ./scripts/run-operator-stack.sh"
      fi
      ;;
    qwen3)
      if [[ "$STACK_CMD_SET" -eq 0 ]]; then
        STACK_CMD="TTS_ENGINE=qwen3 ./scripts/run-operator-stack.sh"
      fi
      ;;
    qwen3-realtime)
      if [[ "$STACK_CMD_SET" -eq 0 ]]; then
        STACK_CMD="TTS_ENGINE=qwen3 MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 ./scripts/run-operator-stack.sh"
      fi
      ;;
    *)
      echo "[restart-operator-stack] Unknown profile: $PROFILE_NAME" >&2
      list_profiles >&2
      exit 2
      ;;
  esac
}

usage() {
  cat <<'EOF'
Usage: ./scripts/restart-operator-stack-in-place.sh [options]

Restart the existing operator stack pane without creating a new tmux window.

Options:
  --session <name>          tmux session name (default: agent)
  --window <name>           tmux window name (default: operator)
  --profile <name>          startup preset (default|realtime|supertonic|supertonic-realtime|qwen3|qwen3-realtime)
  --list-profiles           show startup presets and exit
  --stack-cmd <command>     stack launcher command (default: ./scripts/run-operator-stack.sh)
  --ui-mode <auto|pc|mobile>
                            UI layout for the stack launch: auto, desktop, or mobile
  --audio-target <local|browser|both>
                            FACE_AUDIO_TARGET override for stack launch
  --asr-base-url <url>      MH_OPERATOR_ASR_BASE_URL override for stack launch
  -h, --help                show this help

Environment:
  MH_KOKORO_VOICE=<voice> Kokoro voice override, for example jf_alpha or af_heart.
  MH_SUPERTONIC_VOICE=<voice>
                            Supertonic voice override, M1-M5 or F1-F5.
  MH_SUPERTONIC_LANGUAGE=<auto|tag>
                            Automatic script detection or a supported fallback language tag.
  MH_TTS_CAPTURE_ANOMALY=1  Save a WAV+JSON sample whenever a synthesized TTS
                            utterance looks noise-like (capture-only diagnostic; off by default).

Examples:
  ./scripts/restart-operator-stack-in-place.sh
  ./scripts/restart-operator-stack-in-place.sh --profile supertonic
  ./scripts/restart-operator-stack-in-place.sh --profile qwen3-realtime
  ./scripts/restart-operator-stack-in-place.sh --session agent --window operator
EOF
}

require_value() {
  local opt="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "[restart-operator-stack] ${opt} requires a value." >&2
    exit 2
  fi
}

derive_agent_repo_root() {
  local cwd="$1"
  if git -C "$cwd" rev-parse --show-toplevel >/dev/null 2>&1; then
    git -C "$cwd" rev-parse --show-toplevel
    return
  fi
  printf '%s\n' "$cwd"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session)
      require_value "$1" "${2:-}"
      SESSION_NAME="$2"
      shift 2
      ;;
    --window)
      require_value "$1" "${2:-}"
      WINDOW_NAME="$2"
      shift 2
      ;;
    --profile)
      require_value "$1" "${2:-}"
      PROFILE_NAME="$2"
      shift 2
      ;;
    --list-profiles)
      list_profiles
      exit 0
      ;;
    --stack-cmd)
      require_value "$1" "${2:-}"
      STACK_CMD="$2"
      STACK_CMD_SET=1
      shift 2
      ;;
    --ui-mode)
      require_value "$1" "${2:-}"
      FACE_UI_MODE="$2"
      shift 2
      ;;
    --audio-target)
      require_value "$1" "${2:-}"
      FACE_AUDIO_TARGET="$2"
      shift 2
      ;;
    --asr-base-url)
      require_value "$1" "${2:-}"
      ASR_BASE_URL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[restart-operator-stack] Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

apply_profile_defaults

if ! command -v tmux >/dev/null 2>&1; then
  echo "[restart-operator-stack] tmux is required but not found in PATH." >&2
  exit 2
fi

if [[ -n "$FACE_UI_MODE" && ! "$FACE_UI_MODE" =~ ^(auto|pc|mobile)$ ]]; then
  echo "[restart-operator-stack] --ui-mode must be one of: auto, pc, mobile" >&2
  exit 2
fi

if [[ -n "$FACE_AUDIO_TARGET" && ! "$FACE_AUDIO_TARGET" =~ ^(local|browser|both)$ ]]; then
  echo "[restart-operator-stack] --audio-target must be one of: local, browser, both" >&2
  exit 2
fi

if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "[restart-operator-stack] tmux session not found: $SESSION_NAME" >&2
  exit 2
fi

if ! tmux list-panes -t "${SESSION_NAME}:${WINDOW_NAME}" >/dev/null 2>&1; then
  echo "[restart-operator-stack] tmux window not found: ${SESSION_NAME}:${WINDOW_NAME}" >&2
  exit 2
fi
RUNTIME_ACTIVE_MODE="$(
  tmux show-option -wqv -t "${SESSION_NAME}:${WINDOW_NAME}" \
    @minimum_headroom_runtime_mode 2>/dev/null || true
)"
if [[ "$RUNTIME_ACTIVE_MODE" == "interpreter" ]]; then
  echo "[restart-operator-stack] active runtime mode is ${RUNTIME_ACTIVE_MODE}; use the authenticated Mode dialog to switch first" >&2
  exit 2
fi

agent_pane="$(tmux display-message -p -t "${SESSION_NAME}:${WINDOW_NAME}.0" '#{pane_id}' 2>/dev/null || true)"
stack_pane="$(tmux display-message -p -t "${SESSION_NAME}:${WINDOW_NAME}.1" '#{pane_id}' 2>/dev/null || true)"
agent_cwd="$(tmux display-message -p -t "${SESSION_NAME}:${WINDOW_NAME}.0" '#{pane_current_path}' 2>/dev/null || true)"
agent_repo_root="$(derive_agent_repo_root "$agent_cwd")"

if [[ -z "$agent_pane" || -z "$agent_cwd" ]]; then
  echo "[restart-operator-stack] expected pane .0 (agent) in ${SESSION_NAME}:${WINDOW_NAME}" >&2
  exit 2
fi

if [[ -z "$stack_pane" ]]; then
  stack_pane="$(tmux split-window -h -t "$agent_pane" -c "$agent_cwd" -P -F '#{pane_id}' 2>/dev/null || true)"
  if [[ -z "$stack_pane" ]]; then
    echo "[restart-operator-stack] failed to create missing stack pane in ${SESSION_NAME}:${WINDOW_NAME}" >&2
    exit 2
  fi
fi

stack_launch="env"
append_env() {
  local key="$1"
  local value="$2"
  local quoted
  printf -v quoted '%q' "$value"
  stack_launch+=" ${key}=${quoted}"
}

append_env "MH_BRIDGE_TMUX_PANE" "$agent_pane"
append_env "MH_BRIDGE_RECOVERY_TMUX_PANE" "$agent_pane"
append_env "MH_AGENT_SOURCE_REPO_DEFAULT" "$agent_repo_root"
append_env "MH_AGENT_STREAM_ID" "repo:${agent_repo_root}"
append_env "MH_AGENT_WORKTREES_ROOT" "${agent_repo_root}/.agent/worktrees"
append_env "MH_AGENT_TMUX_SESSION" "$SESSION_NAME"
append_env "MH_OPERATOR_FACE_AGENT_ID" "$OPERATOR_FACE_AGENT_ID"
append_env "MH_OPERATOR_FACE_AGENT_LABEL" "$OPERATOR_FACE_AGENT_LABEL"
append_env "MH_RUNTIME_ACTIVE_MODE" "operator"
append_env "MH_RUNTIME_OPERATOR_PROFILE" "$PROFILE_NAME"
if [[ -n "$FACE_UI_MODE" ]]; then
  append_env "FACE_UI_MODE" "$FACE_UI_MODE"
fi
if [[ -n "$FACE_AUDIO_TARGET" ]]; then
  append_env "FACE_AUDIO_TARGET" "$FACE_AUDIO_TARGET"
fi
if [[ -n "$KOKORO_VOICE" ]]; then
  append_env "MH_KOKORO_VOICE" "$KOKORO_VOICE"
fi
if [[ -n "$SUPERTONIC_VENV_OVERRIDE" ]]; then
  append_env "SUPERTONIC_VENV" "$SUPERTONIC_VENV_OVERRIDE"
fi
if [[ -n "$SUPERTONIC_CACHE_DIR_OVERRIDE" ]]; then
  append_env "SUPERTONIC_CACHE_DIR" "$SUPERTONIC_CACHE_DIR_OVERRIDE"
fi
if [[ -n "$SUPERTONIC_MODEL_REVISION_OVERRIDE" ]]; then
  append_env "SUPERTONIC_MODEL_REVISION" "$SUPERTONIC_MODEL_REVISION_OVERRIDE"
fi
if [[ -n "$SUPERTONIC_VOICE" ]]; then
  append_env "MH_SUPERTONIC_VOICE" "$SUPERTONIC_VOICE"
fi
if [[ -n "$SUPERTONIC_LANGUAGE" ]]; then
  append_env "MH_SUPERTONIC_LANGUAGE" "$SUPERTONIC_LANGUAGE"
fi
if [[ -n "$SUPERTONIC_STEPS" ]]; then
  append_env "MH_SUPERTONIC_STEPS" "$SUPERTONIC_STEPS"
fi
if [[ -n "$SUPERTONIC_SPEED" ]]; then
  append_env "MH_SUPERTONIC_SPEED" "$SUPERTONIC_SPEED"
fi
if [[ -n "$SUPERTONIC_INTRA_OP_THREADS" ]]; then
  append_env "MH_SUPERTONIC_INTRA_OP_THREADS" "$SUPERTONIC_INTRA_OP_THREADS"
fi
if [[ -n "$SUPERTONIC_INTER_OP_THREADS" ]]; then
  append_env "MH_SUPERTONIC_INTER_OP_THREADS" "$SUPERTONIC_INTER_OP_THREADS"
fi
if [[ -n "$CAPTURE_ANOMALY" ]]; then
  append_env "MH_TTS_CAPTURE_ANOMALY" "$CAPTURE_ANOMALY"
fi
if [[ -n "$ASR_BASE_URL" ]]; then
  append_env "MH_OPERATOR_ASR_BASE_URL" "$ASR_BASE_URL"
fi
# Keep restarts aligned with run-operator-stack.sh. Override by exporting the var.
append_env "MH_TTS_CHUNK_MAX_CHARS" "${MH_TTS_CHUNK_MAX_CHARS:-64}"
stack_launch+=" bash -lc "
printf -v quoted_stack_cmd '%q' "$STACK_CMD"
stack_launch+="$quoted_stack_cmd"

tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" remain-on-exit on
tmux respawn-pane -k -t "$stack_pane" "$stack_launch"

saved_interpreter_preset="$(
  tmux show-option -wqv -t "${SESSION_NAME}:${WINDOW_NAME}" \
    @minimum_headroom_runtime_interpreter_preset 2>/dev/null || true
)"
if [[ -z "$saved_interpreter_preset" ]]; then
  saved_interpreter_preset="${MH_RUNTIME_INTERPRETER_PRESET:-gemma4-supertonic}"
fi
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_shell_pane "$agent_pane"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_stack_pane "$stack_pane"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_mode operator
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_operator_profile "$PROFILE_NAME"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_interpreter_preset "$saved_interpreter_preset"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_bind_host "${FACE_WS_HOST:-127.0.0.1}"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_bind_port "${FACE_WS_PORT:-8765}"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_operator_ui_mode "${FACE_UI_MODE:-auto}"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_operator_audio_target "${FACE_AUDIO_TARGET:-browser}"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_operator_asr_device "${MH_ASR_DEVICE:-cpu}"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_operator_kokoro_voice "$KOKORO_VOICE"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_agent_repo_root "$agent_repo_root"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_interpreter_mtp "${GEMMA4_MTP:-off}"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_interpreter_draft_tokens "${GEMMA4_INTERPRETER_DRAFT_TOKENS:-8}"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_interpreter_supertonic_voice "${MH_SUPERTONIC_VOICE:-F2}"
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_transition_state ready
tmux set-option -w -t "${SESSION_NAME}:${WINDOW_NAME}" @minimum_headroom_runtime_transition_error ""

echo "[restart-operator-stack] session=${SESSION_NAME} window=${WINDOW_NAME}"
echo "[restart-operator-stack] agent pane=${agent_pane}"
echo "[restart-operator-stack] stack pane=${stack_pane}"
echo "[restart-operator-stack] repo root=${agent_repo_root}"
echo "[restart-operator-stack] MH_BRIDGE_TMUX_PANE=${agent_pane}"
echo "[restart-operator-stack] MH_OPERATOR_FACE_AGENT_ID=${OPERATOR_FACE_AGENT_ID}"
if [[ -n "$KOKORO_VOICE" ]]; then
  echo "[restart-operator-stack] MH_KOKORO_VOICE=${KOKORO_VOICE}"
fi
if [[ -n "$SUPERTONIC_VOICE" || -n "$SUPERTONIC_LANGUAGE" ]]; then
  echo "[restart-operator-stack] Supertonic voice=${SUPERTONIC_VOICE:-M1} language=${SUPERTONIC_LANGUAGE:-auto}"
fi
if [[ -n "$CAPTURE_ANOMALY" ]]; then
  echo "[restart-operator-stack] MH_TTS_CAPTURE_ANOMALY=${CAPTURE_ANOMALY}"
fi

if [[ -n "${TMUX:-}" ]]; then
  tmux select-window -t "${SESSION_NAME}:${WINDOW_NAME}"
  tmux select-pane -t "$agent_pane"
fi
