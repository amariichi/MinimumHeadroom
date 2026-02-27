#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

AUDIO_TARGET="${FACE_AUDIO_TARGET:-local}"
UI_MODE="${FACE_UI_MODE:-auto}"

usage() {
  cat <<'EOF'
Usage: ./scripts/run-face-app.sh [--audio-target local|browser|both] [--ui-mode auto|pc|mobile]

Options:
  --audio-target  Select speech output destination.
  --ui-mode       Select UI layout mode.
  -h, --help      Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --audio-target)
      if (($# < 2)); then
        echo "[run-face-app] --audio-target requires a value" >&2
        exit 2
      fi
      AUDIO_TARGET="$2"
      shift 2
      ;;
    --audio-target=*)
      AUDIO_TARGET="${1#*=}"
      shift
      ;;
    --ui-mode)
      if (($# < 2)); then
        echo "[run-face-app] --ui-mode requires a value" >&2
        exit 2
      fi
      UI_MODE="$2"
      shift 2
      ;;
    --ui-mode=*)
      UI_MODE="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[run-face-app] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "${AUDIO_TARGET,,}" in
  local|browser|both)
    AUDIO_TARGET="${AUDIO_TARGET,,}"
    ;;
  *)
    echo "[run-face-app] invalid --audio-target: $AUDIO_TARGET (expected: local|browser|both)" >&2
    exit 2
    ;;
esac

case "${UI_MODE,,}" in
  auto|pc|mobile)
    UI_MODE="${UI_MODE,,}"
    ;;
  *)
    echo "[run-face-app] invalid --ui-mode: $UI_MODE (expected: auto|pc|mobile)" >&2
    exit 2
    ;;
esac

exec env FACE_AUDIO_TARGET="$AUDIO_TARGET" FACE_UI_MODE="$UI_MODE" node face-app/dist/index.js
