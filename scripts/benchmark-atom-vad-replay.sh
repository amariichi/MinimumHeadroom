#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SILERO_PORT="${MH_VAD_REPLAY_SILERO_PORT:-18094}"
BACKENDS="rms,silero"
DRY_RUN=0
HELP=0
declare -a FORWARD_ARGS=()

usage() {
  cat <<'EOF'
Usage: ./scripts/benchmark-atom-vad-replay.sh [options]

Starts an isolated CPU Silero worker only when requested, replays the pinned
interpreter corpus as Atom-shaped frames, writes a JSON report, and stops only
the worker process started by this invocation. It does not contact Atom,
change firmware/NVS, or restart the operator.

Wrapper options:
  --silero-port PORT      isolated worker port (default 18094)
  --backends LIST         rms, silero, or rms,silero
  --dry-run               validate/list cases without starting a worker
  -h, --help              show replay options

All other options are passed to scripts/atom-vad-replay.mjs.
EOF
}

while (($# > 0)); do
  case "$1" in
    --silero-port)
      if (($# < 2)); then
        echo "[benchmark-atom-vad-replay] --silero-port requires a value" >&2
        exit 2
      fi
      SILERO_PORT="$2"
      shift 2
      ;;
    --backends)
      if (($# < 2)); then
        echo "[benchmark-atom-vad-replay] --backends requires a value" >&2
        exit 2
      fi
      BACKENDS="$2"
      FORWARD_ARGS+=("--backends" "$2")
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      FORWARD_ARGS+=("--dry-run")
      shift
      ;;
    -h|--help)
      HELP=1
      shift
      ;;
    *)
      FORWARD_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ ! "$SILERO_PORT" =~ ^[0-9]+$ ]] || ((SILERO_PORT < 1024 || SILERO_PORT > 65535)); then
  echo "[benchmark-atom-vad-replay] invalid --silero-port: $SILERO_PORT" >&2
  exit 2
fi

if ((HELP == 1)); then
  usage
  node scripts/atom-vad-replay.mjs --help
  exit 0
fi

NORMALIZED_BACKENDS="${BACKENDS//[[:space:]]/}"
NEEDS_SILERO=0
if [[ ",${NORMALIZED_BACKENDS}," == *",silero,"* ]]; then
  NEEDS_SILERO=1
fi

if ((DRY_RUN == 1)); then
  echo "[benchmark-atom-vad-replay] dry-run; no worker or Atom connection"
  node scripts/atom-vad-replay.mjs \
    "${FORWARD_ARGS[@]}" \
    --silero-base-url "http://127.0.0.1:${SILERO_PORT}"
  exit 0
fi

WORKER_PID=""
WORKER_START_TICKS=""

cleanup() {
  local observed_ticks=""
  if [[ -n "$WORKER_PID" && -r "/proc/${WORKER_PID}/stat" ]]; then
    observed_ticks="$(awk '{print $22}' "/proc/${WORKER_PID}/stat" 2>/dev/null || true)"
  fi
  if [[ -n "$WORKER_PID" && -n "$WORKER_START_TICKS" && "$observed_ticks" == "$WORKER_START_TICKS" ]]; then
    if kill -0 "$WORKER_PID" 2>/dev/null; then
      kill "$WORKER_PID" 2>/dev/null || true
      wait "$WORKER_PID" 2>/dev/null || true
    fi
  fi
}
trap cleanup EXIT INT TERM

if ((NEEDS_SILERO == 1)); then
  if ss -ltnH 2>/dev/null | awk '{print $4}' | rg -q "[:.]${SILERO_PORT}$"; then
    echo "[benchmark-atom-vad-replay] port ${SILERO_PORT} is already listening" >&2
    exit 2
  fi
  echo "[benchmark-atom-vad-replay] starting isolated Silero worker on 127.0.0.1:${SILERO_PORT}"
  env \
    MH_SILERO_DEVICE=cpu \
    MH_SILERO_MAX_SESSIONS="${MH_SILERO_MAX_SESSIONS:-8}" \
    ./scripts/run-silero-vad-worker.sh \
      --host 127.0.0.1 \
      --port "$SILERO_PORT" &
  WORKER_PID="$!"
  WORKER_START_TICKS="$(awk '{print $22}' "/proc/${WORKER_PID}/stat")"

  READY=0
  for _attempt in {1..120}; do
    if ! kill -0 "$WORKER_PID" 2>/dev/null; then
      echo "[benchmark-atom-vad-replay] Silero worker exited before health ready" >&2
      exit 1
    fi
    if curl -fsS "http://127.0.0.1:${SILERO_PORT}/health" >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 0.25
  done
  if ((READY != 1)); then
    echo "[benchmark-atom-vad-replay] Silero health timed out" >&2
    exit 1
  fi
fi

node scripts/atom-vad-replay.mjs \
  "${FORWARD_ARGS[@]}" \
  --silero-base-url "http://127.0.0.1:${SILERO_PORT}"
