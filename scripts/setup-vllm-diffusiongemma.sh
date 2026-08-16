#!/usr/bin/env bash
# =============================================================================
#  setup-vllm-diffusiongemma.sh — prepare the diffusiongemma vLLM backend.
#
#  Owned entirely by this repository (no dependency on any other repo).
#  Two backends:
#    docker (default) — pull the pinned stable vLLM release image.
#    venv             — create a virtualenv and install vLLM (needs >= v0.25.0
#                       for diffusion_gemma; documented fallback).
#
#  Idempotent: re-running pulls/reuses without side effects.
#  Usage:
#    ./scripts/setup-vllm-diffusiongemma.sh [--backend docker|venv]
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND="${VLLM_DGEMMA_BACKEND:-docker}"
# Pinned by digest for reproducibility. Stable upstream release
# (vllm/vllm-openai:v0.27.1, 2026-08-11). diffusion_gemma has been in mainline
# vLLM since v0.25.0, so the old vllm/vllm-openai:gemma pre-release image (frozen
# at 2026-06-10) is no longer needed. Refresh the digest when upgrading vLLM.
# Requires an NVIDIA Blackwell/Hopper GPU + NVFP4.
IMAGE="${VLLM_DGEMMA_IMAGE:-vllm/vllm-openai@sha256:0a51ea5b4ae2dc5d81890e5173f54203d2a3ae0cfffe51b8fd2afd4391bfd967}"
VENV_DIR="${VLLM_DGEMMA_VENV_DIR:-$ROOT_DIR/.venv-vllm-dgemma}"

usage() {
  cat <<'EOF'
Usage: ./scripts/setup-vllm-diffusiongemma.sh [--backend docker|venv]

  --backend docker   Pull the pinned stable vLLM release image (default).
  --backend venv     Create .venv-vllm-dgemma and install vLLM (fallback;
                     needs vLLM >= v0.25.0 for diffusion_gemma).
  -h, --help         Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --backend)
      if (($# < 2)); then echo "[setup-vllm-diffusiongemma] --backend requires a value" >&2; exit 2; fi
      BACKEND="$2"; shift 2 ;;
    --backend=*) BACKEND="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[setup-vllm-diffusiongemma] unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$BACKEND" in
  docker)
    command -v docker >/dev/null || { echo "[setup-vllm-diffusiongemma] docker not found" >&2; exit 2; }
    echo "[setup-vllm-diffusiongemma] pulling $IMAGE (large; first pull takes a while)..."
    docker pull "$IMAGE"
    echo "[setup-vllm-diffusiongemma] done. Start with: ./scripts/run-vllm-diffusiongemma.sh"
    ;;
  venv)
    if [[ ! -d "$VENV_DIR" ]]; then
      echo "[setup-vllm-diffusiongemma] creating venv at $VENV_DIR"
      python3 -m venv "$VENV_DIR"
    fi
    "$VENV_DIR/bin/python" -m pip install --upgrade pip
    echo "[setup-vllm-diffusiongemma] installing vLLM into $VENV_DIR"
    "$VENV_DIR/bin/pip" install --upgrade vllm
    echo "[setup-vllm-diffusiongemma] NOTE: 'diffusion_gemma' needs vLLM >= v0.25.0."
    echo "  The venv build must also provide working NVFP4 (modelopt_fp4) kernels for"
    echo "  your GPU; '--backend docker' with the pinned image is the tested path."
    ;;
  *)
    echo "[setup-vllm-diffusiongemma] unknown backend: $BACKEND (expected docker|venv)" >&2
    exit 2 ;;
esac
