#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CASE_MANIFEST=""
PRESET_LIST="nemotron-gemma4-supertonic,gemma4-supertonic"
GEMMA_MTP_LIST="off,on"
GEMMA_DRAFT_TOKENS="${GEMMA4_INTERPRETER_DRAFT_TOKENS:-8}"
RUNS=1
WARMUP=1
INTERPRETER_PORT="${INTERPRETER_CORPUS_PORT:-18766}"
NEMOTRON_PORT="${NEMOTRON_CORPUS_PORT:-18095}"
GEMMA_PORT="${GEMMA4_CORPUS_PORT:-18093}"
SILERO_PORT="${SILERO_CORPUS_PORT:-18094}"
READY_TIMEOUT_SECONDS="${INTERPRETER_CORPUS_READY_TIMEOUT_SECONDS:-300}"
OUTPUT="${INTERPRETER_CORPUS_REPORT:-$ROOT_DIR/.local/state/interpreter/interpreter-corpus-benchmark.json}"
ALLOW_CONTENDED_GPU=0
DRY_RUN=0
STACK_PID=""
STACK_START_TICKS=""
RUN_DIR=""
CURRENT_LOG=""
FINAL_STATUS="failed"

usage() {
  cat <<'EOF'
Usage: ./scripts/benchmark-interpreter-corpus.sh [options]

Run one fixed WAV corpus through isolated interpreter stacks. TTS and the Atom
bridge are disabled so ASR, intent, translation, direction, and API latency are
measured without asynchronous synthesis or playback.

Required for a live benchmark:
  --cases FILE            Generated corpus manifest

Options:
  --presets LIST          Comma-separated interpreter presets
                          (default: nemotron-gemma4-supertonic,gemma4-supertonic)
  --gemma-mtp LIST        off,on or one of those values (default: off,on)
  --gemma-draft-tokens N  Draft limit when MTP is on (default: 8)
  --runs N                Measured passes over all cases (default: 1)
  --warmup N              Unmeasured passes over all cases (default: 1)
  --port PORT             Dedicated interpreter port (default: 18766)
  --nemotron-port PORT    Dedicated Nemotron port (default: 18095)
  --gemma-port PORT       Dedicated Gemma port (default: 18093)
  --silero-port PORT      Dedicated Silero port (default: 18094)
  --ready-timeout SEC     Per-configuration startup timeout (default: 300)
  --output FILE           Aggregate machine-readable report
  --allow-contended-gpu   Diagnostic run only; records existing GPU processes
  --dry-run               Print configurations without starting or writing
  -h, --help              Show this help

The launcher binds only to 127.0.0.1 and stops only its recorded
run-interpreter-stack.sh PID after validating Linux start ticks and command
identity. It never stops a process by port number.
EOF
}

require_value() {
  if [[ -z "${2:-}" ]]; then
    echo "[benchmark-interpreter-corpus] $1 requires a value" >&2
    exit 2
  fi
}

positive_integer() {
  [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 > 0))
}

nonnegative_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

valid_port() {
  positive_integer "$1" && ((10#$1 <= 65535))
}

while (($# > 0)); do
  case "$1" in
    --cases)
      require_value "$1" "${2:-}"
      CASE_MANIFEST="$2"
      shift 2
      ;;
    --presets)
      require_value "$1" "${2:-}"
      PRESET_LIST="$2"
      shift 2
      ;;
    --gemma-mtp)
      require_value "$1" "${2:-}"
      GEMMA_MTP_LIST="$2"
      shift 2
      ;;
    --gemma-draft-tokens)
      require_value "$1" "${2:-}"
      GEMMA_DRAFT_TOKENS="$2"
      shift 2
      ;;
    --runs)
      require_value "$1" "${2:-}"
      RUNS="$2"
      shift 2
      ;;
    --warmup)
      require_value "$1" "${2:-}"
      WARMUP="$2"
      shift 2
      ;;
    --port)
      require_value "$1" "${2:-}"
      INTERPRETER_PORT="$2"
      shift 2
      ;;
    --nemotron-port)
      require_value "$1" "${2:-}"
      NEMOTRON_PORT="$2"
      shift 2
      ;;
    --gemma-port)
      require_value "$1" "${2:-}"
      GEMMA_PORT="$2"
      shift 2
      ;;
    --silero-port)
      require_value "$1" "${2:-}"
      SILERO_PORT="$2"
      shift 2
      ;;
    --ready-timeout)
      require_value "$1" "${2:-}"
      READY_TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --output)
      require_value "$1" "${2:-}"
      OUTPUT="$2"
      shift 2
      ;;
    --allow-contended-gpu)
      ALLOW_CONTENDED_GPU=1
      shift
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
      echo "[benchmark-interpreter-corpus] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

