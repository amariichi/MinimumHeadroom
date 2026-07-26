#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_DIR="${GEMMA4_MODEL_DIR:-$HOME/models/google/gemma-4-12B-it-qat-q4_0-gguf}"
ASSISTANT_DIR="${GEMMA4_ASSISTANT_SOURCE_DIR:-$HOME/models/google/gemma-4-12B-it-qat-q4_0-unquantized-assistant}"
LLAMA_DIR="${LLAMA_CPP_DIR:-$(dirname "$ROOT_DIR")/llama.cpp}"
SETUP_VENV="${GEMMA4_SETUP_VENV:-$ROOT_DIR/.venv-gemma4-setup}"
WITH_MTP=0
REBUILD_MTP=0
DRY_RUN=0

RUNTIME_REPO="google/gemma-4-12B-it-qat-q4_0-gguf"
RUNTIME_REVISION="29d097773436b69ff9feafd636ab4cf873786537"
ASSISTANT_REPO="google/gemma-4-12B-it-qat-q4_0-unquantized-assistant"
ASSISTANT_REVISION="18934064dd4c5c6cc3621f6381e7d377fc8cb7bd"
MAIN_NAME="gemma-4-12b-it-qat-q4_0.gguf"
MMPROJ_NAME="mmproj-gemma-4-12b-it-qat-q4_0.gguf"
MTP_NAME="mtp-gemma-4-12B-it-qat-Q4_0.gguf"
MAIN_SHA="93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b"
MMPROJ_SHA="cb018338a7538a9814d994bfe54644c71eb7ed54e31eae2f721e45fd3c260da7"
MTP_SHA="25f143b4c15b20cd04216e35e99bd7a56afc6f65e7a4e090a3e20091bb590cbb"

usage() {
  cat <<'EOF'
Usage: ./scripts/setup-gemma4-interpreter.sh [options]

Options:
  --model-dir PATH       Main GGUF/mmproj directory
  --assistant-dir PATH   Official assistant safetensors directory
  --llama-dir PATH       Existing compatible llama.cpp checkout
  --with-mtp             Also ensure the assistant source and MTP Q4_0 GGUF
  --rebuild-mtp          Explicitly rebuild the MTP GGUF (implies --with-mtp)
  --dry-run              Verify and print planned downloads/builds only
  -h, --help             Show this help

Normal runtime never downloads. This explicit setup may download approximately
7.2 GB for main+mmproj, plus about 0.9 GB if MTP source is needed. Gemma 4
weights use Apache-2.0; Hugging Face may rate-limit unauthenticated downloads.
EOF
}

while (($# > 0)); do
  case "$1" in
    --model-dir)
      [[ -n "${2:-}" ]] || { echo "[setup-gemma4-interpreter] --model-dir requires a value" >&2; exit 2; }
      MODEL_DIR="$2"
      shift 2
      ;;
    --assistant-dir)
      [[ -n "${2:-}" ]] || { echo "[setup-gemma4-interpreter] --assistant-dir requires a value" >&2; exit 2; }
      ASSISTANT_DIR="$2"
      shift 2
      ;;
    --llama-dir)
      [[ -n "${2:-}" ]] || { echo "[setup-gemma4-interpreter] --llama-dir requires a value" >&2; exit 2; }
      LLAMA_DIR="$2"
      shift 2
      ;;
    --with-mtp)
      WITH_MTP=1
      shift
      ;;
    --rebuild-mtp)
      WITH_MTP=1
      REBUILD_MTP=1
      shift
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
      echo "[setup-gemma4-interpreter] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

artifact_status() {
  local path="$1"
  local expected_sha="$2"
  if [[ ! -f "$path" ]]; then
    printf 'missing'
    return
  fi
  local actual_sha
  actual_sha="$(sha256sum "$path" | awk '{print $1}')"
  if [[ "$actual_sha" == "$expected_sha" ]]; then
    printf 'reuse'
  else
    printf 'mismatch:%s' "$actual_sha"
  fi
}

MAIN_STATUS="$(artifact_status "$MODEL_DIR/$MAIN_NAME" "$MAIN_SHA")"
MMPROJ_STATUS="$(artifact_status "$MODEL_DIR/$MMPROJ_NAME" "$MMPROJ_SHA")"
MTP_STATUS="$(artifact_status "$MODEL_DIR/$MTP_NAME" "$MTP_SHA")"

echo "[setup-gemma4-interpreter] runtime=${RUNTIME_REPO}@${RUNTIME_REVISION}"
echo "[setup-gemma4-interpreter] assistant=${ASSISTANT_REPO}@${ASSISTANT_REVISION}"
echo "[setup-gemma4-interpreter] main GGUF: ${MAIN_STATUS}"
echo "[setup-gemma4-interpreter] mmproj GGUF: ${MMPROJ_STATUS}"
echo "[setup-gemma4-interpreter] assistant GGUF: ${MTP_STATUS}"
echo "[setup-gemma4-interpreter] mtp_requested=$([[ "$WITH_MTP" == "1" ]] && printf yes || printf no)"

for status in "$MAIN_STATUS" "$MMPROJ_STATUS"; do
  if [[ "$status" == mismatch:* ]]; then
    echo "[setup-gemma4-interpreter] refusing to overwrite an artifact with an unregistered SHA256" >&2
    exit 2
  fi
