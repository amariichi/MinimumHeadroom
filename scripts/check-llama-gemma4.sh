#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LLAMA_DIR="${LLAMA_CPP_DIR:-$(dirname "$ROOT_DIR")/llama.cpp}"
MTP_MODE="${GEMMA4_MTP:-off}"
REQUIRE_BUILD_TOOLS=0
KNOWN_GOOD_COMMIT="c1304d7b28e14380dbb90252c92aa2798db60185"
FAILURES=0
WARNINGS=0

usage() {
  cat <<'EOF'
Usage: ./scripts/check-llama-gemma4.sh [options]

Read-only compatibility check for a llama.cpp checkout used by Gemma 4.

Options:
  --llama-dir PATH          llama.cpp checkout (default: LLAMA_CPP_DIR or
                            a llama.cpp sibling of this repository)
  --mtp-mode off|on|auto    Check runtime flags required by this mode
  --require-build-tools     Also require converter and llama-quantize
  -h, --help                Show this help

This command never pulls, checks out, builds, or edits the selected checkout.
EOF
}

while (($# > 0)); do
  case "$1" in
    --llama-dir)
      [[ -n "${2:-}" ]] || { echo "[check-llama-gemma4] --llama-dir requires a value" >&2; exit 2; }
      LLAMA_DIR="$2"
      shift 2
      ;;
    --mtp-mode)
      [[ -n "${2:-}" ]] || { echo "[check-llama-gemma4] --mtp-mode requires a value" >&2; exit 2; }
      MTP_MODE="$2"
      shift 2
      ;;
    --require-build-tools)
      REQUIRE_BUILD_TOOLS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[check-llama-gemma4] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "${MTP_MODE,,}" in
  off|on|auto) ;;
  *)
    echo "[check-llama-gemma4] --mtp-mode must be off, on, or auto" >&2
    exit 2
    ;;
esac

ok() {
  echo "[ok] $*"
}

warn() {
  WARNINGS=$((WARNINGS + 1))
  echo "[warn] $*"
}

fail() {
  FAILURES=$((FAILURES + 1))
  echo "[fail] $*" >&2
}

if [[ ! -d "$LLAMA_DIR" ]]; then
  fail "llama.cpp directory is missing: $LLAMA_DIR"
  echo "[check-llama-gemma4] failures=${FAILURES} warnings=${WARNINGS}" >&2
  exit 1
fi
ok "checkout exists: $LLAMA_DIR"

SERVER_BIN="${GEMMA4_INTERPRETER_BIN:-$LLAMA_DIR/build/bin/llama-server}"
QUANTIZE_BIN="${GEMMA4_QUANTIZE_BIN:-$LLAMA_DIR/build/bin/llama-quantize}"
CONVERTER="$LLAMA_DIR/convert_hf_to_gguf.py"
GEMMA_CONVERSION="$LLAMA_DIR/conversion/gemma.py"

if git -C "$LLAMA_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  COMMIT="$(git -C "$LLAMA_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [[ "$COMMIT" == "$KNOWN_GOOD_COMMIT" ]]; then
    ok "known-good commit: $COMMIT"
  elif [[ -n "$COMMIT" ]]; then
    warn "checkout commit differs from the recorded known-good commit: $COMMIT"
  else
    fail "could not read checkout commit"
  fi
  if [[ -n "$(git -C "$LLAMA_DIR" status --short 2>/dev/null)" ]]; then
    warn "checkout is dirty; it will not be modified"
  else
    ok "checkout is clean"
  fi
else
  warn "directory is not a Git checkout; binary capabilities will still be checked"
fi

if [[ ! -x "$SERVER_BIN" ]]; then
  fail "llama-server is missing or not executable: $SERVER_BIN"
else
  VERSION_OUTPUT="$("$SERVER_BIN" --version 2>&1 || true)"
  VERSION_LINE="$(printf '%s\n' "$VERSION_OUTPUT" | awk '/version:/ { print; exit }')"
  ok "llama-server executable${VERSION_LINE:+ ($VERSION_LINE)}"
  HELP_OUTPUT="$("$SERVER_BIN" --help 2>&1 || true)"
  for flag in --mmproj; do
    if [[ "$HELP_OUTPUT" == *"$flag"* ]]; then
      ok "runtime flag available: $flag"
    else
      fail "runtime flag missing: $flag"
    fi
  done
  if [[ "${MTP_MODE,,}" != "off" ]]; then
    for flag in --spec-draft-model --spec-type --spec-draft-n-max --spec-draft-ngl; do
      if [[ "$HELP_OUTPUT" == *"$flag"* ]]; then
        ok "MTP flag available: $flag"
      else
        fail "MTP flag missing: $flag"
      fi
    done
    if [[ "$HELP_OUTPUT" == *"draft-mtp"* ]]; then
      ok "MTP mode available: draft-mtp"
    else
      fail "draft-mtp is not listed by llama-server"
    fi
  fi
fi

if ((REQUIRE_BUILD_TOOLS == 1)); then
  if [[ -f "$CONVERTER" ]]; then
    ok "converter exists: $CONVERTER"
  else
    fail "converter is missing: $CONVERTER"
  fi
  if [[ -x "$QUANTIZE_BIN" ]]; then
    ok "quantizer exists: $QUANTIZE_BIN"
  else
    fail "quantizer is missing: $QUANTIZE_BIN"
  fi
  if [[ -f "$GEMMA_CONVERSION" ]] \
    && rg -q "Gemma4AssistantForCausalLM" "$GEMMA_CONVERSION" \
    && rg -q "Gemma4UnifiedAssistantForCausalLM" "$GEMMA_CONVERSION"; then
    ok "Gemma 4 assistant architectures are registered"
  else
    fail "Gemma 4 assistant architecture registration is missing"
  fi
  REQUIREMENTS="$LLAMA_DIR/requirements/requirements-convert_hf_to_gguf.txt"
  if [[ -f "$REQUIREMENTS" ]]; then
    ok "converter requirements exist: $REQUIREMENTS"
  else
    fail "converter requirements are missing: $REQUIREMENTS"
  fi
fi

echo "[check-llama-gemma4] failures=${FAILURES} warnings=${WARNINGS}"
((FAILURES == 0))
