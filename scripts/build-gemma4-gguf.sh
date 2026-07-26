#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPONENT="assistant"
LLAMA_DIR="${LLAMA_CPP_DIR:-$(dirname "$ROOT_DIR")/llama.cpp}"
SOURCE_DIR="${GEMMA4_ASSISTANT_SOURCE_DIR:-$HOME/models/google/gemma-4-12B-it-qat-q4_0-unquantized-assistant}"
OUTPUT_DIR="${GEMMA4_MODEL_DIR:-$HOME/models/google/gemma-4-12B-it-qat-q4_0-gguf}"
OUTPUT_NAME="mtp-gemma-4-12B-it-qat-Q4_0.gguf"
CONVERT_VENV="${GEMMA4_CONVERT_VENV:-$ROOT_DIR/.venv-gemma4-convert}"
REBUILD=0
KEEP_F16=0
DRY_RUN=0
MIN_FREE_KIB=4194304
KNOWN_OUTPUT_SHA="25f143b4c15b20cd04216e35e99bd7a56afc6f65e7a4e090a3e20091bb590cbb"

usage() {
  cat <<'EOF'
Usage: ./scripts/build-gemma4-gguf.sh [options]

Convert the official standalone Gemma 4 assistant safetensors to an MTP draft
GGUF, then quantize it to Q4_0. Source files are never removed.

Options:
  --component assistant   Initial supported component (default: assistant)
  --llama-dir PATH        Compatible llama.cpp checkout
  --source-dir PATH       Official assistant snapshot directory
  --output-dir PATH       Directory for the final MTP GGUF
  --convert-venv PATH     Dedicated conversion environment
  --rebuild               Explicitly replace a verified existing final file
  --keep-f16              Keep the intermediate F16 GGUF after success
  --dry-run               Inspect and print planned work only
  -h, --help              Show this help

The llama.cpp converter is invoked without --mtp. This assistant checkpoint is
a standalone Gemma4AssistantForCausalLM model; the converter's --mtp option is
for other architectures.
EOF
}

while (($# > 0)); do
  case "$1" in
    --component)
      [[ -n "${2:-}" ]] || { echo "[build-gemma4-gguf] --component requires a value" >&2; exit 2; }
      COMPONENT="$2"
      shift 2
      ;;
    --llama-dir)
      [[ -n "${2:-}" ]] || { echo "[build-gemma4-gguf] --llama-dir requires a value" >&2; exit 2; }
      LLAMA_DIR="$2"
      shift 2
      ;;
    --source-dir)
      [[ -n "${2:-}" ]] || { echo "[build-gemma4-gguf] --source-dir requires a value" >&2; exit 2; }
      SOURCE_DIR="$2"
      shift 2
      ;;
    --output-dir)
      [[ -n "${2:-}" ]] || { echo "[build-gemma4-gguf] --output-dir requires a value" >&2; exit 2; }
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --convert-venv)
      [[ -n "${2:-}" ]] || { echo "[build-gemma4-gguf] --convert-venv requires a value" >&2; exit 2; }
      CONVERT_VENV="$2"
      shift 2
      ;;
    --rebuild)
      REBUILD=1
      shift
      ;;
    --keep-f16)
      KEEP_F16=1
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
      echo "[build-gemma4-gguf] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$COMPONENT" != "assistant" ]]; then
  echo "[build-gemma4-gguf] only --component assistant is supported by this reproducible path" >&2
  exit 2
fi

FINAL_PATH="$OUTPUT_DIR/$OUTPUT_NAME"
CONVERTER="$LLAMA_DIR/convert_hf_to_gguf.py"
QUANTIZER="$LLAMA_DIR/build/bin/llama-quantize"
REQUIREMENTS="$LLAMA_DIR/requirements/requirements-convert_hf_to_gguf.txt"
SOURCE_MODEL="$SOURCE_DIR/model.safetensors"

existing_status="missing"
if [[ -f "$FINAL_PATH" ]]; then
  existing_sha="$(sha256sum "$FINAL_PATH" | awk '{print $1}')"
  if [[ "$existing_sha" == "$KNOWN_OUTPUT_SHA" ]]; then
    existing_status="reuse (verified SHA256)"
  else
    existing_status="present with unregistered SHA256 ${existing_sha}"
  fi
fi

