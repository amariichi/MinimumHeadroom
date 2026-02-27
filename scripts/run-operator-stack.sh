#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${FACE_WS_HOST:=127.0.0.1}"
: "${FACE_WS_PORT:=8765}"
: "${FACE_WS_PATH:=/ws}"
: "${FACE_AUDIO_TARGET:=browser}"
: "${FACE_UI_MODE:=mobile}"
: "${ASR_HOST:=127.0.0.1}"
: "${ASR_PORT:=8091}"
: "${MH_OPERATOR_ASR_BASE_URL:=http://${ASR_HOST}:${ASR_PORT}}"
: "${MH_STACK_START_MCP:=0}"

if [[ -z "${MH_BRIDGE_TMUX_PANE:-}" && -z "${TMUX_PANE:-}" ]]; then
  cat >&2 <<'EOF'
[run-operator-stack] bridge target pane is not set.
Set MH_BRIDGE_TMUX_PANE=<session:window.pane>, or run this script from inside tmux.
EOF
  exit 2
fi

FACE_WS_URL="ws://${FACE_WS_HOST}:${FACE_WS_PORT}${FACE_WS_PATH}"

declare -a PIDS=()
declare -A NAMES=()

cleanup() {
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}

trap cleanup EXIT INT TERM

start_proc() {
  local name="$1"
  shift
  "$@" &
  local pid=$!
  PIDS+=("$pid")
  NAMES["$pid"]="$name"
  echo "[run-operator-stack] started ${name} (pid=${pid})"
}

echo "[run-operator-stack] FACE_WS_URL=${FACE_WS_URL}"
echo "[run-operator-stack] FACE_AUDIO_TARGET=${FACE_AUDIO_TARGET}"
echo "[run-operator-stack] FACE_UI_MODE=${FACE_UI_MODE}"
echo "[run-operator-stack] MH_OPERATOR_ASR_BASE_URL=${MH_OPERATOR_ASR_BASE_URL}"
echo "[run-operator-stack] MH_STACK_START_MCP=${MH_STACK_START_MCP}"

start_proc "asr-worker" \
  env ASR_HOST="$ASR_HOST" ASR_PORT="$ASR_PORT" \
  ./scripts/run-asr-worker.sh

start_proc "face-app" \
  env FACE_WS_HOST="$FACE_WS_HOST" FACE_WS_PORT="$FACE_WS_PORT" FACE_WS_PATH="$FACE_WS_PATH" \
  FACE_AUDIO_TARGET="$FACE_AUDIO_TARGET" FACE_UI_MODE="$FACE_UI_MODE" MH_OPERATOR_ASR_BASE_URL="$MH_OPERATOR_ASR_BASE_URL" \
  ./scripts/run-face-app.sh --audio-target "$FACE_AUDIO_TARGET" --ui-mode "$FACE_UI_MODE"

start_proc "operator-bridge" \
  env MH_BRIDGE_TMUX_PANE="${MH_BRIDGE_TMUX_PANE:-}" MH_BRIDGE_WS_URL="$FACE_WS_URL" \
  ./scripts/run-operator-bridge.sh

if [[ "${MH_STACK_START_MCP}" == "1" ]]; then
  start_proc "mcp-server" \
    env FACE_WS_URL="$FACE_WS_URL" \
    ./scripts/run-mcp-server.sh
else
  echo "[run-operator-stack] skipping mcp-server startup (MH_STACK_START_MCP=0)."
fi

echo "[run-operator-stack] all services started. press Ctrl+C to stop."

exit_code=0
while true; do
  if ! wait -n "${PIDS[@]}"; then
    exit_code=$?
  fi

  exited_pid=""
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      exited_pid="$pid"
      break
    fi
  done

  if [[ -n "$exited_pid" ]]; then
    echo "[run-operator-stack] ${NAMES[$exited_pid]:-service} exited (pid=${exited_pid}, code=${exit_code}). stopping others."
    break
  fi
done

exit "$exit_code"
