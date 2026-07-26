#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DEFAULT_LLAMA_DIR="$(dirname "$ROOT_DIR")/llama.cpp"
LLAMA_DIR="${LLAMA_CPP_DIR:-$DEFAULT_LLAMA_DIR}"
MODEL_DIR="${GEMMA4_MODEL_DIR:-$HOME/models/google/gemma-4-12B-it-qat-q4_0-gguf}"
INTERPRETER_BIN="${GEMMA4_INTERPRETER_BIN:-$LLAMA_DIR/build/bin/llama-server}"
INTERPRETER_MODEL="${GEMMA4_INTERPRETER_MODEL:-$MODEL_DIR/gemma-4-12b-it-qat-q4_0.gguf}"
INTERPRETER_MMPROJ="${GEMMA4_INTERPRETER_MMPROJ:-$MODEL_DIR/mmproj-gemma-4-12b-it-qat-q4_0.gguf}"
INTERPRETER_MTP="${GEMMA4_INTERPRETER_MTP:-$MODEL_DIR/mtp-gemma-4-12B-it-qat-Q4_0.gguf}"
INTERPRETER_HOST="${GEMMA4_INTERPRETER_HOST:-127.0.0.1}"
INTERPRETER_PORT="${GEMMA4_INTERPRETER_PORT:-8093}"
INTERPRETER_CONTEXT="${GEMMA4_INTERPRETER_CONTEXT:-8192}"
INTERPRETER_GPU_LAYERS="${GEMMA4_INTERPRETER_GPU_LAYERS:-999}"
INTERPRETER_DRAFT_GPU_LAYERS="${GEMMA4_INTERPRETER_DRAFT_GPU_LAYERS:-999}"
INTERPRETER_DRAFT_TOKENS="${GEMMA4_INTERPRETER_DRAFT_TOKENS:-8}"
INTERPRETER_PARALLEL="${GEMMA4_INTERPRETER_PARALLEL:-1}"
MTP_MODE="${GEMMA4_MTP:-off}"
MTP_BENCHMARK_MANIFEST="${GEMMA4_MTP_BENCHMARK_MANIFEST:-$ROOT_DIR/.local/state/interpreter/gemma4-mtp-benchmark.json}"
INTERPRETER_USE_MTP=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: ./scripts/run-gemma4-interpreter.sh [options]

Start an OpenAI-compatible Gemma 4 audio interpreter server.

Options:
  --host <host>           Bind host (default: 127.0.0.1)
  --port <port>           Bind port (default: 8093)
  --model <path>          Main Gemma 4 GGUF
  --mmproj <path>         Matching multimodal projector GGUF
  --mtp <path>            Matching Gemma 4 assistant/MTP GGUF
  --context <tokens>      Context size (default: 8192)
  --draft-tokens <count>  Maximum MTP draft tokens (default: 8)
  --parallel <count>      Server slots (default: 1)
  --mtp-mode <mode>       off | on | auto (default: off)
  --with-mtp              Alias for --mtp-mode on
  --no-mtp                Alias for --mtp-mode off
  --dry-run               Print the resolved launch without starting it
  -h, --help              Show this help.

Environment equivalents:
  GEMMA4_INTERPRETER_BIN
  GEMMA4_INTERPRETER_MODEL
  GEMMA4_INTERPRETER_MMPROJ
  GEMMA4_INTERPRETER_MTP
  GEMMA4_INTERPRETER_HOST
  GEMMA4_INTERPRETER_PORT
  GEMMA4_INTERPRETER_CONTEXT
  GEMMA4_INTERPRETER_GPU_LAYERS
  GEMMA4_INTERPRETER_DRAFT_GPU_LAYERS
  GEMMA4_INTERPRETER_DRAFT_TOKENS
  GEMMA4_INTERPRETER_PARALLEL
  GEMMA4_MTP=off|on|auto
  GEMMA4_MTP_BENCHMARK_MANIFEST
  LLAMA_CPP_DIR

