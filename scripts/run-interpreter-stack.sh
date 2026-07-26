#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/scripts/lib/env-defaults.sh"

MH_ENV_FILE="${MH_ENV_FILE:-$(mh_default_env_file)}"
export MH_ENV_FILE
mh_load_env_defaults "$MH_ENV_FILE"

PRESET="${INTERPRETER_PRESET:-gemma4-supertonic}"
INTERPRETER_HOST="${INTERPRETER_HOST:-127.0.0.1}"
INTERPRETER_PORT="${INTERPRETER_PORT:-8765}"
NEMOTRON_HOST="${NEMOTRON_ASR_HOST:-127.0.0.1}"
NEMOTRON_PORT="${NEMOTRON_ASR_PORT:-8095}"
GEMMA_HOST="${GEMMA4_INTERPRETER_HOST:-127.0.0.1}"
GEMMA_PORT="${GEMMA4_INTERPRETER_PORT:-8093}"
GEMMA_DRAFT_TOKENS="${GEMMA4_INTERPRETER_DRAFT_TOKENS:-8}"
SILERO_HOST="${INTERPRETER_SILERO_HOST:-127.0.0.1}"
SILERO_PORT="${INTERPRETER_SILERO_PORT:-8094}"
START_ATOM_BRIDGE="${MH_INTERPRETER_START_ATOM_BRIDGE:-1}"
ATOM_TTS_CODEC="${MH_ATOM_TTS_CODEC:-auto}"
PORT_RELEASE_WAIT_SECONDS="${MH_INTERPRETER_PORT_RELEASE_WAIT_SECONDS:-0}"
DRY_RUN=0

list_presets() {
  cat <<'EOF'
gemma4-supertonic
gemma4-qwen3
nemotron-gemma4-supertonic
nemotron-gemma4-qwen3
EOF
}

usage() {
  cat <<'EOF'
Usage: ./scripts/run-interpreter-stack.sh [options]

Start only the services required by one interpreter preset.

Options:
  --preset <name>       gemma4-supertonic | gemma4-qwen3 |
                        nemotron-gemma4-supertonic | nemotron-gemma4-qwen3
  --host <host>         Interpreter UI bind host (default: 127.0.0.1)
  --port <port>         Interpreter UI port (default: 8765; exclusive with operator)
  --list-presets        Print the four supported presets and exit
  --dry-run             Print planned processes without starting them
  -h, --help            Show this help

Preset ownership:
  gemma4-supertonic             Gemma 4 ASR/translation + Supertonic
  gemma4-qwen3                  Gemma 4 ASR/translation + Qwen3-TTS
  nemotron-gemma4-supertonic    Nemotron ASR + Gemma 4 translation + Supertonic
  nemotron-gemma4-qwen3         Nemotron ASR + Gemma 4 translation + Qwen3-TTS

Compatibility:
  light-cloud           Deprecated alias for nemotron-gemma4-supertonic

Environment:
  MH_ENV_FILE                        Persistent defaults file; default:
                                     ${XDG_CONFIG_HOME:-$HOME/.config}/minimum-headroom.env
  MH_INTERPRETER_AUTH_TOKEN       Required for a non-loopback bind
  GEMMA4_MTP=off|on|auto          Default: off
  GEMMA4_INTERPRETER_DRAFT_TOKENS Maximum MTP draft tokens (default: 8)
  MH_INTERPRETER_PORT_RELEASE_WAIT_SECONDS
                                 Wait for an old stack to release its ports
                                 before refusing startup (default: 0)
  MH_ATOM_TTS_CODEC=auto|pcm16|ima_adpcm
                                 Atom-only TTS transport codec (default: auto)
  MH_INTERPRETER_START_ATOM_BRIDGE=0
                                 Do not start the supervised Atom HTTP bridge
EOF
}

require_value() {
  if [[ -z "${2:-}" ]]; then
    echo "[run-interpreter-stack] $1 requires a value" >&2
    exit 2
  fi
}

while (($# > 0)); do
  case "$1" in
    --preset)
      require_value "$1" "${2:-}"
      PRESET="$2"
      shift 2
      ;;
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
    --list-presets)
      list_presets
      exit 0
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
      echo "[run-interpreter-stack] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$PRESET" == "light-cloud" ]]; then
  echo "[run-interpreter-stack] warning: light-cloud is deprecated; using nemotron-gemma4-supertonic (local Gemma translation)" >&2
  PRESET="nemotron-gemma4-supertonic"
fi

