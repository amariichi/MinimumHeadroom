#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${STACKCHAN_START_ASR_WORKER:=1}"
: "${STACKCHAN_START_LLM:=1}"
: "${STACKCHAN_ASR_WORKER_HOST:=127.0.0.1}"
: "${STACKCHAN_ASR_WORKER_PORT:=8091}"
: "${STACKCHAN_ASR_ADAPTER_HOST:=0.0.0.0}"
: "${STACKCHAN_ASR_ADAPTER_PORT:=8081}"
: "${STACKCHAN_TTS_ADAPTER_HOST:=0.0.0.0}"
: "${STACKCHAN_TTS_ADAPTER_PORT:=5000}"
: "${STACKCHAN_KOKORO_VOICE:=af_heart}"
: "${STACKCHAN_ASR_DEVICE:=cuda}"
ASR_DEVICE="$STACKCHAN_ASR_DEVICE"
: "${ASR_SINGLE_MODEL_CACHE:=true}"
: "${ASR_PRELOAD_MODELS:=false}"
: "${ASR_MODEL_JA:=nvidia/parakeet-tdt_ctc-0.6b-ja}"
: "${ASR_MODEL_EN:=nvidia/parakeet-tdt-0.6b-v2}"
: "${ASR_MODEL_FAST:=nvidia/parakeet-tdt-0.6b-v2}"
: "${LLAMA_HOST:=0.0.0.0}"
: "${LLAMA_PORT:=8080}"
: "${LLAMA_CTX_SIZE:=8192}"
: "${LLAMA_PARALLEL:=1}"
: "${LLAMA_GPU_LAYERS:=-1}"
: "${LLAMA_FLASH_ATTN:=on}"
: "${LLAMA_JINJA:=1}"
: "${LLAMA_REASONING:=off}"
: "${LLAMA_THREADS:=}"
: "${LLAMA_EXTRA_ARGS:=}"

DEFAULT_QWEN_MODEL="$HOME/models/unsloth/Qwen3.6-35B-A3B/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf"
if [[ -z "${STACKCHAN_LLM_MODEL_PATH:-}" && -f "$DEFAULT_QWEN_MODEL" ]]; then
  STACKCHAN_LLM_MODEL_PATH="$DEFAULT_QWEN_MODEL"
fi

declare -a PIDS=()
declare -A NAMES=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do
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
  echo "[stackchan-sidecar] started ${name} (pid=${pid})"
}

resolve_llama_server() {
  if [[ -n "${LLAMA_SERVER_BIN:-}" ]]; then
    printf '%s\n' "$LLAMA_SERVER_BIN"
    return 0
  fi

  local candidates=(
    "$ROOT_DIR/../llama.cpp/build/bin/llama-server"
    "$ROOT_DIR/llama.cpp/build/bin/llama-server"
    "$HOME/github/llama.cpp/build/bin/llama-server"
    "$HOME/.local/llama.cpp/build/bin/llama-server"
  )
  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v llama-server >/dev/null 2>&1; then
    command -v llama-server
    return 0
  fi

  return 1
}

detect_host_ip() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -n "$ip" ]]; then
    printf '%s\n' "$ip"
  else
    printf '127.0.0.1\n'
  fi
}

LAN_HOST="$(detect_host_ip)"
ASR_BASE_URL="http://${STACKCHAN_ASR_WORKER_HOST}:${STACKCHAN_ASR_WORKER_PORT}"

echo "[stackchan-sidecar] root=${ROOT_DIR}"
echo "[stackchan-sidecar] LAN host guess=${LAN_HOST}"
echo "[stackchan-sidecar] ASR device=${ASR_DEVICE}"

if [[ "$STACKCHAN_START_ASR_WORKER" == "1" ]]; then
  start_proc "asr-worker" \
    env ASR_HOST="$STACKCHAN_ASR_WORKER_HOST" ASR_PORT="$STACKCHAN_ASR_WORKER_PORT" \
    ASR_DEVICE="$ASR_DEVICE" \
    ASR_SINGLE_MODEL_CACHE="$ASR_SINGLE_MODEL_CACHE" \
    ASR_PRELOAD_MODELS="$ASR_PRELOAD_MODELS" \
    ASR_MODEL_JA="$ASR_MODEL_JA" \
    ASR_MODEL_EN="$ASR_MODEL_EN" \
    ASR_MODEL_FAST="$ASR_MODEL_FAST" \
    ./scripts/run-asr-worker.sh