positive_integer "$RUNS" || {
  echo "[benchmark-interpreter-corpus] --runs must be positive" >&2
  exit 2
}
nonnegative_integer "$WARMUP" || {
  echo "[benchmark-interpreter-corpus] --warmup must be non-negative" >&2
  exit 2
}
positive_integer "$GEMMA_DRAFT_TOKENS" || {
  echo "[benchmark-interpreter-corpus] --gemma-draft-tokens must be positive" >&2
  exit 2
}
positive_integer "$READY_TIMEOUT_SECONDS" || {
  echo "[benchmark-interpreter-corpus] --ready-timeout must be positive" >&2
  exit 2
}
for port in "$INTERPRETER_PORT" "$NEMOTRON_PORT" "$GEMMA_PORT" "$SILERO_PORT"; do
  valid_port "$port" || {
    echo "[benchmark-interpreter-corpus] invalid port: $port" >&2
    exit 2
  }
done

IFS=',' read -r -a PRESETS <<<"$PRESET_LIST"
if ((${#PRESETS[@]} == 0)); then
  echo "[benchmark-interpreter-corpus] preset list is empty" >&2
  exit 2
fi
declare -A SEEN_PRESETS=()
for preset in "${PRESETS[@]}"; do
  if [[ "$preset" == "light-cloud" ]]; then
    echo "[benchmark-interpreter-corpus] warning: light-cloud is deprecated; use nemotron-gemma4-supertonic" >&2
  fi
  case "$preset" in
    light-cloud|gemma4-supertonic|gemma4-qwen3|nemotron-gemma4-supertonic|nemotron-gemma4-qwen3) ;;
    *)
      echo "[benchmark-interpreter-corpus] unsupported preset: $preset" >&2
      exit 2
      ;;
  esac
  if [[ -n "${SEEN_PRESETS[$preset]:-}" ]]; then
    echo "[benchmark-interpreter-corpus] duplicate preset: $preset" >&2
    exit 2
  fi
  SEEN_PRESETS["$preset"]=1
done

IFS=',' read -r -a GEMMA_MTP_MODES <<<"$GEMMA_MTP_LIST"
if ((${#GEMMA_MTP_MODES[@]} == 0)); then
  echo "[benchmark-interpreter-corpus] Gemma MTP mode list is empty" >&2
  exit 2
fi
declare -A SEEN_MTP_MODES=()
for mtp_mode in "${GEMMA_MTP_MODES[@]}"; do
  case "$mtp_mode" in
    off|on) ;;
    *)
      echo "[benchmark-interpreter-corpus] unsupported MTP mode: $mtp_mode" >&2
      exit 2
      ;;
  esac
  if [[ -n "${SEEN_MTP_MODES[$mtp_mode]:-}" ]]; then
    echo "[benchmark-interpreter-corpus] duplicate MTP mode: $mtp_mode" >&2
    exit 2
  fi
  SEEN_MTP_MODES["$mtp_mode"]=1
done

declare -a CONFIG_PRESETS=()
declare -a CONFIG_MTP=()
declare -a CONFIG_LABELS=()
for preset in "${PRESETS[@]}"; do
  for mtp_mode in "${GEMMA_MTP_MODES[@]}"; do
    CONFIG_PRESETS+=("$preset")
    CONFIG_MTP+=("$mtp_mode")
    if [[ "$mtp_mode" == "on" ]]; then
      CONFIG_LABELS+=("${preset}-mtp-on-draft-${GEMMA_DRAFT_TOKENS}")
    else
      CONFIG_LABELS+=("${preset}-mtp-off")
    fi
  done
done

if ((DRY_RUN == 1)); then
  echo "[benchmark-interpreter-corpus] dry-run cases=${CASE_MANIFEST:-<required-for-live-run>}"
  echo "[benchmark-interpreter-corpus] runs=${RUNS} warmup=${WARMUP}"
  echo "[benchmark-interpreter-corpus] ports: interpreter=${INTERPRETER_PORT} nemotron=${NEMOTRON_PORT} gemma=${GEMMA_PORT} silero=${SILERO_PORT}"
  echo "[benchmark-interpreter-corpus] output=${OUTPUT}"
  for index in "${!CONFIG_LABELS[@]}"; do
    echo "[dry-run] config=${CONFIG_LABELS[$index]} preset=${CONFIG_PRESETS[$index]} GEMMA4_MTP=${CONFIG_MTP[$index]} MH_INTERPRETER_TTS_ENABLED=0 MH_INTERPRETER_START_ATOM_BRIDGE=0"
  done
  echo "[dry-run] bind 127.0.0.1, record exact parent PID/start ticks, stop only that stack"
  exit 0
fi

if [[ -z "$CASE_MANIFEST" || ! -f "$CASE_MANIFEST" ]]; then
  echo "[benchmark-interpreter-corpus] --cases must name an existing manifest" >&2
  exit 2
fi
for command in node curl ss nvidia-smi; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "[benchmark-interpreter-corpus] required command is missing: $command" >&2
    exit 2
  }
done

port_is_listening() {
  local port="$1"
  ss -ltnH 2>/dev/null | awk '{print $4}' | rg -q "[:.]${port}$"
}

for port in "$INTERPRETER_PORT" "$NEMOTRON_PORT" "$GEMMA_PORT" "$SILERO_PORT"; do
  if port_is_listening "$port"; then
    echo "[benchmark-interpreter-corpus] port ${port} is in use; no process was stopped" >&2
    exit 2
  fi
done

existing_gpu_processes="$(
  nvidia-smi \
    --query-compute-apps=pid,process_name,used_memory \
    --format=csv,noheader,nounits 2>/dev/null || true
)"
gpu_csv="$(
  nvidia-smi \
    --query-gpu=name,driver_version,memory.total \
    --format=csv,noheader,nounits 2>/dev/null \
    | head -1 || true
)"
if [[ -z "$gpu_csv" ]]; then
  echo "[benchmark-interpreter-corpus] GPU telemetry is unavailable" >&2
  exit 2
