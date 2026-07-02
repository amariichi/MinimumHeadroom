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
: "${MH_OPERATOR_FACE_AGENT_ID:=__operator__}"
: "${MH_OPERATOR_FACE_AGENT_LABEL:=Operator}"
# Keep each synthesized TTS chunk under the AtomS3R HTTP ingress cap
# (estimatePayloadLimit ~954 KB with HEADROOM_MAX_BASE64_TTS_SECONDS=15;
# bigger -> HTTP 413 -> mouth-only). ~64 chars is the current safe default
# for Japanese TTS chunks on the Atom HTTP audio path:
# the inter-chunk gap is the per-chunk synth-after-playback wait (no
# server-side prefetch), so fewer/larger chunks = far fewer gaps. Set here,
# the single chokepoint every operator bring-up path passes through, since
# env exported upstream does not reliably cross the operator tmux allowlist.
: "${MH_TTS_CHUNK_MAX_CHARS:=64}"
: "${MH_KOKORO_VOICE:=jf_alpha}"
# TTS noise capture-on-anomaly diagnostics. 1 = save a WAV+JSON sample
# whenever a synthesized utterance looks noise-like (capture only; never
# alters playback). Off by default.
: "${MH_TTS_CAPTURE_ANOMALY:=0}"
# Atom VAD backend selection. 'rms' is the default deterministic energy
# gate; 'silero' routes frames through silero-vad-worker for ML-based
# noise-vs-speech classification. The stack only starts the silero worker
# when MH_ATOM_VAD_BACKEND=silero AND MH_STACK_START_SILERO_VAD!=0.
: "${MH_ATOM_VAD_BACKEND:=rms}"
: "${MH_STACK_START_SILERO_VAD:=1}"
: "${SILERO_VAD_HOST:=127.0.0.1}"
: "${SILERO_VAD_PORT:=8092}"
: "${MH_SILERO_VAD_BASE_URL:=http://${SILERO_VAD_HOST}:${SILERO_VAD_PORT}}"

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
echo "[run-operator-stack] MH_OPERATOR_FACE_AGENT_ID=${MH_OPERATOR_FACE_AGENT_ID}"
echo "[run-operator-stack] MH_KOKORO_VOICE=${MH_KOKORO_VOICE}"
echo "[run-operator-stack] MH_TTS_CAPTURE_ANOMALY=${MH_TTS_CAPTURE_ANOMALY}"
echo "[run-operator-stack] MH_ATOM_VAD_BACKEND=${MH_ATOM_VAD_BACKEND}"
echo "[run-operator-stack] MH_SILERO_VAD_BASE_URL=${MH_SILERO_VAD_BASE_URL}"

if [[ "${MH_STACK_SKIP_ASR}" == "1" ]]; then
  echo "[run-operator-stack] skipping asr-worker startup (MH_STACK_SKIP_ASR=1)."
else
  # Force the ASR worker onto CUDA when launched from the stack. The user's
  # ~/.bashrc exports ASR_DEVICE=cpu as a safety default, which bleeds into
  # any restart that does not explicitly set MH_ASR_DEVICE; the result was
  # parakeet loading on CPU and adding several hundred ms of ASR latency
  # for each VAD utterance. run-asr-worker.sh prefers MH_ASR_DEVICE over
  # ASR_DEVICE precisely so this kind of override survives.
  : "${MH_ASR_DEVICE:=cuda}"
  echo "[run-operator-stack] MH_ASR_DEVICE=${MH_ASR_DEVICE}"
  start_proc "asr-worker" \
    env ASR_HOST="$ASR_HOST" ASR_PORT="$ASR_PORT" MH_ASR_DEVICE="$MH_ASR_DEVICE" \
    ./scripts/run-asr-worker.sh
fi

if [[ "${MH_ATOM_VAD_BACKEND}" == "silero" && "${MH_STACK_START_SILERO_VAD}" != "0" ]]; then
  if [[ -x "./scripts/run-silero-vad-worker.sh" ]]; then
    start_proc "silero-vad-worker" \
      env SILERO_VAD_HOST="$SILERO_VAD_HOST" SILERO_VAD_PORT="$SILERO_VAD_PORT" \
      ./scripts/run-silero-vad-worker.sh
  else
    echo "[run-operator-stack] MH_ATOM_VAD_BACKEND=silero but ./scripts/run-silero-vad-worker.sh is missing or not executable; relying on an externally-started worker at ${MH_SILERO_VAD_BASE_URL}"
  fi
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
  MH_TTS_CHUNK_MAX_CHARS="$MH_TTS_CHUNK_MAX_CHARS" \
  MH_KOKORO_VOICE="$MH_KOKORO_VOICE" \
  MH_TTS_CAPTURE_ANOMALY="$MH_TTS_CAPTURE_ANOMALY" \
  MH_ATOM_VAD_BACKEND="$MH_ATOM_VAD_BACKEND" \
  MH_SILERO_VAD_BASE_URL="$MH_SILERO_VAD_BASE_URL" \
  MH_OPERATOR_REALTIME_ASR_ENABLED="$MH_OPERATOR_REALTIME_ASR_ENABLED" \
  MH_OPERATOR_REALTIME_ASR_WS_URL="$MH_OPERATOR_REALTIME_ASR_WS_URL" \
  MH_OPERATOR_REALTIME_ASR_MODEL="$MH_OPERATOR_REALTIME_ASR_MODEL" \
  ./scripts/run-face-app.sh --audio-target "$FACE_AUDIO_TARGET" --ui-mode "$FACE_UI_MODE"

# Ensure the AtomS3R PC->Atom bridge is up. Best-effort and decoupled from
# the stack supervisor (a missing/offline Atom must never stop the stack);
# idempotent, so every operator bring-up keeps the Atom from going silent.
./scripts/ensure-atoms3r-bridge.sh || true

start_proc "operator-bridge" \
  env MH_BRIDGE_TMUX_PANE="${MH_BRIDGE_TMUX_PANE:-}" MH_BRIDGE_RECOVERY_TMUX_PANE="${MH_BRIDGE_RECOVERY_TMUX_PANE:-}" MH_BRIDGE_WS_URL="$FACE_WS_URL" \
  ./scripts/run-operator-bridge.sh

if [[ "${MH_STACK_START_MCP}" == "1" ]]; then
  start_proc "mcp-server" \
    env FACE_WS_URL="$FACE_WS_URL" MH_FACE_AGENT_ID="$MH_OPERATOR_FACE_AGENT_ID" MH_FACE_AGENT_LABEL="$MH_OPERATOR_FACE_AGENT_LABEL" \
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
