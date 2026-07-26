#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VENV_DIR="${NEMOTRON_ASR_VENV:-$ROOT_DIR/.venv-nemotron-asr}"
CACHE_DIR="${NEMOTRON_ASR_CACHE_DIR:-$ROOT_DIR/.cache/huggingface}"
INSTALL_MANIFEST="${NEMOTRON_ASR_INSTALL_MANIFEST:-$ROOT_DIR/.local/state/interpreter/nemotron-asr.json}"
MODEL_ID="${NEMOTRON_ASR_MODEL_ID:-nvidia/nemotron-3.5-asr-streaming-0.6b}"
MODEL_REVISION="${NEMOTRON_ASR_MODEL_REVISION:-f3d333391852ba876df169dcc9ba902d25b6ab0b}"
PYTHON_VERSION="${NEMOTRON_ASR_PYTHON:-3.11}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: ./scripts/setup-nemotron-asr.sh [--venv PATH] [--cache-dir PATH] [--dry-run]

Creates the dedicated Nemotron environment and explicitly downloads the
pinned model snapshot. Approximate model snapshot size: 4.9 GB.

Normal interpreter startup is offline-only and never invokes this setup.
EOF
}

while (($# > 0)); do
  case "$1" in
    --venv)
      [[ -n "${2:-}" ]] || { echo "[setup-nemotron-asr] --venv requires a value" >&2; exit 2; }
      VENV_DIR="$2"
      shift 2
      ;;
    --cache-dir)
      [[ -n "${2:-}" ]] || { echo "[setup-nemotron-asr] --cache-dir requires a value" >&2; exit 2; }
      CACHE_DIR="$2"
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
      echo "[setup-nemotron-asr] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

echo "[setup-nemotron-asr] venv=${VENV_DIR}"
echo "[setup-nemotron-asr] cache=${CACHE_DIR}"
echo "[setup-nemotron-asr] model=${MODEL_ID}@${MODEL_REVISION}"
echo "[setup-nemotron-asr] packages=transformers==5.13.1 torch==2.10.0 librosa==0.11.0 numpy==2.4.6"

if ((DRY_RUN == 1)); then
  echo "[setup-nemotron-asr] dry-run: would create or reuse the venv, install pinned direct dependencies, and prefetch about 4.9 GB"
  exit 0
fi

command -v uv >/dev/null 2>&1 || {
  echo "[setup-nemotron-asr] uv is required" >&2
  exit 2
}

if [[ -x "$VENV_DIR/bin/python" ]]; then
  echo "[setup-nemotron-asr] reusing existing venv: $VENV_DIR"
else
  uv venv "$VENV_DIR" --python "$PYTHON_VERSION"
fi
uv pip install --python "$VENV_DIR/bin/python" \
  "$ROOT_DIR/interpreter-asr-worker"

HF_HOME="$CACHE_DIR" "$VENV_DIR/bin/python" - "$MODEL_ID" "$MODEL_REVISION" "$CACHE_DIR" <<'PY'
from huggingface_hub import snapshot_download
import sys

snapshot_download(
    repo_id=sys.argv[1],
    revision=sys.argv[2],
    cache_dir=sys.argv[3],
    local_files_only=False,
)
PY

SNAPSHOT_DIR="$CACHE_DIR/models--nvidia--nemotron-3.5-asr-streaming-0.6b/snapshots/$MODEL_REVISION"
node "$ROOT_DIR/scripts/write-model-install-manifest.mjs" \
  --root "$SNAPSHOT_DIR" \
  --output "$INSTALL_MANIFEST" \
  --model "$MODEL_ID" \
  --revision "$MODEL_REVISION"

echo "[setup-nemotron-asr] model prefetched; validating offline load"
NEMOTRON_ASR_VENV="$VENV_DIR" \
NEMOTRON_ASR_CACHE_DIR="$CACHE_DIR" \
./scripts/run-nemotron-asr.sh --smoke