fi
if [[ -n "$existing_gpu_processes" && "$ALLOW_CONTENDED_GPU" != "1" ]]; then
  echo "[benchmark-interpreter-corpus] existing GPU compute processes would contaminate the result:" >&2
  printf '%s\n' "$existing_gpu_processes" >&2
  echo "[benchmark-interpreter-corpus] stop known owners first, or use --allow-contended-gpu for diagnosis" >&2
  exit 2
fi

state_root="$ROOT_DIR/.local/state/interpreter"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="$state_root/corpus-benchmark-${run_id}"
mkdir -p "$RUN_DIR"
environment_file="$RUN_DIR/environment.json"

IFS=',' read -r gpu_name gpu_driver gpu_total <<<"$gpu_csv"
llama_commit="unknown"
llama_dir="${LLAMA_CPP_DIR:-$(dirname "$ROOT_DIR")/llama.cpp}"
if [[ -d "$llama_dir/.git" ]]; then
  llama_commit="$(
    git -C "$llama_dir" rev-parse HEAD 2>/dev/null || printf unknown
  )"
fi
node -e '
  const fs = require("node:fs");
  const [
    output,
    gpuName,
    gpuDriver,
    gpuTotal,
    llamaCommit,
    cases,
    contended,
    preexisting
  ] = process.argv.slice(1);
  fs.writeFileSync(output, `${JSON.stringify({
    schemaVersion: 1,
    gpu: {
      name: gpuName.trim(),
      driverVersion: gpuDriver.trim(),
      memoryTotalMiB: Number(gpuTotal.trim())
    },
    llamaCpp: { commit: llamaCommit },
    caseManifest: fs.realpathSync(cases),
    contendedGpuAllowed: contended === "1",
    preexistingGpuProcesses: preexisting ? preexisting.split("\n") : [],
    ttsEnabled: false,
    atomBridgeEnabled: false,
    createdAt: new Date().toISOString()
  }, null, 2)}\n`);
