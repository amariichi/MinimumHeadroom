#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VENV_DIR="${SUPERTONIC_VENV:-$ROOT_DIR/.venv-supertonic}"
CACHE_DIR="${SUPERTONIC_CACHE_DIR:-$HOME/.cache/supertonic3}"
MODEL_REVISION="${SUPERTONIC_MODEL_REVISION:-724fb5abbf5502583fb520898d45929e62f02c0b}"
INSTALL_MANIFEST="${SUPERTONIC_INSTALL_MANIFEST:-$ROOT_DIR/.local/state/interpreter/supertonic.json}"
PYTHON_VERSION="${SUPERTONIC_PYTHON:-3.11}"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: ./scripts/setup-supertonic.sh [--venv PATH] [--cache-dir PATH] [--dry-run]

Install supertonic==1.3.1 in a dedicated environment and explicitly prefetch
the pinned Supertonic 3 ONNX assets (approximately 400 MB).

Normal TTS startup uses TTS(auto_download=False) and remains offline.
EOF
}

while (($# > 0)); do
  case "$1" in
    --venv)
      [[ -n "${2:-}" ]] || { echo "[setup-supertonic] --venv requires a value" >&2; exit 2; }
      VENV_DIR="$2"
      shift 2
      ;;
    --cache-dir)
      [[ -n "${2:-}" ]] || { echo "[setup-supertonic] --cache-dir requires a value" >&2; exit 2; }
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
      echo "[setup-supertonic] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

echo "[setup-supertonic] venv=${VENV_DIR}"
echo "[setup-supertonic] cache=${CACHE_DIR}"
echo "[setup-supertonic] package=supertonic==1.3.1"
echo "[setup-supertonic] model=Supertone/supertonic-3@${MODEL_REVISION}"
if ((DRY_RUN == 1)); then
  echo "[setup-supertonic] dry-run: would install the package and prefetch approximately 400 MB"
  exit 0
fi

command -v uv >/dev/null 2>&1 || {
  echo "[setup-supertonic] uv is required" >&2
  exit 2
}

uv venv "$VENV_DIR" --python "$PYTHON_VERSION"
uv pip install --python "$VENV_DIR/bin/python" "supertonic==1.3.1"

SUPERTONIC_CACHE_DIR="$CACHE_DIR" \
SUPERTONIC_MODEL_REVISION="$MODEL_REVISION" \
"$VENV_DIR/bin/python" - <<'PY'
from supertonic import TTS

tts = TTS(model="supertonic-3", auto_download=True)
tts.get_voice_style(voice_name="M1")
print(f"Supertonic assets ready: {tts.model_dir}")
PY

node "$ROOT_DIR/scripts/write-model-install-manifest.mjs" \
  --root "$CACHE_DIR" \
  --output "$INSTALL_MANIFEST" \
  --model "Supertone/supertonic-3" \
  --revision "$MODEL_REVISION"

echo "[setup-supertonic] validating offline worker load"
SUPERTONIC_VENV="$VENV_DIR" \
SUPERTONIC_CACHE_DIR="$CACHE_DIR" \
SUPERTONIC_MODEL_REVISION="$MODEL_REVISION" \
TTS_ENGINE=supertonic \
./scripts/run-tts-worker.sh --smoke

echo "[setup-supertonic] done"
