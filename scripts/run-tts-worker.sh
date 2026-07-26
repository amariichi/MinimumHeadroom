#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENGINE="${TTS_ENGINE:-kokoro}"
QWEN3_VENV="${QWEN3_TTS_VENV:-$ROOT_DIR/.venv-qwen-tts}"
SUPERTONIC_VENV="${SUPERTONIC_VENV:-$ROOT_DIR/.venv-supertonic}"

usage() {
  cat <<'EOF'
Usage: ./scripts/run-tts-worker.sh [--smoke]

Behavior:
  TTS_ENGINE=kokoro  Run the existing tts-worker via uv and the tts-worker project.
  TTS_ENGINE=qwen3   Run the worker with the optional dedicated Qwen3 virtualenv.
  TTS_ENGINE=supertonic
                     Run the CPU Supertonic worker in its dedicated virtualenv.

Environment:
  TTS_ENGINE: defaults to kokoro
  MH_KOKORO_VOICE: Kokoro voice override, for example jf_alpha or af_heart
  QWEN3_TTS_VENV: path to the optional Qwen3 virtualenv (default: ./.venv-qwen-tts)
  SUPERTONIC_VENV: path to the Supertonic virtualenv (default: ./.venv-supertonic)
EOF
}

if (($# > 0)); then
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
  esac
fi

case "${ENGINE,,}" in
  kokoro)
    exec uv run --project tts-worker python -m tts_worker "$@"
    ;;
  qwen3)
    PYTHON_BIN="$QWEN3_VENV/bin/python"
    if [[ ! -x "$PYTHON_BIN" ]]; then
      echo "[run-tts-worker] missing Qwen3 virtualenv: $QWEN3_VENV" >&2
      echo "[run-tts-worker] run ./scripts/setup-qwen3-tts.sh first, or set QWEN3_TTS_VENV." >&2
      exit 2
    fi

    if [[ -n "${PYTHONPATH:-}" ]]; then
      export PYTHONPATH="$ROOT_DIR/tts-worker/src:$PYTHONPATH"
    else
      export PYTHONPATH="$ROOT_DIR/tts-worker/src"
    fi
    export HF_HUB_OFFLINE=1
    export TRANSFORMERS_OFFLINE=1

    exec "$PYTHON_BIN" -m tts_worker "$@"
    ;;
  supertonic)
    PYTHON_BIN="$SUPERTONIC_VENV/bin/python"
    if [[ ! -x "$PYTHON_BIN" ]]; then
      echo "[run-tts-worker] missing Supertonic virtualenv: $SUPERTONIC_VENV" >&2
      echo "[run-tts-worker] run ./scripts/setup-supertonic.sh first, or set SUPERTONIC_VENV." >&2
      exit 2
    fi
    if [[ -n "${PYTHONPATH:-}" ]]; then
      export PYTHONPATH="$ROOT_DIR/tts-worker/src:$PYTHONPATH"
    else
      export PYTHONPATH="$ROOT_DIR/tts-worker/src"
    fi
    export HF_HUB_OFFLINE=1
    export TRANSFORMERS_OFFLINE=1
    exec "$PYTHON_BIN" -m tts_worker "$@"
    ;;
  *)
    echo "[run-tts-worker] unsupported TTS_ENGINE: $ENGINE (expected kokoro|qwen3|supertonic)" >&2
    exit 2
    ;;
esac
