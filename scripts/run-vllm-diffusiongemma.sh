#!/usr/bin/env bash
# =============================================================================
#  run-vllm-diffusiongemma.sh — serve nvidia/diffusiongemma-26B-A4B-it-NVFP4
#  on an OpenAI-compatible endpoint (default http://127.0.0.1:8000/v1) for the
#  vision-worker. Owned entirely by this repository (no dependency on any other
#  repo). EXPERIMENTAL: needs an NVIDIA Blackwell/Hopper GPU + NVFP4.
#
#  Backends:
#    docker (default) — run the pinned pre-release vLLM image, start/stop/status.
#    venv             — `vllm serve` from .venv-vllm-dgemma (documented fallback).
#
#  Usage:
#    ./scripts/run-vllm-diffusiongemma.sh [start|stop|status] [--backend docker|venv]
#  Then point the worker at it:
#    VISION_MODEL_BACKEND=diffusiongemma VISION_MODEL_URL=http://127.0.0.1:8000/v1 \
#      ./scripts/run-vision-worker.sh
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND="${VLLM_DGEMMA_BACKEND:-docker}"
NAME="${VLLM_DGEMMA_NAME:-dgemma}"
PORT="${VLLM_DGEMMA_PORT:-8000}"
MODEL="${VLLM_DGEMMA_MODEL:-nvidia/diffusiongemma-26B-A4B-it-NVFP4}"
IMAGE="${VLLM_DGEMMA_IMAGE:-vllm/vllm-openai@sha256:9c719fc0c869092c7d0533f8357d6985a38d5ff03b20ffb6a4620c2b4806dd4b}"
HF_CACHE="${HF_HOME:-$ROOT_DIR/.cache/huggingface}"
GPU_MEM_UTIL="${VLLM_DGEMMA_GPU_MEM_UTIL:-0.75}"
MAX_MODEL_LEN="${VLLM_DGEMMA_MAX_MODEL_LEN:-8192}"
MAX_NUM_SEQS="${VLLM_DGEMMA_MAX_NUM_SEQS:-4}"
VENV_DIR="${VLLM_DGEMMA_VENV_DIR:-$ROOT_DIR/.venv-vllm-dgemma}"
ACTION="start"

# Tiny 64x64 PNG to warm the vision+decode path (the first request is otherwise
# slow and lower quality due to one-time compile work).
WARMUP_PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAh0lEQVR4nO3asQ3CQBAAQR65GOqgApdDRODIZVAJtZE6NEJo9NJOfC/d6tIft/V1mdlVL/CrArQCtAK0ArQCtAK0ArQCtAK0ArTl2wfvbf/HHkf35+P88PQXKEArQCtAK0ArQCtAK0ArQCtAK0ArQCtAK0ArQCtAmz5g9OEJK0ArQCtAK0ArQCtAmz7gAyiYBbEBQEuCAAAAAElFTkSuQmCC"

usage() {
  cat <<'EOF'
Usage: ./scripts/run-vllm-diffusiongemma.sh [start|stop|status] [--backend docker|venv]

  start    Start (default; idempotent + warmup).
  stop     Stop & remove the container (docker backend only).
  status   Show status.
  --backend docker|venv   Override $VLLM_DGEMMA_BACKEND (default docker).
  -h, --help              Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    start|stop|status) ACTION="$1"; shift ;;
    --backend)
      if (($# < 2)); then echo "[run-vllm-diffusiongemma] --backend requires a value" >&2; exit 2; fi
      BACKEND="$2"; shift 2 ;;
    --backend=*) BACKEND="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[run-vllm-diffusiongemma] unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

wait_ready() {
  printf '[run-vllm-diffusiongemma] loading'
  for _ in $(seq 1 240); do
    if curl -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then echo " ready"; return 0; fi
    printf '.'; sleep 3
  done
  echo; echo "[run-vllm-diffusiongemma] startup timeout" >&2; return 1
}

warmup() {
  printf '{"model":"%s","messages":[{"role":"user","content":[{"type":"text","text":"describe"},{"type":"image_url","image_url":{"url":"data:image/png;base64,%s"}}]}],"max_tokens":64}' \
    "$MODEL" "$WARMUP_PNG_B64" \
    | curl -fsS "http://127.0.0.1:$PORT/v1/chat/completions" -H 'Content-Type: application/json' --data @- >/dev/null 2>&1 || true
}

docker_running() { [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || true)" = "true" ]; }

case "$BACKEND" in
  docker)
    command -v docker >/dev/null || { echo "[run-vllm-diffusiongemma] docker not found" >&2; exit 2; }
    case "$ACTION" in
      status) docker_running && echo "running -> http://127.0.0.1:$PORT/v1" || echo "not running"; exit 0 ;;
      stop) docker rm -f "$NAME" >/dev/null 2>&1 && echo "stopped ($NAME)" || echo "(not running)"; exit 0 ;;
    esac
    if docker_running; then echo "[run-vllm-diffusiongemma] already running -> http://127.0.0.1:$PORT/v1"; exit 0; fi
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    mkdir -p "$HF_CACHE"
    echo "[run-vllm-diffusiongemma] starting $NAME (model=$MODEL, port=$PORT, first load takes minutes)..."
    docker run -d --name "$NAME" --gpus all \
      -v "$HF_CACHE:/root/.cache/huggingface" \
      -p "$PORT:8000" \
      -e VLLM_USE_V2_MODEL_RUNNER=1 \
      -e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
      "$IMAGE" "$MODEL" \
      --trust-remote-code \
      --max-num-seqs "$MAX_NUM_SEQS" \
      --max-model-len "$MAX_MODEL_LEN" \
      --gpu-memory-utilization "$GPU_MEM_UTIL" \
      --attention-backend TRITON_ATTN \
      --enable-auto-tool-choice \
      --tool-call-parser gemma4 \
      --reasoning-parser gemma4 \
      --override-generation-config '{"max_new_tokens": null}' \
      --default-chat-template-kwargs '{"enable_thinking":false}' >/dev/null
    wait_ready || { docker logs --tail 30 "$NAME" || true; exit 1; }
    echo "[run-vllm-diffusiongemma] warming up..."; warmup
    echo "[run-vllm-diffusiongemma] ready -> http://127.0.0.1:$PORT/v1"
    ;;
  venv)
    if [[ "$ACTION" == "stop" || "$ACTION" == "status" ]]; then
      echo "[run-vllm-diffusiongemma] $ACTION is not supported for the venv backend; manage the process directly." >&2
      exit 2
    fi
    if [[ ! -x "$VENV_DIR/bin/vllm" ]]; then
      echo "[run-vllm-diffusiongemma] vLLM not installed in $VENV_DIR; run ./scripts/setup-vllm-diffusiongemma.sh --backend venv first" >&2
      exit 2
    fi
    mkdir -p "$HF_CACHE"
    echo "[run-vllm-diffusiongemma] serving $MODEL from $VENV_DIR on :$PORT"
    exec env HF_HOME="$HF_CACHE" \
      "$VENV_DIR/bin/vllm" serve "$MODEL" \
      --host 127.0.0.1 --port "$PORT" \
      --trust-remote-code \
      --max-num-seqs "$MAX_NUM_SEQS" \
      --max-model-len "$MAX_MODEL_LEN" \
      --gpu-memory-utilization "$GPU_MEM_UTIL"
    ;;
  *)
    echo "[run-vllm-diffusiongemma] unknown backend: $BACKEND (expected docker|venv)" >&2
    exit 2 ;;
esac
