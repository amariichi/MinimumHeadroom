#!/usr/bin/env bash
# =============================================================================
#  run-vision-stack.sh — idempotently bring up the M12 vision stack.
#
#  Persistent configuration is read from:
#    ~/.config/minimum-headroom.env
#
#  Required keys for live operation:
#    VISION_CAMERA_URL     AtomS3R-M12 snapshot URL
#    MH_FACE_AUTH_TOKEN    X-Headroom-Auth token for the M12 audio endpoint
#    M12_AUDIO_URL         AtomS3R-M12 /api/headroom/audio URL
#
#  Optional overrides:
#    VISION_PORT, VISION_HOST, VISION_CACHE_DIR, VISION_DB_PATH, VISION_* knobs
#    VLLM_DGEMMA_* knobs for scripts/run-vllm-diffusiongemma.sh
#    M12_SPEAKER_* knobs for scripts/run-m12-alert-speaker.sh
#
#  This script starts/reuses only the camera stack:
#    diffusiongemma vLLM -> vision-worker -> M12 alert speaker bridge
#  It does NOT start Voxtral or touch ASR. The operator stack owns ASR; keep
#  Parakeet on CPU there with MH_ASR_DEVICE=cpu when VRAM is tight.
#
#  Use --check (alias --dry-run) to verify prerequisites and print the plan
#  without starting anything.
# =============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${MH_ENV_FILE:-$HOME/.config/minimum-headroom.env}"
CHECK_ONLY=0

usage() {
  cat <<'EOF'
Usage: ./scripts/run-vision-stack.sh [--check|--dry-run]

Starts/reuses:
  1. diffusiongemma vLLM at http://127.0.0.1:${VLLM_DGEMMA_PORT:-8000}/v1
  2. vision-worker at http://${VISION_HOST:-127.0.0.1}:${VISION_PORT:-8095}
  3. M12 alert speaker bridge at ${M12_SPEAKER_HOST:-127.0.0.1}:${M12_SPEAKER_PORT:-8096}

--check / --dry-run prints prerequisites, current health, and the start plan
without starting services.
EOF
}

