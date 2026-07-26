#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VENV_DIR="${NEMOTRON_ASR_VENV:-$ROOT_DIR/.venv-nemotron-asr}"
PYTHON_BIN="$VENV_DIR/bin/python"
HOST="${NEMOTRON_ASR_HOST:-127.0.0.1}"
PORT="${NEMOTRON_ASR_PORT:-8095}"
MODEL_ID="${NEMOTRON_ASR_MODEL_ID:-nvidia/nemotron-3.5-asr-streaming-0.6b}"
MODEL_REVISION="${NEMOTRON_ASR_MODEL_REVISION:-f3d333391852ba876df169dcc9ba902d25b6ab0b}"
CACHE_DIR="${NEMOTRON_ASR_CACHE_DIR:-$ROOT_DIR/.cache/huggingface}"
DEVICE="${NEMOTRON_ASR_DEVICE:-cuda}"
SMOKE=0

usage() {
  cat <<'EOF'
Usage: ./scripts/run-nemotron-asr.sh [--host HOST] [--port PORT] [--smoke]

Starts the pinned Nemotron 3.5 ASR worker in forced offline mode.
Run ./scripts/setup-nemotron-asr.sh first. Startup never downloads a model.
EOF
}

while (($# > 0)); do
  case "$1" in
    --host)
      [[ -n "${2:-}" ]] || { echo "[run-nemotron-asr] --host requires a value" >&2; exit 2; }
      HOST="$2"
      shift 2
      ;;
    --port)
      [[ -n "${2:-}" ]] || { echo "[run-nemotron-asr] --port requires a value" >&2; exit 2; }
      PORT="$2"
      shift 2
      ;;
    --smoke)
      SMOKE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[run-nemotron-asr] unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "[run-nemotron-asr] missing environment: ${VENV_DIR}" >&2
  echo "[run-nemotron-asr] run ./scripts/setup-nemotron-asr.sh first" >&2
  exit 2
fi

export PYTHONPATH="$ROOT_DIR/interpreter-asr-worker/src${PYTHONPATH:+:$PYTHONPATH}"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export HF_DATASETS_OFFLINE=1
export NEMOTRON_ASR_MODEL_ID="$MODEL_ID"
export NEMOTRON_ASR_MODEL_REVISION="$MODEL_REVISION"
export NEMOTRON_ASR_CACHE_DIR="$CACHE_DIR"
export NEMOTRON_ASR_DEVICE="$DEVICE"

echo "[run-nemotron-asr] model=${MODEL_ID}@${MODEL_REVISION} device=${DEVICE} offline=true"
if ((SMOKE == 1)); then
  exec "$PYTHON_BIN" -m interpreter_asr_worker --smoke
fi
exec "$PYTHON_BIN" -m interpreter_asr_worker --host "$HOST" --port "$PORT"
