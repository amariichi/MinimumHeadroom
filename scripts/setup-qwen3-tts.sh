#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VENV_DIR="${QWEN3_TTS_VENV:-$ROOT_DIR/.venv-qwen-tts}"
PYTHON_VERSION="${QWEN3_TTS_PYTHON:-3.12}"
CACHE_ROOT="${QWEN3_TTS_HF_HOME:-${HF_HOME:-$HOME/.cache/huggingface}}"
MODEL_ID="${MH_QWEN_TTS_MODEL:-Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice}"
MODEL_REVISION="${MH_QWEN_TTS_MODEL_REVISION:-85e237c12c027371202489a0ec509ded67b5e4b5}"
INSTALL_MANIFEST="${QWEN3_TTS_INSTALL_MANIFEST:-$ROOT_DIR/.local/state/interpreter/qwen3-tts.json}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: ./scripts/setup-qwen3-tts.sh [options]

Options:
  --venv PATH      Dedicated virtualenv path (default: ./.venv-qwen-tts)
  --cache-dir PATH Hugging Face home containing the pinned snapshot
  --dry-run        Print exact package/model work without changing files
  -h, --help       Show this help

Pinned runtime:
  qwen-tts==0.1.1
  torch==2.10.0
  transformers==4.57.3
  Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
  revision 85e237c12c027371202489a0ec509ded67b5e4b5

Setup explicitly prefetches about 2.4 GiB. Normal runtime forces offline and
passes local_files_only=True, so a missing snapshot fails instead of downloading.
EOF
}

while (($# > 0)); do
  case "$1" in
    --venv)
      [[ -n "${2:-}" ]] || { echo "[setup-qwen3-tts] --venv requires a value" >&2; exit 2; }
      VENV_DIR="$2"
      shift 2
      ;;
    --venv=*)
      VENV_DIR="${1#*=}"
      shift
      ;;
    --cache-dir)
      [[ -n "${2:-}" ]] || { echo "[setup-qwen3-tts] --cache-dir requires a value" >&2; exit 2; }
      CACHE_ROOT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
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

echo "[setup-qwen3-tts] venv=${VENV_DIR}"
echo "[setup-qwen3-tts] cache=${CACHE_ROOT}"
echo "[setup-qwen3-tts] packages=qwen-tts==0.1.1 torch==2.10.0 transformers==4.57.3"
echo "[setup-qwen3-tts] model=${MODEL_ID}@${MODEL_REVISION}"
if ((DRY_RUN == 1)); then
  echo "[setup-qwen3-tts] dry-run: would install pinned packages, prefetch about 2.4 GiB, and run an offline load smoke"
  exit 0
fi

command -v uv >/dev/null 2>&1 || {
  echo "[setup-qwen3-tts] uv is required" >&2
  exit 2
}

uv venv "$VENV_DIR" --python "$PYTHON_VERSION" --seed
PYTHON_BIN="$VENV_DIR/bin/python"
uv pip install --python "$PYTHON_BIN" \
  "qwen-tts==0.1.1" \
  "torch==2.10.0" \
  "transformers==4.57.3" \
  "numpy" \
  "sounddevice" \
  "soundfile"

HF_HOME="$CACHE_ROOT" "$PYTHON_BIN" - "$MODEL_ID" "$MODEL_REVISION" <<'PY'
from huggingface_hub import snapshot_download
import sys

snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2])
PY

SNAPSHOT_DIR="$CACHE_ROOT/hub/models--Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice/snapshots/$MODEL_REVISION"
node "$ROOT_DIR/scripts/write-model-install-manifest.mjs" \
  --root "$SNAPSHOT_DIR" \
  --output "$INSTALL_MANIFEST" \
  --model "$MODEL_ID" \
  --revision "$MODEL_REVISION"

echo "[setup-qwen3-tts] validating offline model load"
QWEN3_TTS_VENV="$VENV_DIR" \
HF_HOME="$CACHE_ROOT" \
HF_HUB_OFFLINE=1 \
TRANSFORMERS_OFFLINE=1 \
MH_QWEN_TTS_MODEL="$MODEL_ID" \
MH_QWEN_TTS_MODEL_REVISION="$MODEL_REVISION" \
TTS_ENGINE=qwen3 \
./scripts/run-tts-worker.sh --smoke

echo "[setup-qwen3-tts] done"