echo "[build-gemma4-gguf] component=${COMPONENT}"
echo "[build-gemma4-gguf] source=${SOURCE_DIR}"
echo "[build-gemma4-gguf] output=${FINAL_PATH}"
echo "[build-gemma4-gguf] llama_dir=${LLAMA_DIR}"
echo "[build-gemma4-gguf] convert_venv=${CONVERT_VENV}"
echo "[build-gemma4-gguf] assistant GGUF: ${existing_status}"
echo "[build-gemma4-gguf] converter_mode=standalone (no --mtp flag)"

if ((DRY_RUN == 1)); then
  if [[ "$existing_status" == "reuse (verified SHA256)" && "$REBUILD" == "0" ]]; then
    echo "[build-gemma4-gguf] dry-run: no conversion required"
  else
    echo "[build-gemma4-gguf] dry-run: would create/reuse the pinned conversion venv, write temporary F16 and Q4_0 files, verify them, then atomically publish the Q4_0 file"
  fi
  exit 0
fi

if [[ "$existing_status" == "reuse (verified SHA256)" && "$REBUILD" == "0" ]]; then
  echo "[build-gemma4-gguf] verified existing artifact; nothing to do"
  exit 0
fi
if [[ -f "$FINAL_PATH" && "$REBUILD" == "0" ]]; then
  echo "[build-gemma4-gguf] refusing to replace an existing unregistered artifact without --rebuild: $FINAL_PATH" >&2
  exit 2
fi
if [[ ! -f "$SOURCE_MODEL" ]]; then
  echo "[build-gemma4-gguf] source model is missing: $SOURCE_MODEL" >&2
  exit 2
fi

"$ROOT_DIR/scripts/check-llama-gemma4.sh" \
  --llama-dir "$LLAMA_DIR" \
  --mtp-mode on \
  --require-build-tools
command -v uv >/dev/null 2>&1 || {
  echo "[build-gemma4-gguf] uv is required" >&2
  exit 2
}

mkdir -p "$OUTPUT_DIR"
available_kib="$(df -Pk "$OUTPUT_DIR" | awk 'NR == 2 {print $4}')"
if [[ ! "$available_kib" =~ ^[0-9]+$ ]] || ((available_kib < MIN_FREE_KIB)); then
  echo "[build-gemma4-gguf] at least 4 GiB free is required on the output filesystem" >&2
  exit 2
fi

if [[ ! -x "$CONVERT_VENV/bin/python" ]]; then
  uv venv "$CONVERT_VENV" --python 3.12 --seed
  uv pip install \
    --python "$CONVERT_VENV/bin/python" \
    -r "$REQUIREMENTS"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
F16_TMP="$OUTPUT_DIR/.mtp-gemma4-assistant-${stamp}-f16.gguf"
Q4_TMP="$OUTPUT_DIR/.mtp-gemma4-assistant-${stamp}-Q4_0.gguf"
LOG_PATH="$OUTPUT_DIR/.mtp-gemma4-assistant-${stamp}.log"

echo "[build-gemma4-gguf] conversion log=${LOG_PATH}"
set +e
"$CONVERT_VENV/bin/python" "$CONVERTER" \
  "$SOURCE_DIR" \
  --outfile "$F16_TMP" \
  --outtype f16 2>&1 | tee "$LOG_PATH"
convert_status=${PIPESTATUS[0]}
set -e
if ((convert_status != 0)) || [[ ! -s "$F16_TMP" ]]; then
  echo "[build-gemma4-gguf] conversion failed; temporary output and log were kept" >&2
  exit 1
fi

"$QUANTIZER" "$F16_TMP" "$Q4_TMP" Q4_0
if [[ ! -s "$Q4_TMP" ]]; then
  echo "[build-gemma4-gguf] quantizer produced no output; temporary files were kept" >&2
  exit 1
fi
if ! head -c 4 "$Q4_TMP" | od -An -t x1 | tr -d ' \n' | rg -q '^47475546$'; then
  echo "[build-gemma4-gguf] temporary Q4 file does not have a GGUF header; files were kept" >&2
  exit 1
fi

new_sha="$(sha256sum "$Q4_TMP" | awk '{print $1}')"
new_bytes="$(stat -c %s "$Q4_TMP")"
echo "[build-gemma4-gguf] verified temporary GGUF bytes=${new_bytes} sha256=${new_sha}"
mv -f "$Q4_TMP" "$FINAL_PATH"
if ((KEEP_F16 == 0)); then
  rm -f "$F16_TMP"
else
  echo "[build-gemma4-gguf] kept F16 intermediate: $F16_TMP"
fi
echo "[build-gemma4-gguf] published: $FINAL_PATH"
