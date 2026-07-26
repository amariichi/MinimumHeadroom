#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRESET="${INTERPRETER_PRESET:-gemma4-supertonic}"
DRY_RUN=0
LLAMA_DIR="${LLAMA_CPP_DIR:-$(dirname "$ROOT_DIR")/llama.cpp}"
MODEL_DIR="${GEMMA4_MODEL_DIR:-$HOME/models/google/gemma-4-12B-it-qat-q4_0-gguf}"
ASSISTANT_DIR="${GEMMA4_ASSISTANT_SOURCE_DIR:-$HOME/models/google/gemma-4-12B-it-qat-q4_0-unquantized-assistant}"

usage() {
  cat <<'EOF'
Usage: ./scripts/setup-interpreter-stack.sh --preset NAME [options]

Install only the providers owned by one interpreter preset.

Options:
  --preset NAME          gemma4-supertonic | gemma4-qwen3 |
                         nemotron-gemma4-supertonic | nemotron-gemma4-qwen3
  --llama-dir PATH       Existing llama.cpp checkout for Gemma presets
  --model-dir PATH       Gemma runtime GGUF directory
  --assistant-dir PATH   Gemma assistant source directory
  --dry-run              Print selected setup work without changing files
  -h, --help             Show this help

Provider matrix:
  gemma4-supertonic             Gemma 4 ASR/translation + Supertonic
  gemma4-qwen3                  Gemma 4 ASR/translation + Qwen3-TTS
  nemotron-gemma4-supertonic    Nemotron ASR + Gemma 4 translation + Supertonic
  nemotron-gemma4-qwen3         Nemotron ASR + Gemma 4 translation + Qwen3-TTS

The deprecated light-cloud name is accepted as an alias for
nemotron-gemma4-supertonic. No preset installs or requires agy.

Gemma MTP is optional and defaults off. Set GEMMA4_MTP=on to include the
assistant source/GGUF in setup. Model downloads occur only in non-dry-run mode.
EOF
}

while (($# > 0)); do
  case "$1" in
    --preset)
      [[ -n "${2:-}" ]] || { echo "[setup-interpreter-stack] --preset requires a value" >&2; exit 2; }
      PRESET="$2"
      shift 2
      ;;
    --llama-dir)
      [[ -n "${2:-}" ]] || { echo "[setup-interpreter-stack] --llama-dir requires a value" >&2; exit 2; }
      LLAMA_DIR="$2"
      shift 2
      ;;
    --model-dir)
      [[ -n "${2:-}" ]] || { echo "[setup-interpreter-stack] --model-dir requires a value" >&2; exit 2; }
      MODEL_DIR="$2"
      shift 2
      ;;
    --assistant-dir)
      [[ -n "${2:-}" ]] || { echo "[setup-interpreter-stack] --assistant-dir requires a value" >&2; exit 2; }
      ASSISTANT_DIR="$2"
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
      echo "[setup-interpreter-stack] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$PRESET" == "light-cloud" ]]; then
  echo "[setup-interpreter-stack] warning: light-cloud is deprecated; using nemotron-gemma4-supertonic" >&2
  PRESET="nemotron-gemma4-supertonic"
fi

case "$PRESET" in
  gemma4-supertonic|gemma4-qwen3|nemotron-gemma4-supertonic|nemotron-gemma4-qwen3) ;;
  *)
    echo "[setup-interpreter-stack] unsupported preset: $PRESET" >&2
    exit 2
    ;;
esac

declare -a PREVIEW_ARG=()
if ((DRY_RUN == 1)); then
  PREVIEW_ARG=(--dry-run)
fi

echo "[setup-interpreter-stack] preset=${PRESET}"
NEEDS_NEMOTRON=0
TTS_OWNER=""
case "$PRESET" in
  gemma4-supertonic)
    TTS_OWNER="supertonic"
    ;;
  gemma4-qwen3)
    TTS_OWNER="qwen3"
    ;;
  nemotron-gemma4-supertonic)
    NEEDS_NEMOTRON=1
    TTS_OWNER="supertonic"
    ;;
  nemotron-gemma4-qwen3)
    NEEDS_NEMOTRON=1
    TTS_OWNER="qwen3"
    ;;
esac

selected="gemma4,${TTS_OWNER}"
if ((NEEDS_NEMOTRON == 1)); then
  selected="nemotron-asr,${selected}"
fi
echo "[setup-interpreter-stack] selected=${selected}"

if ((NEEDS_NEMOTRON == 1)); then
  "$ROOT_DIR/scripts/setup-nemotron-asr.sh" "${PREVIEW_ARG[@]}"
fi

declare -a GEMMA_ARGS=(
  --llama-dir "$LLAMA_DIR"
  --model-dir "$MODEL_DIR"
  --assistant-dir "$ASSISTANT_DIR"
  "${PREVIEW_ARG[@]}"
)
if [[ "${GEMMA4_MTP:-off}" == "on" ]]; then
  GEMMA_ARGS+=(--with-mtp)
fi
"$ROOT_DIR/scripts/setup-gemma4-interpreter.sh" "${GEMMA_ARGS[@]}"

if [[ "$TTS_OWNER" == "supertonic" ]]; then
  "$ROOT_DIR/scripts/setup-supertonic.sh" "${PREVIEW_ARG[@]}"
else
  "$ROOT_DIR/scripts/setup-qwen3-tts.sh" "${PREVIEW_ARG[@]}"
fi

echo "[setup-interpreter-stack] selected preset setup complete"
