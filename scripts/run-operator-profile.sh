#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/lib/env-defaults.sh"

MH_ENV_FILE="${MH_ENV_FILE:-$(mh_default_env_file)}"
export MH_ENV_FILE
mh_load_env_defaults "$MH_ENV_FILE"

PROFILE="${MH_RUNTIME_OPERATOR_PROFILE:-default}"

list_profiles() {
  cat <<'EOF'
default
realtime
supertonic
supertonic-realtime
qwen3
qwen3-realtime
EOF
}

usage() {
  cat <<'EOF'
Usage: ./scripts/run-operator-profile.sh [--profile <name>] [--list-profiles]

Run exactly one allowlisted operator backend profile. This wrapper is used by
the authenticated runtime-mode switch and accepts no arbitrary stack command.
EOF
}

while (($# > 0)); do
  case "$1" in
    --profile)
      [[ -n "${2:-}" ]] || {
        echo "[run-operator-profile] --profile requires a value" >&2
        exit 2
      }
      PROFILE="$2"
      shift 2
      ;;
    --list-profiles)
      list_profiles
      exit 0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[run-operator-profile] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

export MH_RUNTIME_OPERATOR_PROFILE="$PROFILE"
export MH_STACK_START_REALTIME_ASR=0
export MH_OPERATOR_REALTIME_ASR_ENABLED=0
case "$PROFILE" in
  default)
    export TTS_ENGINE=kokoro
    ;;
  realtime)
    export TTS_ENGINE=kokoro
    export MH_STACK_START_REALTIME_ASR=1
    export MH_OPERATOR_REALTIME_ASR_ENABLED=1
    ;;
  supertonic)
    export TTS_ENGINE=supertonic
    ;;
  supertonic-realtime)
    export TTS_ENGINE=supertonic
    export MH_STACK_START_REALTIME_ASR=1
    export MH_OPERATOR_REALTIME_ASR_ENABLED=1
    ;;
  qwen3)
    export TTS_ENGINE=qwen3
    ;;
  qwen3-realtime)
    export TTS_ENGINE=qwen3
    export MH_STACK_START_REALTIME_ASR=1
    export MH_OPERATOR_REALTIME_ASR_ENABLED=1
    ;;
  *)
    echo "[run-operator-profile] unsupported profile: $PROFILE" >&2
    list_profiles >&2
    exit 2
    ;;
esac

exec ./scripts/run-operator-stack.sh
