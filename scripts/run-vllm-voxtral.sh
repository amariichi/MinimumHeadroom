#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST="${REALTIME_ASR_HOST:-127.0.0.1}"
PORT="${REALTIME_ASR_PORT:-8090}"
MODEL="${REALTIME_ASR_MODEL:-mistralai/Voxtral-Mini-4B-Realtime-2602}"
VENV_DIR="${REALTIME_ASR_VENV_DIR:-$ROOT_DIR/.venv-vllm}"
HF_HOME="${REALTIME_ASR_HF_HOME:-$ROOT_DIR/.cache/huggingface}"
VLLM_CONFIG_ROOT="${REALTIME_ASR_VLLM_CONFIG_ROOT:-$ROOT_DIR/.cache/vllm}"
GPU_MEMORY_UTILIZATION="${REALTIME_ASR_GPU_MEMORY_UTILIZATION:-0.88}"
COMPILATION_CONFIG="${REALTIME_ASR_COMPILATION_CONFIG:-{\"cudagraph_mode\":\"PIECEWISE\"}}"
USE_EAGER=0

usage() {
  cat <<'EOF'
Usage: ./scripts/run-vllm-voxtral.sh [options]

Options:
  --host <host>          Bind host (default: 127.0.0.1)
  --port <port>          Bind port (default: 8090)
  --model <name>         Model id (default: mistralai/Voxtral-Mini-4B-Realtime-2602)
  --venv-dir <path>      Virtualenv path (default: ./.venv-vllm)
  --hf-home <path>       Hugging Face cache root (default: ./.cache/huggingface)
  --gpu-memory-utilization <n>
                         vLLM gpu_memory_utilization (default: 0.88)
  --enforce-eager        Use --enforce-eager instead of compilation_config
  -h, --help             Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --host)
      if (($# < 2)); then
        echo "[run-vllm-voxtral] --host requires a value" >&2
        exit 2
      fi
      HOST="$2"
      shift 2
      ;;
    --host=*)
      HOST="${1#*=}"
      shift
      ;;
    --port)
      if (($# < 2)); then
        echo "[run-vllm-voxtral] --port requires a value" >&2
        exit 2
      fi
      PORT="$2"
      shift 2
      ;;
    --port=*)
      PORT="${1#*=}"
      shift
      ;;
    --model)
      if (($# < 2)); then
        echo "[run-vllm-voxtral] --model requires a value" >&2
        exit 2
      fi
      MODEL="$2"
      shift 2
      ;;
    --model=*)
      MODEL="${1#*=}"
      shift
      ;;
    --venv-dir)
      if (($# < 2)); then
        echo "[run-vllm-voxtral] --venv-dir requires a value" >&2
        exit 2
      fi
      VENV_DIR="$2"
      shift 2
      ;;
    --venv-dir=*)
      VENV_DIR="${1#*=}"
      shift
      ;;
    --hf-home)
      if (($# < 2)); then
        echo "[run-vllm-voxtral] --hf-home requires a value" >&2
        exit 2
      fi
      HF_HOME="$2"
      shift 2
      ;;
    --hf-home=*)
      HF_HOME="${1#*=}"
      shift
      ;;
    --gpu-memory-utilization)
      if (($# < 2)); then
        echo "[run-vllm-voxtral] --gpu-memory-utilization requires a value" >&2
        exit 2
      fi
      GPU_MEMORY_UTILIZATION="$2"
      shift 2
      ;;
    --gpu-memory-utilization=*)
      GPU_MEMORY_UTILIZATION="${1#*=}"
      shift
      ;;
    --enforce-eager)
      USE_EAGER=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[run-vllm-voxtral] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -x "$VENV_DIR/bin/vllm" ]]; then
  cat >&2 <<EOF
[run-vllm-voxtral] vLLM is not installed in $VENV_DIR
Run ./scripts/setup-realtime-asr.sh first.
EOF
  exit 2
fi

mkdir -p "$HF_HOME" "$VLLM_CONFIG_ROOT"

declare -a EXTRA_ARGS
if [[ "$USE_EAGER" == "1" ]]; then
  EXTRA_ARGS=(--enforce-eager)
else
  EXTRA_ARGS=(--compilation_config "$COMPILATION_CONFIG")
fi

echo "[run-vllm-voxtral] host: $HOST"
echo "[run-vllm-voxtral] port: $PORT"
echo "[run-vllm-voxtral] model: $MODEL"
echo "[run-vllm-voxtral] hf cache: $HF_HOME"
echo "[run-vllm-voxtral] vllm config: $VLLM_CONFIG_ROOT"
echo "[run-vllm-voxtral] gpu memory utilization: $GPU_MEMORY_UTILIZATION"
echo "[run-vllm-voxtral] realtime ws: ws://${HOST}:${PORT}/v1/realtime"

exec env \
  HF_HOME="$HF_HOME" \
  VLLM_CONFIG_ROOT="$VLLM_CONFIG_ROOT" \
  VLLM_DISABLE_COMPILE_CACHE="${VLLM_DISABLE_COMPILE_CACHE:-1}" \
  "$VENV_DIR/bin/vllm" serve "$MODEL" \
  --host "$HOST" \
  --port "$PORT" \
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION" \
  "${EXTRA_ARGS[@]}"
