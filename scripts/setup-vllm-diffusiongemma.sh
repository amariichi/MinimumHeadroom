#!/usr/bin/env bash
# =============================================================================
#  setup-vllm-diffusiongemma.sh — prepare the diffusiongemma vLLM backend.
#
#  Owned entirely by this repository (no dependency on any other repo).
#  Two backends:
#    docker (default) — pull the pinned pre-release vLLM image.
#    venv             — create a virtualenv and install vLLM (requires a build
#                       with diffusion_gemma support; documented fallback).
#
#  Idempotent: re-running pulls/reuses without side effects.
#  Usage:
#    ./scripts/setup-vllm-diffusiongemma.sh [--backend docker|venv]
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND="${VLLM_DGEMMA_BACKEND:-docker}"
# Pinned by digest for reproducibility. PRE-RELEASE / experimental image
# (upstream tag: vllm/vllm-openai:gemma). Refresh the digest when a newer
# pre-release is published. Requires an NVIDIA Blackwell/Hopper GPU + NVFP4.
IMAGE="${VLLM_DGEMMA_IMAGE:-vllm/vllm-openai@sha256:9c719fc0c869092c7d0533f8357d6985a38d5ff03b20ffb6a4620c2b4806dd4b}"
VENV_DIR="${VLLM_DGEMMA_VENV_DIR:-$ROOT_DIR/.venv-vllm-dgemma}"

usage() {
  cat <<'EOF'
Usage: ./scripts/setup-vllm-diffusiongemma.sh [--backend docker|venv]

  --backend docker   Pull the pinned pre-release vLLM image (default).
  --backend venv     Create .venv-vllm-dgemma and install vLLM (fallback;
                     needs a vLLM build that supports diffusion_gemma).
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
    echo "[setup-vllm-diffusiongemma] NOTE: the venv backend only works if the"
    echo "  installed vLLM build supports 'diffusion_gemma'. Until mainline vLLM"
    echo "  includes it, prefer '--backend docker' with the pinned pre-release image."
    ;;
  *)
    echo "[setup-vllm-diffusiongemma] unknown backend: $BACKEND (expected docker|venv)" >&2
    exit 2 ;;
esac