' \
  "$environment_file" \
  "$gpu_name" \
  "$gpu_driver" \
  "$gpu_total" \
  "$llama_commit" \
  "$CASE_MANIFEST" \
  "$ALLOW_CONTENDED_GPU" \
  "$existing_gpu_processes"

current_gpu_used() {
  nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null \
    | head -1 \
    | awk '{print $1}'
}

stop_stack() {
  local current_ticks=""
  if [[ -z "$STACK_PID" || ! -r "/proc/${STACK_PID}/stat" ]]; then
    STACK_PID=""
    STACK_START_TICKS=""
    return
  fi
  current_ticks="$(awk '{print $22}' "/proc/${STACK_PID}/stat" 2>/dev/null || true)"
  if [[ "$current_ticks" != "$STACK_START_TICKS" ]]; then
    echo "[benchmark-interpreter-corpus] PID identity changed; refusing to signal ${STACK_PID}" >&2
    return 1
  fi
  if ! tr '\0' ' ' <"/proc/${STACK_PID}/cmdline" \
    | rg -q 'run-interpreter-stack\.sh'; then
    echo "[benchmark-interpreter-corpus] PID command changed; refusing to signal ${STACK_PID}" >&2
    return 1
  fi
  kill "$STACK_PID" >/dev/null 2>&1 || true
  for _ in {1..100}; do
    if ! kill -0 "$STACK_PID" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if kill -0 "$STACK_PID" 2>/dev/null; then
    echo "[benchmark-interpreter-corpus] stack did not exit after SIGTERM; no broader kill was attempted" >&2
    return 1
  fi
  wait "$STACK_PID" 2>/dev/null || true
  STACK_PID=""
  STACK_START_TICKS=""
}

cleanup() {
  stop_stack || true
  if [[ -n "$RUN_DIR" ]]; then
    node -e '
      const fs = require("node:fs");
      const [file, status] = process.argv.slice(1);
      fs.writeFileSync(file, `${JSON.stringify({
        schemaVersion: 1,
        status,
        updatedAt: new Date().toISOString()
      }, null, 2)}\n`);
    ' "$RUN_DIR/status.json" "$FINAL_STATUS" 2>/dev/null || true
  fi
}
on_interrupt() {
  FINAL_STATUS="interrupted"
  exit 130
}
on_terminate() {
  FINAL_STATUS="terminated"
  exit 143
}
trap cleanup EXIT
trap on_interrupt INT
trap on_terminate TERM