START_NEMOTRON=0
case "$PRESET" in
  gemma4-supertonic)
    ASR_OWNER="gemma4"
    TTS_OWNER="supertonic"
    ;;
  gemma4-qwen3)
    ASR_OWNER="gemma4"
    TTS_OWNER="qwen3"
    ;;
  nemotron-gemma4-supertonic)
    START_NEMOTRON=1
    ASR_OWNER="nemotron-3.5-asr"
    TTS_OWNER="supertonic"
    ;;
  nemotron-gemma4-qwen3)
    START_NEMOTRON=1
    ASR_OWNER="nemotron-3.5-asr"
    TTS_OWNER="qwen3"
    ;;
  *)
    echo "[run-interpreter-stack] unsupported preset: $PRESET" >&2
    list_presets >&2
    exit 2
    ;;
esac
INTENT_OWNER="gemma4"
TRANSLATION_OWNER="gemma4"

case "${ATOM_TTS_CODEC,,}" in
  auto|pcm16|ima_adpcm) ;;
  *)
    echo "[run-interpreter-stack] MH_ATOM_TTS_CODEC must be auto, pcm16, or ima_adpcm" >&2
    exit 2
    ;;
esac

if [[ ! "$PORT_RELEASE_WAIT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "[run-interpreter-stack] MH_INTERPRETER_PORT_RELEASE_WAIT_SECONDS must be a non-negative integer" >&2
  exit 2
fi

if [[ "$INTERPRETER_HOST" != "127.0.0.1" && "$INTERPRETER_HOST" != "localhost" && "$INTERPRETER_HOST" != "::1" && -z "${MH_INTERPRETER_AUTH_TOKEN:-${MH_FACE_AUTH_TOKEN:-}}" ]]; then
  echo "[run-interpreter-stack] MH_INTERPRETER_AUTH_TOKEN is required for host ${INTERPRETER_HOST}" >&2
  exit 2
fi

echo "[run-interpreter-stack] preset=${PRESET}"
echo "[run-interpreter-stack] providers: asr=${ASR_OWNER} intent=${INTENT_OWNER} translation=${TRANSLATION_OWNER} tts=${TTS_OWNER}"
echo "[run-interpreter-stack] ui=http://${INTERPRETER_HOST}:${INTERPRETER_PORT}/"
echo "[run-interpreter-stack] ports: nemotron=${NEMOTRON_PORT} gemma=${GEMMA_PORT} silero=${SILERO_PORT}"
echo "[run-interpreter-stack] atom_bridge=$([[ "$START_ATOM_BRIDGE" == "0" ]] && printf disabled || printf supervised)"
echo "[run-interpreter-stack] atom_tts_codec=${ATOM_TTS_CODEC,,}"
revision_line="gemma_runtime=29d097773436b69ff9feafd636ab4cf873786537"
if ((START_NEMOTRON == 1)); then
  revision_line+=" nemotron=f3d333391852ba876df169dcc9ba902d25b6ab0b"
fi
if [[ "$TTS_OWNER" == "supertonic" ]]; then
  revision_line+=" supertonic=724fb5abbf5502583fb520898d45929e62f02c0b"
else
  revision_line+=" qwen3=85e237c12c027371202489a0ec509ded67b5e4b5"
fi
echo "[run-interpreter-stack] revisions: ${revision_line}"

if ((DRY_RUN == 1)); then
  if ((START_NEMOTRON == 1)); then
    echo "[dry-run] run-nemotron-asr.sh --host ${NEMOTRON_HOST} --port ${NEMOTRON_PORT}"
  fi
  echo "[dry-run] GEMMA4_MTP=${GEMMA4_MTP:-off} GEMMA4_INTERPRETER_DRAFT_TOKENS=${GEMMA_DRAFT_TOKENS} run-gemma4-interpreter.sh --host ${GEMMA_HOST} --port ${GEMMA_PORT}"
  echo "[dry-run] run-silero-vad-worker.sh --host ${SILERO_HOST} --port ${SILERO_PORT}"
  echo "[dry-run] node face-app/dist/interpreter_index.js"
  if [[ "$START_ATOM_BRIDGE" != "0" ]]; then
    echo "[dry-run] node scripts/atoms3r-http-bridge.mjs -> ws://127.0.0.1:${INTERPRETER_PORT}/ws"
  fi
  exit 0
fi

port_is_listening() {
  local port="$1"
  if ! command -v ss >/dev/null 2>&1; then
    return 1
  fi
  ss -ltnH 2>/dev/null | awk '{print $4}' | rg -q "[:.]${port}$"
}

declare -a REQUIRED_PORTS=("$INTERPRETER_PORT" "$SILERO_PORT" "$GEMMA_PORT")
if ((START_NEMOTRON == 1)); then
  REQUIRED_PORTS+=("$NEMOTRON_PORT")
fi

if ((PORT_RELEASE_WAIT_SECONDS > 0)); then
  wait_started_at=$SECONDS
  wait_announced=0
  while true; do
    occupied_ports=()
    for required_port in "${REQUIRED_PORTS[@]}"; do
      if port_is_listening "$required_port"; then
        occupied_ports+=("$required_port")
      fi
    done
    if ((${#occupied_ports[@]} == 0)); then
      break
    fi
    if ((wait_announced == 0)); then
      echo "[run-interpreter-stack] waiting up to ${PORT_RELEASE_WAIT_SECONDS}s for previous listeners to release ports: ${occupied_ports[*]}"
      wait_announced=1
    fi
    if ((SECONDS - wait_started_at >= PORT_RELEASE_WAIT_SECONDS)); then
      break
    fi
    sleep 0.1
  done
fi

for required_port in "${REQUIRED_PORTS[@]}"; do
  if port_is_listening "$required_port"; then
    echo "[run-interpreter-stack] port ${required_port} is already listening; no process was started or stopped" >&2
    exit 2
  fi
done

declare -a PIDS=()
declare -A NAMES=()

cleanup() {
  local pid
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT INT TERM

start_proc() {
  local name="$1"
  shift
  "$@" &
  local pid=$!
  PIDS+=("$pid")
  NAMES["$pid"]="$name"
  echo "[run-interpreter-stack] started ${name} (pid=${pid})"
}

if ((START_NEMOTRON == 1)); then
  if [[ ! -x ./scripts/run-nemotron-asr.sh ]]; then
    echo "[run-interpreter-stack] missing executable: ./scripts/run-nemotron-asr.sh" >&2
    exit 2
  fi
  start_proc "nemotron-asr" \
    ./scripts/run-nemotron-asr.sh --host "$NEMOTRON_HOST" --port "$NEMOTRON_PORT"
fi

if [[ ! -x ./scripts/run-gemma4-interpreter.sh ]]; then
  echo "[run-interpreter-stack] missing executable: ./scripts/run-gemma4-interpreter.sh" >&2
  exit 2
fi
start_proc "gemma4" \
  env GEMMA4_MTP="${GEMMA4_MTP:-off}" \
  GEMMA4_INTERPRETER_DRAFT_TOKENS="$GEMMA_DRAFT_TOKENS" \
  ./scripts/run-gemma4-interpreter.sh --host "$GEMMA_HOST" --port "$GEMMA_PORT"

start_proc "silero-vad" \
  env MH_SILERO_DEVICE="${MH_SILERO_DEVICE:-cpu}" \
  ./scripts/run-silero-vad-worker.sh --host "$SILERO_HOST" --port "$SILERO_PORT"

start_proc "interpreter" \
  env \
    INTERPRETER_PRESET="$PRESET" \
    INTERPRETER_HOST="$INTERPRETER_HOST" \
    INTERPRETER_PORT="$INTERPRETER_PORT" \
    MH_NEMOTRON_ASR_BASE_URL="http://${NEMOTRON_HOST}:${NEMOTRON_PORT}" \
    MH_GEMMA4_BASE_URL="http://${GEMMA_HOST}:${GEMMA_PORT}/v1" \
    MH_INTERPRETER_SILERO_BASE_URL="http://${SILERO_HOST}:${SILERO_PORT}" \
    MH_INTERPRETER_AUTH_TOKEN="${MH_INTERPRETER_AUTH_TOKEN:-${MH_FACE_AUTH_TOKEN:-}}" \
    MH_ATOM_TTS_CODEC="${ATOM_TTS_CODEC,,}" \
    node face-app/dist/interpreter_index.js

if [[ "$START_ATOM_BRIDGE" != "0" ]]; then
  BRIDGE_HOST="$INTERPRETER_HOST"
  if [[ "$BRIDGE_HOST" == "0.0.0.0" || "$BRIDGE_HOST" == "::" ]]; then
    BRIDGE_HOST="127.0.0.1"
  fi
  start_proc "atom-http-bridge" \
    env \
      FACE_WS_URL="ws://${BRIDGE_HOST}:${INTERPRETER_PORT}/ws" \
      MH_FACE_AUTH_TOKEN="${MH_INTERPRETER_AUTH_TOKEN:-${MH_FACE_AUTH_TOKEN:-}}" \
      ATOM_HEADROOM_FETCH_AUDIO_REF=1 \
      node scripts/atoms3r-http-bridge.mjs
fi

echo "[run-interpreter-stack] all selected services started. Press Ctrl+C to stop."

exit_code=0
while true; do
  exited_pid=""
  if wait -n "${PIDS[@]}"; then
    exit_code=0
  else
    exit_code=$?
  fi
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      exited_pid="$pid"
      break
    fi
  done
  if [[ -n "$exited_pid" ]]; then
    echo "[run-interpreter-stack] ${NAMES[$exited_pid]:-service} exited (pid=${exited_pid}, code=${exit_code}); stopping this interpreter stack." >&2
    break
  fi
done

exit "$exit_code"
