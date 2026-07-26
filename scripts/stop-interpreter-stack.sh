#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/env-defaults.sh"

MH_ENV_FILE="${MH_ENV_FILE:-$(mh_default_env_file)}"
export MH_ENV_FILE
mh_load_env_defaults "$MH_ENV_FILE"

SESSION_NAME="${MH_INTERPRETER_TMUX_SESSION:-interpreter}"
WINDOW_NAME="${MH_INTERPRETER_TMUX_WINDOW:-stack}"

usage() {
  cat <<'EOF'
Usage: ./scripts/stop-interpreter-stack.sh [options]

Stop the dedicated two-pane interpreter tmux window created by
run-interpreter-once.sh. This closes its shell and stack panes. No process is
selected or killed by port number.

Options:
  --session NAME   tmux session name (default: interpreter)
  --window NAME    tmux window name (default: stack)
  -h, --help       Show this help
EOF
}

while (($# > 0)); do
  case "$1" in
    --session)
      [[ -n "${2:-}" ]] || { echo "[stop-interpreter-stack] --session requires a value" >&2; exit 2; }
      SESSION_NAME="$2"
      shift 2
      ;;
    --window)
      [[ -n "${2:-}" ]] || { echo "[stop-interpreter-stack] --window requires a value" >&2; exit 2; }
      WINDOW_NAME="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[stop-interpreter-stack] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v tmux >/dev/null 2>&1 || {
  echo "[stop-interpreter-stack] tmux is required" >&2
  exit 2
}
if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "[stop-interpreter-stack] session not found: $SESSION_NAME" >&2
  exit 2
fi
if ! tmux list-windows -t "$SESSION_NAME" -F '#{window_name}' | rg -qx "$WINDOW_NAME"; then
  echo "[stop-interpreter-stack] window not found: ${SESSION_NAME}:${WINDOW_NAME}" >&2
  exit 2
fi

tmux kill-window -t "${SESSION_NAME}:${WINDOW_NAME}"
echo "[stop-interpreter-stack] stopped ${SESSION_NAME}:${WINDOW_NAME}"