For auto mode, the approved benchmark must match the current GPU name and
memory, llama.cpp commit, and checked-in Gemma main/mmproj/assistant hashes.
EOF
}

require_value() {
  local option_name="$1"
  local option_value="${2:-}"
  if [[ -z "$option_value" ]]; then
    echo "[run-gemma4-interpreter] ${option_name} requires a value." >&2
    exit 2
  fi
}

while (($# > 0)); do
  case "$1" in
    --host)
      require_value "$1" "${2:-}"
      INTERPRETER_HOST="$2"
      shift 2
      ;;
    --port)
      require_value "$1" "${2:-}"
      INTERPRETER_PORT="$2"
      shift 2
      ;;
    --model)
      require_value "$1" "${2:-}"
      INTERPRETER_MODEL="$2"
      shift 2
      ;;
    --mmproj)
      require_value "$1" "${2:-}"
      INTERPRETER_MMPROJ="$2"
      shift 2
      ;;
    --mtp)
      require_value "$1" "${2:-}"
      INTERPRETER_MTP="$2"
      shift 2
      ;;
    --context)
      require_value "$1" "${2:-}"
      INTERPRETER_CONTEXT="$2"
      shift 2
      ;;
    --draft-tokens)
      require_value "$1" "${2:-}"
      INTERPRETER_DRAFT_TOKENS="$2"
      shift 2
      ;;
    --parallel)
      require_value "$1" "${2:-}"
      INTERPRETER_PARALLEL="$2"
      shift 2
      ;;
    --no-mtp)
      MTP_MODE=off
      shift
      ;;
    --with-mtp)
      MTP_MODE=on
      shift
      ;;
    --mtp-mode)
      require_value "$1" "${2:-}"
      MTP_MODE="$2"
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
      echo "[run-gemma4-interpreter] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! "$INTERPRETER_DRAFT_TOKENS" =~ ^[0-9]+$ ]] \
  || ((10#$INTERPRETER_DRAFT_TOKENS < 1 || 10#$INTERPRETER_DRAFT_TOKENS > 32)); then
  echo "[run-gemma4-interpreter] draft tokens must be an integer from 1 to 32" >&2
  exit 2
fi

case "${MTP_MODE,,}" in
  off)
    INTERPRETER_USE_MTP=0
    ;;
  on)
    INTERPRETER_USE_MTP=1
    ;;
  auto)
    gpu_name="${GEMMA4_MTP_GPU_NAME:-}"
    gpu_memory="${GEMMA4_MTP_GPU_MEMORY_TOTAL_MIB:-}"
    if [[ -z "$gpu_name" || -z "$gpu_memory" ]] \
      && command -v nvidia-smi >/dev/null 2>&1; then
      gpu_line="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || true)"
      if [[ -n "$gpu_line" ]]; then
        gpu_name="${gpu_line%,*}"
        gpu_memory="${gpu_line##*,}"
      fi
    fi
    llama_commit="${GEMMA4_MTP_LLAMA_COMMIT:-}"
    if [[ -z "$llama_commit" && -d "$LLAMA_DIR/.git" ]]; then
      llama_commit="$(git -C "$LLAMA_DIR" rev-parse HEAD 2>/dev/null || true)"
    fi
    validation_output=""
    if [[ -f "$MTP_BENCHMARK_MANIFEST" ]] \
      && validation_output="$(node scripts/validate-gemma4-mtp-benchmark.mjs \
        --manifest "$MTP_BENCHMARK_MANIFEST" \
        --gpu-name "$gpu_name" \
        --gpu-memory-mib "$gpu_memory" \
        --llama-commit "$llama_commit" 2>&1)"; then
      INTERPRETER_USE_MTP=1
      INTERPRETER_DRAFT_TOKENS="${validation_output##*$'\n'}"
      echo "[run-gemma4-interpreter] MTP auto=on (matching approved benchmark; draft=${INTERPRETER_DRAFT_TOKENS})"
    else
      INTERPRETER_USE_MTP=0
      reason="${validation_output:-no matching approved benchmark manifest}"
      echo "[run-gemma4-interpreter] MTP auto=off (${reason})"
    fi
    ;;
  *)
    echo "[run-gemma4-interpreter] GEMMA4_MTP must be off, on, or auto: ${MTP_MODE}" >&2
    exit 2
    ;;
