#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="https://github.com/ggml-org/llama.cpp.git"
KNOWN_GOOD_COMMIT="c1304d7b28e14380dbb90252c92aa2798db60185"
PREFIX=""
CHECK_DEPS=0
DRY_RUN=0
CUDA_ARCH="${LLAMA_CPP_CUDA_ARCHITECTURES:-}"
JOBS="${LLAMA_CPP_BUILD_JOBS:-}"

usage() {
  cat <<'EOF'
Usage: ./scripts/setup-llama-cpp-gemma4.sh [options]

Options:
  --check-deps             Read-only host toolchain check; --prefix is optional
  --prefix PATH            New checkout directory. Required for clone/build
  --cuda-architectures X   Optional CMake CUDA architecture, for example
                           120a-real on a compatible Blackwell toolchain
  --jobs N                 Parallel build jobs
  --dry-run                Print the exact plan without cloning or building
  -h, --help               Show this help

An existing directory is never pulled, reset, checked out, or rebuilt. Inspect
it with check-llama-gemma4.sh. Clone/build only targets a new explicit path.
EOF
}

while (($# > 0)); do
  case "$1" in
    --check-deps)
      CHECK_DEPS=1
      shift
      ;;
    --prefix)
      [[ -n "${2:-}" ]] || { echo "[setup-llama-cpp-gemma4] --prefix requires a value" >&2; exit 2; }
      PREFIX="$2"
      shift 2
      ;;
    --cuda-architectures)
      [[ -n "${2:-}" ]] || { echo "[setup-llama-cpp-gemma4] --cuda-architectures requires a value" >&2; exit 2; }
      CUDA_ARCH="$2"
      shift 2
      ;;
    --jobs)
      [[ -n "${2:-}" ]] || { echo "[setup-llama-cpp-gemma4] --jobs requires a value" >&2; exit 2; }
      JOBS="$2"
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
      echo "[setup-llama-cpp-gemma4] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

missing=0
for command_name in git cmake; do
  if command -v "$command_name" >/dev/null 2>&1; then
    echo "[ok] command: $command_name"
  else
    echo "[fail] missing command: $command_name" >&2
    missing=$((missing + 1))
  fi
done
if command -v nvcc >/dev/null 2>&1; then
  echo "[ok] CUDA compiler: $(command -v nvcc)"
else
  echo "[warn] nvcc not found on PATH; a CUDA toolkit is required for the recommended GPU build"
fi
if ((CHECK_DEPS == 1)); then
  ((missing == 0))
  exit
fi

if [[ -z "$PREFIX" ]]; then
  echo "[setup-llama-cpp-gemma4] --prefix is required for clone/build" >&2
  exit 2
fi
if [[ -e "$PREFIX" ]]; then
  echo "[setup-llama-cpp-gemma4] target already exists and will not be modified: $PREFIX" >&2
  echo "[setup-llama-cpp-gemma4] use ./scripts/check-llama-gemma4.sh --llama-dir \"$PREFIX\"" >&2
  exit 2
fi

echo "[setup-llama-cpp-gemma4] repository=${REPOSITORY}"
echo "[setup-llama-cpp-gemma4] commit=${KNOWN_GOOD_COMMIT}"
echo "[setup-llama-cpp-gemma4] prefix=${PREFIX}"
echo "[setup-llama-cpp-gemma4] cuda_architectures=${CUDA_ARCH:-toolchain-default}"
if ((DRY_RUN == 1)); then
  echo "[setup-llama-cpp-gemma4] dry-run: would clone a new checkout, detach at the pinned commit, and build CUDA llama-server/llama-quantize"
  exit 0
fi
((missing == 0)) || exit 1

git clone "$REPOSITORY" "$PREFIX"
git -C "$PREFIX" checkout --detach "$KNOWN_GOOD_COMMIT"

declare -a CMAKE_ARGS=(
  -S "$PREFIX"
  -B "$PREFIX/build"
  -DCMAKE_BUILD_TYPE=Release
  -DGGML_CUDA=ON
  -DGGML_CUDA_FA=ON
)
if [[ -n "$CUDA_ARCH" ]]; then
  CMAKE_ARGS+=("-DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCH}")
fi
cmake "${CMAKE_ARGS[@]}"
declare -a BUILD_ARGS=(--build "$PREFIX/build" --config Release)
if [[ -n "$JOBS" ]]; then
  BUILD_ARGS+=(--parallel "$JOBS")
else
  BUILD_ARGS+=(--parallel)
fi
cmake "${BUILD_ARGS[@]}"

"$(dirname "$0")/check-llama-gemma4.sh" \
  --llama-dir "$PREFIX" \
  --mtp-mode on \
  --require-build-tools
