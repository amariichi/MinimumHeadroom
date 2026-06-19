#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VISION_HOST="${VISION_HOST:-127.0.0.1}"
VISION_PORT="${VISION_PORT:-8095}"
declare -a PASSTHROUGH=()

usage() {
  cat <<'EOF'
Usage: ./scripts/run-vision-worker.sh [--host HOST] [--port PORT] [--smoke] [--replay-once] [--replay]

Options:
  --host         Bind host (default: 127.0.0.1, or $VISION_HOST)
  --port         Bind port (default: 8095, or $VISION_PORT)
  --smoke        Run import + app-factory smoke test and exit
  --replay-once  Replay $VISION_FRAME_DIR through the pipeline once, then exit
  --replay       Continuously replay $VISION_FRAME_DIR (Ctrl+C to stop)
  -h, --help     Show this help

The worker is GPU-free with VISION_MODEL_BACKEND=mock (default). See README.md.
EOF
}

while (($# > 0)); do
  case "$1" in
    --host)
      if (($# < 2)); then echo "[run-vision-worker] --host requires a value" >&2; exit 2; fi
      VISION_HOST="$2"; shift 2 ;;
    --port)
      if (($# < 2)); then echo "[run-vision-worker] --port requires a value" >&2; exit 2; fi
      VISION_PORT="$2"; shift 2 ;;
    --smoke|--replay-once|--replay)
      PASSTHROUGH+=("$1"); shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "[run-vision-worker] unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

echo "[run-vision-worker] VISION_HOST=${VISION_HOST} VISION_PORT=${VISION_PORT} VISION_MODEL_BACKEND=${VISION_MODEL_BACKEND:-mock}"

exec env VISION_HOST="$VISION_HOST" VISION_PORT="$VISION_PORT" \
  uv run --project vision-worker python -m vision_worker \
  --host "$VISION_HOST" --port "$VISION_PORT" "${PASSTHROUGH[@]}"