else
  echo "[stackchan-sidecar] skipping asr-worker startup (STACKCHAN_START_ASR_WORKER=0)"
fi

start_proc "stackchan-asr-adapter" \
  python3 integrations/stackchan-minimal/stackchan_asr_adapter.py \
    --host "$STACKCHAN_ASR_ADAPTER_HOST" \
    --port "$STACKCHAN_ASR_ADAPTER_PORT" \
    --asr-base-url "$ASR_BASE_URL" \
    --language ja

start_proc "stackchan-tts-adapter" \
  uv run --project tts-worker python "$ROOT_DIR/integrations/stackchan-minimal/stackchan_tts_adapter.py" \
    --host "$STACKCHAN_TTS_ADAPTER_HOST" \
    --port "$STACKCHAN_TTS_ADAPTER_PORT" \
    --voice "$STACKCHAN_KOKORO_VOICE" \
    --repo-root "$ROOT_DIR"

if [[ "$STACKCHAN_START_LLM" == "1" ]]; then
  if [[ -z "${STACKCHAN_LLM_MODEL_PATH:-}" ]]; then
    echo "[stackchan-sidecar] STACKCHAN_LLM_MODEL_PATH is required when STACKCHAN_START_LLM=1" >&2
    exit 2
  fi
  if [[ ! -f "$STACKCHAN_LLM_MODEL_PATH" ]]; then
    echo "[stackchan-sidecar] model file not found: $STACKCHAN_LLM_MODEL_PATH" >&2
    exit 2
  fi
  if ! LLAMA_BIN="$(resolve_llama_server)"; then
    echo "[stackchan-sidecar] llama-server not found. Set LLAMA_SERVER_BIN=/path/to/llama-server." >&2
    exit 2
  fi

  declare -a llama_cmd=(
    "$LLAMA_BIN"
    -m "$STACKCHAN_LLM_MODEL_PATH"
    --host "$LLAMA_HOST"
    --port "$LLAMA_PORT"
    -c "$LLAMA_CTX_SIZE"
    --parallel "$LLAMA_PARALLEL"
    --flash-attn "$LLAMA_FLASH_ATTN"
    -ngl "$LLAMA_GPU_LAYERS"
    --reasoning "$LLAMA_REASONING"
  )
  if [[ "$LLAMA_JINJA" == "1" || "${LLAMA_JINJA,,}" == "true" || "${LLAMA_JINJA,,}" == "yes" || "${LLAMA_JINJA,,}" == "on" ]]; then
    llama_cmd+=(--jinja)
  fi
  if [[ -n "$LLAMA_THREADS" ]]; then
    llama_cmd+=(-t "$LLAMA_THREADS")
  fi
  if [[ -n "$LLAMA_EXTRA_ARGS" ]]; then
    read -r -a extra_args <<< "$LLAMA_EXTRA_ARGS"
    llama_cmd+=("${extra_args[@]}")
  fi

  start_proc "llama-server" "${llama_cmd[@]}"
else
  echo "[stackchan-sidecar] skipping llama-server startup (STACKCHAN_START_LLM=0)"
fi

cat <<EOF
[stackchan-sidecar] StackChan Minimal settings:
  STT IP:      ${LAN_HOST}
  STT port:    ${STACKCHAN_ASR_ADAPTER_PORT}
  STT path:    /inference
  TTS IP:      ${LAN_HOST}
  TTS port:    ${STACKCHAN_TTS_ADAPTER_PORT}
  LLM base:    http://${LAN_HOST}:${LLAMA_PORT}/v1

[stackchan-sidecar] Press Ctrl+C to stop services started by this script.
EOF

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
    echo "[stackchan-sidecar] ${NAMES[$exited_pid]:-service} exited (pid=${exited_pid}, code=${exit_code}). stopping others."
    break
  fi
done

exit "$exit_code"
