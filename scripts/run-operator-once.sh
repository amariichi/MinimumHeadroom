#!/usr/bin/env bash
set -euo pipefail

CALLER_DIR="$(pwd)"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SESSION_NAME="agent"
WINDOW_BASE="operator"
AGENT_CMD="codex"
STACK_CMD="./scripts/run-operator-stack.sh"
FACE_UI_MODE=""
FACE_AUDIO_TARGET=""
ASR_BASE_URL=""
ATTACH_AFTER_START=1

usage() {
  cat <<'EOF'
Usage: ./scripts/run-operator-once.sh [options]

Start Codex + operator stack in tmux with one command.

Options:
  --session <name>          tmux session name (default: agent)
  --window <name>           base window name (default: operator)
  --agent-cmd <command>     command to run in agent pane (default: codex; starts in the shell directory where this script was invoked)
  --stack-cmd <command>     stack launcher command (default: ./scripts/run-operator-stack.sh)
  --ui-mode <auto|pc|mobile>
                            FACE_UI_MODE override for stack launch
  --audio-target <local|browser|both>
                            FACE_AUDIO_TARGET override for stack launch
  --asr-base-url <url>      MH_OPERATOR_ASR_BASE_URL override for stack launch
  --no-attach               do not attach/switch tmux client after start
  -h, --help                show this help

Examples:
  ./scripts/run-operator-once.sh
  ./scripts/run-operator-once.sh --agent-cmd 'codex resume --last'
  ./scripts/run-operator-once.sh --agent-cmd 'bash -l'
  ./scripts/run-operator-once.sh --session work --window mobile --ui-mode mobile --audio-target browser
EOF
}

require_value() {
  local opt="$1"
  local value="${2:-}"
  if [[ -z "$value" ]]; then
    echo "[run-operator-once] ${opt} requires a value." >&2
    exit 2
  fi
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
      WINDOW_BASE="$2"
      shift 2
      ;;
    --agent-cmd)
      require_value "$1" "${2:-}"
      AGENT_CMD="$2"
      shift 2
      ;;
    --stack-cmd)
      require_value "$1" "${2:-}"
      STACK_CMD="$2"
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
    --no-attach)
      ATTACH_AFTER_START=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[run-operator-once] Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v tmux >/dev/null 2>&1; then
  echo "[run-operator-once] tmux is required but not found in PATH." >&2
  exit 2
fi

if [[ -z "$SESSION_NAME" || -z "$WINDOW_BASE" || -z "$AGENT_CMD" || -z "$STACK_CMD" ]]; then
  echo "[run-operator-once] session/window/agent-cmd/stack-cmd must be non-empty." >&2
  exit 2
fi

if [[ -n "$FACE_UI_MODE" && ! "$FACE_UI_MODE" =~ ^(auto|pc|mobile)$ ]]; then
  echo "[run-operator-once] --ui-mode must be one of: auto, pc, mobile" >&2
  exit 2
fi

if [[ -n "$FACE_AUDIO_TARGET" && ! "$FACE_AUDIO_TARGET" =~ ^(local|browser|both)$ ]]; then
  echo "[run-operator-once] --audio-target must be one of: local, browser, both" >&2
  exit 2
fi

next_window_name() {
  local session_name="$1"
  local base_name="$2"
  local candidate="$base_name"
  local index=1

  while tmux list-windows -t "$session_name" -F '#{window_name}' | grep -Fxq "$candidate"; do
    candidate="${base_name}-${index}"
    index=$((index + 1))
  done

  printf '%s' "$candidate"
}

session_exists=0
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  session_exists=1
fi

if [[ "$session_exists" -eq 0 ]]; then
  window_name="$WINDOW_BASE"
  tmux new-session -d -s "$SESSION_NAME" -n "$window_name"
else
  window_name="$(next_window_name "$SESSION_NAME" "$WINDOW_BASE")"
  tmux new-window -d -t "$SESSION_NAME:" -n "$window_name"
fi

agent_pane="$(tmux display-message -p -t "${SESSION_NAME}:${window_name}.0" '#{pane_id}')"
tmux split-window -d -h -t "$agent_pane"
stack_pane="$(tmux display-message -p -t "${SESSION_NAME}:${window_name}.1" '#{pane_id}')"
tmux select-layout -t "${SESSION_NAME}:${window_name}" even-horizontal >/dev/null 2>&1 || true

# Launch agent command in the first pane.
printf -v quoted_agent_cwd '%q' "$CALLER_DIR"
tmux send-keys -t "$agent_pane" "cd $quoted_agent_cwd" C-m
tmux send-keys -t "$agent_pane" "$AGENT_CMD" C-m

# Launch operator stack in the second pane with resolved pane id.
stack_launch="env"
append_env() {
  local key="$1"
  local value="$2"
  local quoted
  printf -v quoted '%q' "$value"
  stack_launch+=" ${key}=${quoted}"
}
append_env "MH_BRIDGE_TMUX_PANE" "$agent_pane"
if [[ -n "$FACE_UI_MODE" ]]; then
  append_env "FACE_UI_MODE" "$FACE_UI_MODE"
fi
if [[ -n "$FACE_AUDIO_TARGET" ]]; then
  append_env "FACE_AUDIO_TARGET" "$FACE_AUDIO_TARGET"
fi
if [[ -n "$ASR_BASE_URL" ]]; then
  append_env "MH_OPERATOR_ASR_BASE_URL" "$ASR_BASE_URL"
fi
stack_launch+=" bash -lc "
printf -v quoted_stack_cmd '%q' "$STACK_CMD"
stack_launch+="$quoted_stack_cmd"

tmux send-keys -t "$stack_pane" "$stack_launch" C-m

echo "[run-operator-once] session=${SESSION_NAME} window=${window_name}"
echo "[run-operator-once] agent pane=${agent_pane} cwd=${CALLER_DIR} command=${AGENT_CMD}"
echo "[run-operator-once] stack pane=${stack_pane} command=${STACK_CMD}"
echo "[run-operator-once] MH_BRIDGE_TMUX_PANE=${agent_pane}"

if [[ "$ATTACH_AFTER_START" -eq 0 ]]; then
  echo "[run-operator-once] attach skipped (--no-attach)."
  echo "[run-operator-once] attach command: tmux attach -t ${SESSION_NAME}"
  exit 0
fi

if [[ -n "${TMUX:-}" ]]; then
  tmux select-window -t "${SESSION_NAME}:${window_name}"
  tmux select-pane -t "$agent_pane"
  tmux switch-client -t "$SESSION_NAME"
else
  tmux attach -t "$SESSION_NAME"
fi