while (($# > 0)); do
  case "$1" in
    --check|--dry-run) CHECK_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[run-vision-stack] unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

VLLM_PORT="${VLLM_DGEMMA_PORT:-8000}"
VISION_HOST="${VISION_HOST:-127.0.0.1}"
VISION_PORT="${VISION_PORT:-8095}"
VISION_MODEL_URL="${VISION_MODEL_URL:-http://127.0.0.1:${VLLM_PORT}/v1}"
M12_SPEAKER_HOST="${M12_SPEAKER_HOST:-127.0.0.1}"
M12_SPEAKER_PORT="${M12_SPEAKER_PORT:-8096}"
VISION_ALERT_WEBHOOK="${VISION_ALERT_WEBHOOK:-http://127.0.0.1:${M12_SPEAKER_PORT}/alert}"
LOG_DIR="${VISION_STACK_LOG_DIR:-${HOME}/.cache/minimum-headroom}"
VLLM_LOG="$LOG_DIR/vision-stack-diffusiongemma.log"
WORKER_LOG="$LOG_DIR/vision-stack-worker.log"
SPEAKER_LOG="$LOG_DIR/vision-stack-m12-speaker.log"

log() { echo "[run-vision-stack] $*"; }

http_ok() {
  curl -fsS --max-time 2 "$1" >/dev/null 2>&1
}

tcp_open() {
  local host="$1" port="$2"
  timeout 1 bash -c ":</dev/tcp/${host}/${port}" >/dev/null 2>&1
}

wait_http() {
  local name="$1" url="$2" log_file="$3"
  log "waiting for ${name}: ${url}"
  for _ in $(seq 1 120); do
    if http_ok "$url"; then
      log "${name} ready"
      return 0
    fi
    sleep 2
  done
  log "${name} did not become ready; see ${log_file}"
  return 1
}

wait_tcp() {
  local name="$1" host="$2" port="$3" log_file="$4"
  log "waiting for ${name}: ${host}:${port}"
  for _ in $(seq 1 60); do
    if tcp_open "$host" "$port"; then
      log "${name} ready"
      return 0
    fi
    sleep 1
  done
  log "${name} did not open ${host}:${port}; see ${log_file}"
  return 1
}

missing_required=()
for key in VISION_CAMERA_URL MH_FACE_AUTH_TOKEN M12_AUDIO_URL; do
  if [[ -z "${!key:-}" ]]; then
    missing_required+=("$key")
  fi
done

vllm_models_url="${VISION_MODEL_URL%/}/models"
vision_health_url="http://${VISION_HOST}:${VISION_PORT}/healthz"

print_check() {
  log "env file: ${ENV_FILE} $([[ -f "$ENV_FILE" ]] && echo '(found)' || echo '(missing)')"
  if ((${#missing_required[@]} > 0)); then
    log "missing required live env keys: ${missing_required[*]}"
  else
    log "required live env keys: present"
  fi
  log "logs: ${LOG_DIR}"
  log "ASR: not managed here; do not start Voxtral. Operator stack owns ASR (Parakeet-on-CPU: MH_ASR_DEVICE=cpu)."

  if http_ok "$vllm_models_url"; then
    log "diffusiongemma: healthy at ${vllm_models_url} -> reuse"
  elif tcp_open 127.0.0.1 "$VLLM_PORT"; then
    log "diffusiongemma: port ${VLLM_PORT} is open but /v1/models is not healthy -> investigate before start"
  else
    log "diffusiongemma: not healthy -> would start ./scripts/run-vllm-diffusiongemma.sh start"
  fi

  if http_ok "$vision_health_url"; then
    log "vision-worker: healthy at ${vision_health_url} -> reuse"
  elif tcp_open "$VISION_HOST" "$VISION_PORT"; then
    log "vision-worker: port ${VISION_HOST}:${VISION_PORT} is open but /healthz is not healthy -> investigate before start"
  else
    log "vision-worker: not healthy -> would start on ${VISION_HOST}:${VISION_PORT}"
  fi

  if tcp_open "$M12_SPEAKER_HOST" "$M12_SPEAKER_PORT"; then
    log "m12 alert speaker: ${M12_SPEAKER_HOST}:${M12_SPEAKER_PORT} open -> reuse"
  else
    log "m12 alert speaker: not listening -> would start ./scripts/run-m12-alert-speaker.sh"
  fi

  if [[ -n "${VISION_CAMERA_URL:-}" ]]; then
    if http_ok "$VISION_CAMERA_URL"; then
      log "camera: reachable at VISION_CAMERA_URL"
    else
      log "camera: WARNING not reachable now (non-fatal; M12 may be away)"
    fi
  else
    log "camera: WARNING VISION_CAMERA_URL is unset"
  fi

  if ((${#missing_required[@]} > 0)); then
    log "check result: action needed before live start"
  else
    log "check result: prerequisites look ready"
  fi
}

if ((CHECK_ONLY)); then
  print_check
  exit 0
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[run-vision-stack] missing env file: $ENV_FILE" >&2
  exit 2
fi
if ((${#missing_required[@]} > 0)); then
  echo "[run-vision-stack] missing required live env keys: ${missing_required[*]}" >&2
  exit 2
fi

mkdir -p "$LOG_DIR"

if http_ok "$vllm_models_url"; then
  log "diffusiongemma reused (${vllm_models_url})"
else
  log "starting diffusiongemma; log=${VLLM_LOG}"
  nohup ./scripts/run-vllm-diffusiongemma.sh start >>"$VLLM_LOG" 2>&1 &
  wait_http "diffusiongemma" "$vllm_models_url" "$VLLM_LOG"
fi

if http_ok "$vision_health_url"; then
  log "vision-worker reused (${vision_health_url})"
else
  log "starting vision-worker; log=${WORKER_LOG}"
  nohup env \
    VISION_HOST="$VISION_HOST" \
    VISION_PORT="$VISION_PORT" \
    VISION_MODEL_BACKEND=diffusiongemma \
    VISION_MODEL_URL="$VISION_MODEL_URL" \
    VISION_OUTPUT_LANG=ja \
    VISION_CORRECTION_TO_MODEL=1 \
    VISION_NARRATE_CHANGES=1 \
    VISION_ALERT_ENABLED=1 \
    VISION_ALERT_WEBHOOK="$VISION_ALERT_WEBHOOK" \
    ./scripts/run-vision-worker.sh >>"$WORKER_LOG" 2>&1 &
  wait_http "vision-worker" "$vision_health_url" "$WORKER_LOG"
fi

if tcp_open "$M12_SPEAKER_HOST" "$M12_SPEAKER_PORT"; then
  log "m12 alert speaker reused (${M12_SPEAKER_HOST}:${M12_SPEAKER_PORT})"
else
  log "starting m12 alert speaker; log=${SPEAKER_LOG}"
  nohup ./scripts/run-m12-alert-speaker.sh >>"$SPEAKER_LOG" 2>&1 &
  wait_tcp "m12 alert speaker" "$M12_SPEAKER_HOST" "$M12_SPEAKER_PORT" "$SPEAKER_LOG"
fi

log "vision stack ready"
log "smoke checklist: GET /healthz, POST /look, confirm no CUDA OOM with face stack, confirm spoken alert reaches M12"
