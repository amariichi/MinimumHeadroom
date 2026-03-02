#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VENV_DIR="${QWEN3_TTS_VENV:-$ROOT_DIR/.venv-qwen-tts}"
PYTHON_VERSION="${QWEN3_TTS_PYTHON:-3.12}"
PYTHON_BIN=""

usage() {
  cat <<'EOF'
Usage: ./scripts/setup-qwen3-tts.sh [--venv PATH]

Options:
  --venv PATH  Override the virtualenv path (default: ./.venv-qwen-tts)
  -h, --help   Show this help

Environment:
  QWEN3_TTS_VENV:    Optional virtualenv path
  QWEN3_TTS_PYTHON:  Python version for uv venv (default: 3.12)

This installs an optional dedicated environment for Qwen3-TTS so the main
tts-worker project can stay lightweight and Kokoro-focused.
EOF
}

while (($# > 0)); do
  case "$1" in
    --venv)
      if (($# < 2)); then
        echo "[setup-qwen3-tts] --venv requires a value" >&2
        exit 2
      fi
      VENV_DIR="$2"
      shift 2
      ;;
    --venv=*)
      VENV_DIR="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[setup-qwen3-tts] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

echo "[setup-qwen3-tts] root: $ROOT_DIR"
echo "[setup-qwen3-tts] venv: $VENV_DIR"

uv --version
uv venv "$VENV_DIR" --python "$PYTHON_VERSION" --seed

PYTHON_BIN="$VENV_DIR/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "[setup-qwen3-tts] failed to create python at $PYTHON_BIN" >&2
  exit 1
fi

echo "[setup-qwen3-tts] upgrading packaging tools"
uv pip install --python "$PYTHON_BIN" -U pip setuptools wheel

echo "[setup-qwen3-tts] installing Qwen3-TTS runtime"
uv pip install --python "$PYTHON_BIN" -U qwen-tts numpy sounddevice soundfile

echo "[setup-qwen3-tts] import smoke"
"$PYTHON_BIN" -c "import qwen_tts, numpy, sounddevice, soundfile; print('Qwen3 TTS setup: imports OK')"

echo "[setup-qwen3-tts] done"
echo "[setup-qwen3-tts] try: TTS_ENGINE=qwen3 ./scripts/run-tts-worker.sh --smoke"
