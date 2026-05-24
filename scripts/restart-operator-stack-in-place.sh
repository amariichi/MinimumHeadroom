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
ASR_BASE_URL=""
OPERATOR_FACE_AGENT_ID="${MH_OPERATOR_FACE_AGENT_ID:-__operator__}"
OPERATOR_FACE_AGENT_LABEL="${MH_OPERATOR_FACE_AGENT_LABEL:-Operator}"

list_profiles() {
  cat <<'EOF'
Available profiles:
  default         Codex + default operator stack (legacy-compatible baseline)
  realtime        Default TTS + built-in Voxtral realtime ASR + Parakeet fallback
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
  --profile <name>          startup preset (default|realtime|qwen3|qwen3-realtime)
  --list-profiles           show startup presets and exit
  --stack-cmd <command>     stack launcher command (default: ./scripts/run-operator-stack.sh)
  --ui-mode <auto|pc|mobile>
                            UI layout for the stack launch: auto, desktop, or mobile
  --audio-target <local|browser|both>
                            FACE_AUDIO_TARGET override for stack launch
  --asr-base-url <url>      MH_OPERATOR_ASR_BASE_URL override for stack launch
  -h, --help                show this help

Examples:
  ./scripts/restart-operator-stack-in-place.sh
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
append_env "MH_OPERATOR_FACE_AGENT_ID" "$OPERATOR_FACE_AGENT_ID"
append_env "MH_OPERATOR_FACE_AGENT_LABEL" "$OPERATOR_FACE_AGENT_LABEL"
if [[ -n "$FACE_UI_MODE" ]]; then
  append_env "FACE_UI_MODE" "$FACE_UI_MODE"
fi
if [[ -n "$FACE_AUDIO_TARGET" ]]; then
  append_env "FACE_AUDIO_TARGET" "$FACE_AUDIO_TARGET"
fi
if [[ -n "$ASR_BASE_URL" ]]; then
  append_env "MH_OPERATOR_ASR_BASE_URL" "$ASR_BASE_URL"
fi
# Keep restarts aligned with run-operator-stack.sh. Override by exporting the var.
append_env "MH_TTS_CHUNK_MAX_CHARS" "${MH_TTS_CHUNK_MAX_CHARS:-64}"
stack_launch+=" bash -lc "
printf -v quoted_stack_cmd '%q' "$STACK_CMD"
stack_launch+="$quoted_stack_cmd"

tmux respawn-pane -k -t "$stack_pane" "$stack_launch"

echo "[restart-operator-stack] session=${SESSION_NAME} window=${WINDOW_NAME}"
echo "[restart-operator-stack] agent pane=${agent_pane}"
echo "[restart-operator-stack] stack pane=${stack_pane}"
echo "[restart-operator-stack] repo root=${agent_repo_root}"
echo "[restart-operator-stack] MH_BRIDGE_TMUX_PANE=${agent_pane}"
echo "[restart-operator-stack] MH_OPERATOR_FACE_AGENT_ID=${OPERATOR_FACE_AGENT_ID}"

if [[ -n "${TMUX:-}" ]]; then
  tmux select-window -t "${SESSION_NAME}:${WINDOW_NAME}"
  tmux select-pane -t "$agent_pane"
fi
