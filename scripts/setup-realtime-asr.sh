#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PYTHON_VERSION="${REALTIME_ASR_PYTHON:-3.12}"
VENV_DIR="${REALTIME_ASR_VENV_DIR:-$ROOT_DIR/.venv-vllm}"
TORCH_BACKEND="${REALTIME_ASR_TORCH_BACKEND:-cu130}"
WHEEL_INDEX="${REALTIME_ASR_WHEEL_INDEX:-https://wheels.vllm.ai/nightly/${TORCH_BACKEND}}"

usage() {
  cat <<'EOF'
Usage: ./scripts/setup-realtime-asr.sh [options]

Options:
  --python <version>        Python version for the vLLM virtualenv (default: 3.12)
  --venv-dir <path>         Virtualenv path (default: ./.venv-vllm)
  --torch-backend <name>    UV torch backend selector (default: cu130)
  --wheel-index <url>       Extra wheel index URL (default: nightly wheel index for the selected backend)
  -h, --help                Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --python)
      if (($# < 2)); then
        echo "[setup-realtime-asr] --python requires a value" >&2
        exit 2
      fi
      PYTHON_VERSION="$2"
      shift 2
      ;;
    --python=*)
      PYTHON_VERSION="${1#*=}"
      shift
      ;;
    --venv-dir)
      if (($# < 2)); then
        echo "[setup-realtime-asr] --venv-dir requires a value" >&2
        exit 2
      fi
      VENV_DIR="$2"
      shift 2
      ;;
    --venv-dir=*)
      VENV_DIR="${1#*=}"
      shift
      ;;
    --torch-backend)
      if (($# < 2)); then
        echo "[setup-realtime-asr] --torch-backend requires a value" >&2
        exit 2
      fi
      TORCH_BACKEND="$2"
      WHEEL_INDEX="https://wheels.vllm.ai/nightly/${TORCH_BACKEND}"
      shift 2
      ;;
    --torch-backend=*)
      TORCH_BACKEND="${1#*=}"
      WHEEL_INDEX="https://wheels.vllm.ai/nightly/${TORCH_BACKEND}"
      shift
      ;;
    --wheel-index)
      if (($# < 2)); then
        echo "[setup-realtime-asr] --wheel-index requires a value" >&2
        exit 2
      fi
      WHEEL_INDEX="$2"
      shift 2
      ;;
    --wheel-index=*)
      WHEEL_INDEX="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[setup-realtime-asr] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

echo "[setup-realtime-asr] root: $ROOT_DIR"
echo "[setup-realtime-asr] python: $PYTHON_VERSION"
echo "[setup-realtime-asr] venv: $VENV_DIR"
echo "[setup-realtime-asr] torch backend: $TORCH_BACKEND"
echo "[setup-realtime-asr] wheel index: $WHEEL_INDEX"

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  echo "[setup-realtime-asr] creating virtualenv"
  uv venv "$VENV_DIR" --python "$PYTHON_VERSION" --seed
else
  echo "[setup-realtime-asr] reusing existing virtualenv"
fi

echo "[setup-realtime-asr] installing vLLM nightly"
UV_TORCH_BACKEND="$TORCH_BACKEND" \
  uv pip install --python "$VENV_DIR/bin/python" -U vllm \
  --extra-index-url "$WHEEL_INDEX"

echo "[setup-realtime-asr] installing audio and tokenizer helpers"
uv pip install --python "$VENV_DIR/bin/python" -U mistral-common soxr librosa soundfile

echo "[setup-realtime-asr] verifying imports"
"$VENV_DIR/bin/python" -c "import vllm, mistral_common; print('[setup-realtime-asr] vllm', vllm.__version__); print('[setup-realtime-asr] mistral_common', mistral_common.__version__)"

cat <<EOF
[setup-realtime-asr] done

Next steps:
  1. Run ./scripts/run-vllm-voxtral.sh
  2. Start the operator stack with:
     MH_OPERATOR_REALTIME_ASR_ENABLED=1 \\
     MH_STACK_START_REALTIME_ASR=1 \\
     MH_BRIDGE_TMUX_PANE=<pane> ./scripts/run-operator-stack.sh
EOF
