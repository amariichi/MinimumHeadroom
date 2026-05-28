#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SILERO_VAD_HOST="${SILERO_VAD_HOST:-127.0.0.1}"
SILERO_VAD_PORT="${SILERO_VAD_PORT:-8092}"
SMOKE_MODE=0

usage() {
  cat <<'EOF'
Usage: ./scripts/run-silero-vad-worker.sh [--host HOST] [--port PORT] [--smoke]

Options:
  --host   Bind host (default: 127.0.0.1)
  --port   Bind port (default: 8092)
  --smoke  Import the silero-vad module and exit (no network bind)
  -h, --help  Show this help

Environment defaults:
  SILERO_DEVICE / MH_SILERO_DEVICE: cpu (silero is tiny; CPU avoids GPU
                                         launch overhead)
EOF
}

while (($# > 0)); do
  case "$1" in
    --host)
      if (($# < 2)); then
        echo "[run-silero-vad-worker] --host requires a value" >&2
        exit 2
      fi
      SILERO_VAD_HOST="$2"
      shift 2
      ;;
    --port)
      if (($# < 2)); then
        echo "[run-silero-vad-worker] --port requires a value" >&2
        exit 2
      fi
      SILERO_VAD_PORT="$2"
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
      echo "[run-silero-vad-worker] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# Prefer MH_SILERO_DEVICE over SILERO_DEVICE for parity with how
# MH_ASR_DEVICE overrides ASR_DEVICE in run-asr-worker.sh.
SILERO_DEVICE="${MH_SILERO_DEVICE:-${SILERO_DEVICE:-cpu}}"

echo "[run-silero-vad-worker] SILERO_VAD_HOST=${SILERO_VAD_HOST} SILERO_VAD_PORT=${SILERO_VAD_PORT} SILERO_DEVICE=${SILERO_DEVICE}"

if ((SMOKE_MODE == 1)); then
  exec env \
    SILERO_DEVICE="$SILERO_DEVICE" \
    uv run --project silero-vad-worker python -m silero_vad_worker --smoke
fi

exec env \
  SILERO_DEVICE="$SILERO_DEVICE" \
  uv run --project silero-vad-worker python -m silero_vad_worker --host "$SILERO_VAD_HOST" --port "$SILERO_VAD_PORT"