esac

if ((DRY_RUN == 1)); then
  echo "[run-gemma4-interpreter] dry-run"
  echo "[run-gemma4-interpreter] binary=${INTERPRETER_BIN}"
  echo "[run-gemma4-interpreter] endpoint=http://${INTERPRETER_HOST}:${INTERPRETER_PORT}/v1"
  echo "[run-gemma4-interpreter] model=${INTERPRETER_MODEL}"
  echo "[run-gemma4-interpreter] mmproj=${INTERPRETER_MMPROJ}"
  echo "[run-gemma4-interpreter] mtp_mode=${MTP_MODE,,}"
  echo "[run-gemma4-interpreter] mtp=$([[ "$INTERPRETER_USE_MTP" == "1" ]] && printf '%s' "$INTERPRETER_MTP" || printf '%s' '<disabled>')"
  echo "[run-gemma4-interpreter] draft_tokens=${INTERPRETER_DRAFT_TOKENS}"
  exit 0
fi

if [[ ! -x "$INTERPRETER_BIN" ]]; then
  echo "[run-gemma4-interpreter] llama-server is not executable: $INTERPRETER_BIN" >&2
  exit 2
fi
if [[ ! -f "$INTERPRETER_MODEL" ]]; then
  echo "[run-gemma4-interpreter] main model is missing: $INTERPRETER_MODEL" >&2
  exit 2
fi
if [[ ! -f "$INTERPRETER_MMPROJ" ]]; then
  echo "[run-gemma4-interpreter] multimodal projector is missing: $INTERPRETER_MMPROJ" >&2
  exit 2
fi
if [[ "$INTERPRETER_USE_MTP" == "1" && ! -f "$INTERPRETER_MTP" ]]; then
  echo "[run-gemma4-interpreter] MTP model is missing: $INTERPRETER_MTP" >&2
  exit 2
fi

declare -a INTERPRETER_ARGS=(
  --model "$INTERPRETER_MODEL"
  --mmproj "$INTERPRETER_MMPROJ"
  --host "$INTERPRETER_HOST"
  --port "$INTERPRETER_PORT"
  --ctx-size "$INTERPRETER_CONTEXT"
  --parallel "$INTERPRETER_PARALLEL"
  --n-gpu-layers "$INTERPRETER_GPU_LAYERS"
  --flash-attn on
  --jinja
)

if [[ "$INTERPRETER_USE_MTP" == "1" ]]; then
  INTERPRETER_ARGS+=(
    --spec-draft-model "$INTERPRETER_MTP"
    --spec-type draft-mtp
    --spec-draft-n-max "$INTERPRETER_DRAFT_TOKENS"
    --spec-draft-ngl "$INTERPRETER_DRAFT_GPU_LAYERS"
  )
fi

echo "[run-gemma4-interpreter] endpoint=http://${INTERPRETER_HOST}:${INTERPRETER_PORT}/v1"
echo "[run-gemma4-interpreter] model=${INTERPRETER_MODEL}"
echo "[run-gemma4-interpreter] mmproj=${INTERPRETER_MMPROJ}"
echo "[run-gemma4-interpreter] mtp_mode=${MTP_MODE,,}"
echo "[run-gemma4-interpreter] mtp=$([[ "$INTERPRETER_USE_MTP" == "1" ]] && printf '%s' "$INTERPRETER_MTP" || printf '%s' '<disabled>')"
echo "[run-gemma4-interpreter] context=${INTERPRETER_CONTEXT} parallel=${INTERPRETER_PARALLEL}"

exec "$INTERPRETER_BIN" "${INTERPRETER_ARGS[@]}"
