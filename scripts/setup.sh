#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WITH_REALTIME_ASR=0
WITH_QWEN3_TTS=0

usage() {
  cat <<'EOF'
Usage: ./scripts/setup.sh [--with-realtime-asr] [--with-qwen3-tts]

Options:
  --with-realtime-asr  Also install the optional vLLM + Voxtral realtime ASR environment.
  --with-qwen3-tts     Also install the optional dedicated Qwen3-TTS environment.
  -h, --help           Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --with-realtime-asr)
      WITH_REALTIME_ASR=1
      shift
      ;;
    --with-qwen3-tts)
      WITH_QWEN3_TTS=1
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

if [[ "$WITH_QWEN3_TTS" == "1" ]]; then
  echo "[setup] installing optional Qwen3-TTS environment"
  ./scripts/setup-qwen3-tts.sh
else
  echo "[setup] skipping optional Qwen3-TTS setup (use --with-qwen3-tts to include Qwen3-TTS)"
fi

echo "[setup] done"