done
if ((WITH_MTP == 1)) && [[ "$MTP_STATUS" == mismatch:* ]] && ((REBUILD_MTP == 0)); then
  echo "[setup-gemma4-interpreter] existing MTP artifact has an unregistered SHA256; use a different output directory or inspect it before --rebuild-mtp" >&2
  exit 2
fi

if ((DRY_RUN == 1)); then
  if [[ "$MAIN_STATUS" == "missing" || "$MMPROJ_STATUS" == "missing" ]]; then
    echo "[setup-gemma4-interpreter] dry-run: would download only the missing pinned runtime files"
  else
    echo "[setup-gemma4-interpreter] dry-run: runtime artifacts are verified and reusable"
  fi
  if ((WITH_MTP == 1)); then
    if [[ "$MTP_STATUS" == "reuse" && "$REBUILD_MTP" == "0" ]]; then
      echo "[setup-gemma4-interpreter] dry-run: assistant GGUF is verified and reusable"
    else
      echo "[setup-gemma4-interpreter] dry-run: would ensure the pinned assistant snapshot and run build-gemma4-gguf.sh without the converter --mtp flag"
    fi
  fi
  declare -a CHECK_ARGS=(
    --llama-dir "$LLAMA_DIR"
    --mtp-mode "$([[ "$WITH_MTP" == "1" ]] && printf on || printf off)"
  )
  if ((WITH_MTP == 1)) && { [[ "$MTP_STATUS" != "reuse" ]] || ((REBUILD_MTP == 1)); }; then
    CHECK_ARGS+=(--require-build-tools)
  fi
  if ! "$ROOT_DIR/scripts/check-llama-gemma4.sh" "${CHECK_ARGS[@]}"; then
    echo "[setup-gemma4-interpreter] dry-run: llama.cpp is not currently runtime-ready; no checkout was changed"
  fi
  exit
fi

command -v uv >/dev/null 2>&1 || {
  echo "[setup-gemma4-interpreter] uv is required" >&2
  exit 2
}
"$ROOT_DIR/scripts/check-llama-gemma4.sh" \
  --llama-dir "$LLAMA_DIR" \
  --mtp-mode "$([[ "$WITH_MTP" == "1" ]] && printf on || printf off)"

if [[ "$MAIN_STATUS" == "missing" || "$MMPROJ_STATUS" == "missing" ]]; then
  if [[ ! -x "$SETUP_VENV/bin/python" ]]; then
    uv venv "$SETUP_VENV" --python 3.12 --seed
    uv pip install --python "$SETUP_VENV/bin/python" "huggingface-hub==0.36.0"
  fi
  mkdir -p "$MODEL_DIR"
  HF_HUB_ENABLE_HF_TRANSFER=0 "$SETUP_VENV/bin/python" - \
    "$RUNTIME_REPO" "$RUNTIME_REVISION" "$MODEL_DIR" "$MAIN_NAME" "$MMPROJ_NAME" <<'PY'
from huggingface_hub import snapshot_download
import sys

snapshot_download(
    repo_id=sys.argv[1],
    revision=sys.argv[2],
    local_dir=sys.argv[3],
    allow_patterns=[sys.argv[4], sys.argv[5]],
)
PY
fi

[[ "$(artifact_status "$MODEL_DIR/$MAIN_NAME" "$MAIN_SHA")" == "reuse" ]] || {
  echo "[setup-gemma4-interpreter] main GGUF verification failed" >&2
  exit 1
}
[[ "$(artifact_status "$MODEL_DIR/$MMPROJ_NAME" "$MMPROJ_SHA")" == "reuse" ]] || {
  echo "[setup-gemma4-interpreter] mmproj verification failed" >&2
  exit 1
}

if ((WITH_MTP == 1)) && { [[ "$MTP_STATUS" != "reuse" ]] || ((REBUILD_MTP == 1)); }; then
  if [[ ! -x "$SETUP_VENV/bin/python" ]]; then
    uv venv "$SETUP_VENV" --python 3.12 --seed
    uv pip install --python "$SETUP_VENV/bin/python" "huggingface-hub==0.36.0"
  fi
  mkdir -p "$ASSISTANT_DIR"
  "$SETUP_VENV/bin/python" - "$ASSISTANT_REPO" "$ASSISTANT_REVISION" "$ASSISTANT_DIR" <<'PY'
from huggingface_hub import snapshot_download
import sys

snapshot_download(
    repo_id=sys.argv[1],
    revision=sys.argv[2],
    local_dir=sys.argv[3],
)
PY
  declare -a BUILD_ARGS=(
    --component assistant
    --llama-dir "$LLAMA_DIR"
    --source-dir "$ASSISTANT_DIR"
    --output-dir "$MODEL_DIR"
  )
  if ((REBUILD_MTP == 1)); then
    BUILD_ARGS+=(--rebuild)
  fi
  "$ROOT_DIR/scripts/build-gemma4-gguf.sh" "${BUILD_ARGS[@]}"
fi

echo "[setup-gemma4-interpreter] runtime ready"
if ((WITH_MTP == 1)); then
  echo "[setup-gemma4-interpreter] MTP artifact ready"
fi
