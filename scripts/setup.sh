#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WITH_REALTIME_ASR=0

usage() {
  cat <<'EOF'
Usage: ./scripts/setup.sh [--with-realtime-asr]

Options:
  --with-realtime-asr  Also install the optional vLLM + Voxtral realtime ASR environment.
  -h, --help           Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --with-realtime-asr)
      WITH_REALTIME_ASR=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[setup] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

echo "[setup] root: $ROOT_DIR"

echo "[setup] checking Node.js"
node --version

echo "[setup] checking uv"
uv --version

echo "[setup] syncing Python deps for tts-worker"
uv sync --project tts-worker

echo "[setup] syncing Python deps for asr-worker"
uv sync --project asr-worker --locked

if [[ "$WITH_REALTIME_ASR" == "1" ]]; then
  echo "[setup] installing optional realtime ASR environment"
  ./scripts/setup-realtime-asr.sh
else
  echo "[setup] skipping optional realtime ASR setup (use --with-realtime-asr to include vLLM + Voxtral)"
fi

echo "[setup] done"
