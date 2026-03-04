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
: "${MH_STACK_SKIP_ASR:=0}"
: "${MH_OPERATOR_REALTIME_ASR_ENABLED:=0}"
: "${MH_STACK_START_REALTIME_ASR:=0}"
: "${REALTIME_ASR_HOST:=127.0.0.1}"
: "${REALTIME_ASR_PORT:=8090}"
: "${REALTIME_ASR_PATH:=/v1/realtime}"
: "${MH_OPERATOR_REALTIME_ASR_WS_URL:=ws://${REALTIME_ASR_HOST}:${REALTIME_ASR_PORT}${REALTIME_ASR_PATH}}"
: "${MH_OPERATOR_REALTIME_ASR_MODEL:=mistralai/Voxtral-Mini-4B-Realtime-2602}"
: "${MH_STACK_START_MCP:=0}"

DEFAULT_OPERATOR_ASR_BASE_URL="http://${ASR_HOST}:${ASR_PORT}"
STACK_OPERATOR_ASR_BASE_URL="$MH_OPERATOR_ASR_BASE_URL"

if [[ "${MH_STACK_START_REALTIME_ASR}" == "1" ]]; then
  MH_OPERATOR_REALTIME_ASR_ENABLED=1
fi

if [[ "${MH_STACK_SKIP_ASR}" == "1" && -z "${MH_OPERATOR_ASR_ENDPOINT_URL:-}" && "${MH_OPERATOR_ASR_BASE_URL}" == "${DEFAULT_OPERATOR_ASR_BASE_URL}" ]]; then
  STACK_OPERATOR_ASR_BASE_URL=""
fi

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
echo "[run-operator-stack] MH_OPERATOR_ASR_BASE_URL=${STACK_OPERATOR_ASR_BASE_URL:-<disabled>}"
echo "[run-operator-stack] MH_STACK_SKIP_ASR=${MH_STACK_SKIP_ASR}"
echo "[run-operator-stack] MH_OPERATOR_REALTIME_ASR_ENABLED=${MH_OPERATOR_REALTIME_ASR_ENABLED}"
echo "[run-operator-stack] MH_OPERATOR_REALTIME_ASR_WS_URL=${MH_OPERATOR_REALTIME_ASR_WS_URL}"
echo "[run-operator-stack] MH_STACK_START_REALTIME_ASR=${MH_STACK_START_REALTIME_ASR}"
echo "[run-operator-stack] MH_STACK_START_MCP=${MH_STACK_START_MCP}"

if [[ "${MH_STACK_SKIP_ASR}" == "1" ]]; then
  echo "[run-operator-stack] skipping asr-worker startup (MH_STACK_SKIP_ASR=1)."
else
  start_proc "asr-worker" \
    env ASR_HOST="$ASR_HOST" ASR_PORT="$ASR_PORT" \
    ./scripts/run-asr-worker.sh
fi

if [[ "${MH_STACK_START_REALTIME_ASR}" == "1" ]]; then
  start_proc "realtime-asr" \
    env REALTIME_ASR_HOST="$REALTIME_ASR_HOST" REALTIME_ASR_PORT="$REALTIME_ASR_PORT" \
    REALTIME_ASR_MODEL="$MH_OPERATOR_REALTIME_ASR_MODEL" \
    ./scripts/run-vllm-voxtral.sh
  if [[ "${MH_STACK_SKIP_ASR}" != "1" ]]; then
    echo "[run-operator-stack] realtime ASR and asr-worker are both active; set MH_STACK_SKIP_ASR=1 or ASR_DEVICE=cpu if VRAM is tight."
  fi
else
  echo "[run-operator-stack] skipping realtime ASR startup (MH_STACK_START_REALTIME_ASR=0)."
fi

start_proc "face-app" \
  env FACE_WS_HOST="$FACE_WS_HOST" FACE_WS_PORT="$FACE_WS_PORT" FACE_WS_PATH="$FACE_WS_PATH" \
  FACE_AUDIO_TARGET="$FACE_AUDIO_TARGET" FACE_UI_MODE="$FACE_UI_MODE" FACE_OPERATOR_PANEL_ENABLED="1" MH_OPERATOR_ASR_BASE_URL="$STACK_OPERATOR_ASR_BASE_URL" \
  MH_OPERATOR_REALTIME_ASR_ENABLED="$MH_OPERATOR_REALTIME_ASR_ENABLED" \
  MH_OPERATOR_REALTIME_ASR_WS_URL="$MH_OPERATOR_REALTIME_ASR_WS_URL" \
  MH_OPERATOR_REALTIME_ASR_MODEL="$MH_OPERATOR_REALTIME_ASR_MODEL" \
  ./scripts/run-face-app.sh --audio-target "$FACE_AUDIO_TARGET" --ui-mode "$FACE_UI_MODE"

start_proc "operator-bridge" \
  env MH_BRIDGE_TMUX_PANE="${MH_BRIDGE_TMUX_PANE:-}" MH_BRIDGE_RECOVERY_TMUX_PANE="${MH_BRIDGE_RECOVERY_TMUX_PANE:-}" MH_BRIDGE_WS_URL="$FACE_WS_URL" \
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