run_configuration() {
  local preset="$1"
  local mtp_mode="$2"
  local label="$3"
  local result_file="$RUN_DIR/${label}.json"
  CURRENT_LOG="$RUN_DIR/${label}.log"
  local gpu_before
  local gpu_loaded
  local gpu_after
  local started_ms
  local ready_ms
  local cold_start_ms

  gpu_before="$(current_gpu_used || true)"
  started_ms="$(date +%s%3N)"
  echo "[benchmark-interpreter-corpus] starting ${label}"
  env \
    INTERPRETER_PRESET="$preset" \
    INTERPRETER_HOST=127.0.0.1 \
    INTERPRETER_PORT="$INTERPRETER_PORT" \
    NEMOTRON_ASR_PORT="$NEMOTRON_PORT" \
    GEMMA4_INTERPRETER_PORT="$GEMMA_PORT" \
    INTERPRETER_SILERO_PORT="$SILERO_PORT" \
    MH_INTERPRETER_AUTH_TOKEN= \
    MH_FACE_AUTH_TOKEN= \
    MH_INTERPRETER_START_ATOM_BRIDGE=0 \
    MH_INTERPRETER_TTS_ENABLED=0 \
    GEMMA4_MTP="$mtp_mode" \
    GEMMA4_INTERPRETER_DRAFT_TOKENS="$GEMMA_DRAFT_TOKENS" \
    ./scripts/run-interpreter-stack.sh \
      --preset "$preset" \
      --host 127.0.0.1 \
      --port "$INTERPRETER_PORT" \
      >"$CURRENT_LOG" 2>&1 &
  STACK_PID=$!
  STACK_START_TICKS="$(awk '{print $22}' "/proc/${STACK_PID}/stat")"

  local ready=0
  for ((attempt = 1; attempt <= READY_TIMEOUT_SECONDS; attempt += 1)); do
    if ! kill -0 "$STACK_PID" 2>/dev/null; then
      echo "[benchmark-interpreter-corpus] ${label} exited before ready" >&2
      tail -100 "$CURRENT_LOG" >&2 || true
      return 1
    fi
    if curl -fsS --max-time 3 \
      "http://127.0.0.1:${INTERPRETER_PORT}/healthz" \
      | node -e '
          let raw = "";
          process.stdin.on("data", (chunk) => { raw += chunk; });
          process.stdin.on("end", () => {
            try {
              const value = JSON.parse(raw);
              process.exit(value?.ok === true ? 0 : 1);
            } catch {
              process.exit(1);
            }
          });
        '; then
      ready=1
      break
    fi
    sleep 1
  done
  if ((ready != 1)); then
    echo "[benchmark-interpreter-corpus] ${label} readiness timeout" >&2
    tail -100 "$CURRENT_LOG" >&2 || true
    return 1
  fi
  ready_ms="$(date +%s%3N)"
  cold_start_ms=$((ready_ms - started_ms))
  gpu_loaded="$(current_gpu_used || true)"

  node scripts/interpreter-corpus-benchmark.mjs run \
    --endpoint "http://127.0.0.1:${INTERPRETER_PORT}/api/interpreter/turn" \
    --cases "$CASE_MANIFEST" \
    --output "$result_file" \
    --config "$label" \
    --preset "$preset" \
    --mtp "$mtp_mode" \
    --draft-tokens "$GEMMA_DRAFT_TOKENS" \
    --runs "$RUNS" \
    --warmup "$WARMUP"
  gpu_after="$(current_gpu_used || true)"
  node scripts/interpreter-corpus-benchmark.mjs annotate \
    --input "$result_file" \
    --cold-start-ms "$cold_start_ms" \
    --gpu-before "$gpu_before" \
    --gpu-loaded "$gpu_loaded" \
    --gpu-after "$gpu_after" \
    --log "$CURRENT_LOG"
  stop_stack

  if [[ "$ALLOW_CONTENDED_GPU" != "1" ]]; then
    local residual=""
    for _ in {1..50}; do
      residual="$(
        nvidia-smi \
          --query-compute-apps=pid,process_name,used_memory \
          --format=csv,noheader,nounits 2>/dev/null || true
      )"
      if [[ -z "$residual" ]]; then
        break
      fi
      sleep 0.1
    done
    if [[ -n "$residual" ]]; then
      echo "[benchmark-interpreter-corpus] GPU process remained after ${label}:" >&2
      printf '%s\n' "$residual" >&2
      return 1
    fi
  fi
}

for index in "${!CONFIG_LABELS[@]}"; do
  run_configuration \
    "${CONFIG_PRESETS[$index]}" \
    "${CONFIG_MTP[$index]}" \
    "${CONFIG_LABELS[$index]}"
done

mkdir -p "$(dirname "$OUTPUT")"
node scripts/interpreter-corpus-benchmark.mjs report \
  --input "$RUN_DIR" \
  --environment "$environment_file" \
  --output "$OUTPUT"
FINAL_STATUS="passed"
echo "[benchmark-interpreter-corpus] report=${OUTPUT}"
echo "[benchmark-interpreter-corpus] evidence=${RUN_DIR}"
