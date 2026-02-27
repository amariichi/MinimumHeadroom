#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ASR_HOST="${ASR_HOST:-127.0.0.1}"
ASR_PORT="${ASR_PORT:-8091}"
SMOKE_MODE=0

usage() {
  cat <<'EOF'
Usage: ./scripts/run-asr-worker.sh [--host HOST] [--port PORT] [--smoke]

Options:
  --host   Bind host for ASR worker (default: 127.0.0.1)
  --port   Bind port for ASR worker (default: 8091)
  --smoke  Run import smoke test and exit
  -h, --help  Show this help

Environment defaults:
  ASR_DEVICE: defaults to cuda on Linux, cpu on macOS when unset
  ASR_SINGLE_MODEL_CACHE: true
  ASR_PRELOAD_MODELS: false
EOF
}

while (($# > 0)); do
  case "$1" in
    --host)
      if (($# < 2)); then
        echo "[run-asr-worker] --host requires a value" >&2
        exit 2
      fi
      ASR_HOST="$2"
      shift 2
      ;;
    --port)
      if (($# < 2)); then
        echo "[run-asr-worker] --port requires a value" >&2
        exit 2
      fi
      ASR_PORT="$2"
      shift 2
      ;;
    --smoke)
      SMOKE_MODE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[run-asr-worker] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${ASR_DEVICE:-}" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    ASR_DEVICE="cpu"
  else
    ASR_DEVICE="cuda"
  fi
fi

: "${ASR_SINGLE_MODEL_CACHE:=true}"
: "${ASR_PRELOAD_MODELS:=false}"

echo "[run-asr-worker] ASR_HOST=${ASR_HOST} ASR_PORT=${ASR_PORT} ASR_DEVICE=${ASR_DEVICE} ASR_SINGLE_MODEL_CACHE=${ASR_SINGLE_MODEL_CACHE} ASR_PRELOAD_MODELS=${ASR_PRELOAD_MODELS}"

if ((SMOKE_MODE == 1)); then
  exec env \
    ASR_DEVICE="$ASR_DEVICE" \
    ASR_SINGLE_MODEL_CACHE="$ASR_SINGLE_MODEL_CACHE" \
    ASR_PRELOAD_MODELS="$ASR_PRELOAD_MODELS" \
    uv run --project asr-worker asr-worker --smoke
fi

exec env \
  ASR_DEVICE="$ASR_DEVICE" \
  ASR_SINGLE_MODEL_CACHE="$ASR_SINGLE_MODEL_CACHE" \
  ASR_PRELOAD_MODELS="$ASR_PRELOAD_MODELS" \
  uv run --project asr-worker asr-worker --host "$ASR_HOST" --port "$ASR_PORT"
