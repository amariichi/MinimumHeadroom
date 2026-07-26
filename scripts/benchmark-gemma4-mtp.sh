#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRESET="gemma4-supertonic"
CASE_MANIFEST=""
DRAFT_TOKEN_LIST="1,2,4,8,16"
RUNS=3
WARMUP=1
HOST=127.0.0.1
PORT="${GEMMA4_MTP_BENCHMARK_PORT:-18093}"
READY_TIMEOUT_SECONDS="${GEMMA4_MTP_BENCHMARK_READY_TIMEOUT_SECONDS:-300}"
OUTPUT="${GEMMA4_MTP_BENCHMARK_MANIFEST:-$ROOT_DIR/.local/state/interpreter/gemma4-mtp-benchmark.json}"
APPROVE_DRAFT=""
ALLOW_CONTENDED_GPU=0
DRY_RUN=0
SERVER_PID=""
SERVER_START_TICKS=""
RUN_DIR=""
CURRENT_LOG=""
FINAL_STATUS="failed"

usage() {
  cat <<'EOF'
Usage: ./scripts/benchmark-gemma4-mtp.sh [options]

Compare Gemma 4 MTP off with draft limits on one isolated llama-server.
No TTS, Atom bridge, operator process, or model download is started.

Required for a live benchmark:
  --cases FILE            JSON case manifest; see format below

Options:
  --preset NAME           Any of the four local interpreter presets
                           (all benchmark the same Gemma core)
  --draft-tokens LIST     Comma-separated positive integers
                          (default: 1,2,4,8,16)
  --runs N                Measured runs per case (default: 3)
  --warmup N              Warm-up runs per case and mode (default: 1)
  --port PORT             Dedicated loopback llama-server port (default: 18093)
  --ready-timeout SEC     Per-mode startup timeout (default: 300)
  --output FILE           Machine-readable result/auto manifest
  --approve-draft N       After review, set recommended=true only if N is the
                           measured passing candidate
  --allow-contended-gpu   Measure for diagnosis while other GPU compute
                           processes exist; cannot be combined with approval
  --dry-run               Print all launches; do not bind, load, or write
  -h, --help              Show this help

Case manifest:
  {
    "schemaVersion": 1,
    "cases": [
      {
        "id": "es-hola",
        "file": "es-hola-16k-mono.wav",
        "expectedSource": "es",
        "expectedTarget": "en"
      }
    ]
  }

Relative WAV paths are resolved from the case manifest directory. The script
retains per-mode logs/results under .local/state/interpreter/mtp-benchmark-*.
It stops only the exact PID and Linux start ticks that it created. A benchmark
never writes recommended=true automatically; --approve-draft is explicit.
EOF
}

require_value() {
  if [[ -z "${2:-}" ]]; then
    echo "[benchmark-gemma4-mtp] $1 requires a value" >&2
    exit 2
  fi
}

positive_integer() {
  [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 > 0))
}

nonnegative_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

while (($# > 0)); do
  case "$1" in
    --preset)
      require_value "$1" "${2:-}"
      PRESET="$2"
      shift 2
      ;;
    --cases)
      require_value "$1" "${2:-}"
      CASE_MANIFEST="$2"
      shift 2
      ;;
    --draft-tokens)
      require_value "$1" "${2:-}"
      DRAFT_TOKEN_LIST="$2"
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
      PORT="$2"
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
    --approve-draft)
      require_value "$1" "${2:-}"
      APPROVE_DRAFT="$2"
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
      echo "[benchmark-gemma4-mtp] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$PRESET" in
  light-cloud|gemma4-supertonic|gemma4-qwen3|nemotron-gemma4-supertonic|nemotron-gemma4-qwen3) ;;
  *)
    echo "[benchmark-gemma4-mtp] only Gemma presets are valid" >&2
    exit 2
    ;;
esac
positive_integer "$RUNS" || {
  echo "[benchmark-gemma4-mtp] --runs must be positive" >&2
  exit 2
}
nonnegative_integer "$WARMUP" || {
  echo "[benchmark-gemma4-mtp] --warmup must be non-negative" >&2
  exit 2
}
positive_integer "$PORT" && ((10#$PORT <= 65535)) || {
  echo "[benchmark-gemma4-mtp] invalid port: $PORT" >&2
  exit 2
}
positive_integer "$READY_TIMEOUT_SECONDS" || {
  echo "[benchmark-gemma4-mtp] --ready-timeout must be positive" >&2
  exit 2
}
if [[ -n "$APPROVE_DRAFT" ]]; then
  positive_integer "$APPROVE_DRAFT" || {
    echo "[benchmark-gemma4-mtp] --approve-draft must be positive" >&2
    exit 2
  }
fi
if ((ALLOW_CONTENDED_GPU == 1)) && [[ -n "$APPROVE_DRAFT" ]]; then
  echo "[benchmark-gemma4-mtp] a contended GPU result cannot be approved for auto mode" >&2
  exit 2
fi

IFS=',' read -r -a DRAFT_TOKENS <<<"$DRAFT_TOKEN_LIST"
if ((${#DRAFT_TOKENS[@]} == 0)); then
  echo "[benchmark-gemma4-mtp] draft token list is empty" >&2
  exit 2
fi
declare -A SEEN_DRAFTS=()
for token in "${DRAFT_TOKENS[@]}"; do
  positive_integer "$token" || {
    echo "[benchmark-gemma4-mtp] invalid draft token count: $token" >&2
    exit 2
  }
  if [[ -n "${SEEN_DRAFTS[$token]:-}" ]]; then
    echo "[benchmark-gemma4-mtp] duplicate draft token count: $token" >&2
    exit 2
  fi
  SEEN_DRAFTS["$token"]=1
done
if [[ -n "$APPROVE_DRAFT" && -z "${SEEN_DRAFTS[$APPROVE_DRAFT]:-}" ]]; then
  echo "[benchmark-gemma4-mtp] approved draft must be present in --draft-tokens" >&2
  exit 2
fi

if ((DRY_RUN == 1)); then
  echo "[benchmark-gemma4-mtp] dry-run preset=${PRESET}"
  echo "[benchmark-gemma4-mtp] cases=${CASE_MANIFEST:-<required-for-live-run>}"
  echo "[benchmark-gemma4-mtp] modes=off,mtp:${DRAFT_TOKEN_LIST}"
  echo "[benchmark-gemma4-mtp] runs=${RUNS} warmup=${WARMUP} endpoint=http://${HOST}:${PORT}/v1/chat/completions"
  echo "[benchmark-gemma4-mtp] output=${OUTPUT}"
  echo "[benchmark-gemma4-mtp] allow_contended_gpu=${ALLOW_CONTENDED_GPU}"
  for mode in off "${DRAFT_TOKENS[@]}"; do
    if [[ "$mode" == "off" ]]; then
      echo "[dry-run] GEMMA4_MTP=off ./scripts/run-gemma4-interpreter.sh --host ${HOST} --port ${PORT}"
    else
      echo "[dry-run] GEMMA4_MTP=on GEMMA4_INTERPRETER_DRAFT_TOKENS=${mode} ./scripts/run-gemma4-interpreter.sh --host ${HOST} --port ${PORT}"
    fi
  done
  echo "[dry-run] report recommended=false unless --approve-draft matches the measured passing candidate"
  exit 0
fi

if [[ -z "$CASE_MANIFEST" || ! -f "$CASE_MANIFEST" ]]; then
  echo "[benchmark-gemma4-mtp] --cases must name an existing case manifest" >&2
  exit 2
fi
command -v node >/dev/null 2>&1 || {
  echo "[benchmark-gemma4-mtp] node is required" >&2
  exit 2
}
command -v curl >/dev/null 2>&1 || {
  echo "[benchmark-gemma4-mtp] curl is required" >&2
  exit 2
}
command -v ss >/dev/null 2>&1 || {
  echo "[benchmark-gemma4-mtp] ss is required" >&2
  exit 2
}
command -v nvidia-smi >/dev/null 2>&1 || {
  echo "[benchmark-gemma4-mtp] nvidia-smi is required for comparable GPU measurements" >&2
  exit 2
}
existing_gpu_processes="$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || true)"
if [[ -z "$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || true)" ]]; then
  echo "[benchmark-gemma4-mtp] GPU telemetry is unavailable" >&2
  exit 2
fi
if [[ -n "$existing_gpu_processes" && "$ALLOW_CONTENDED_GPU" != "1" ]]; then
  echo "[benchmark-gemma4-mtp] existing GPU compute processes would contaminate the result:" >&2
  printf '%s\n' "$existing_gpu_processes" >&2
  echo "[benchmark-gemma4-mtp] stop known owners first, or use --allow-contended-gpu for a non-approvable diagnostic run" >&2
  exit 2
fi
if ss -ltnH 2>/dev/null | awk '{print $4}' | rg -q "[:.]${PORT}$"; then
  echo "[benchmark-gemma4-mtp] port ${PORT} is in use; no process was stopped" >&2
  exit 2
fi

state_root="$ROOT_DIR/.local/state/interpreter"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="$state_root/mtp-benchmark-${run_id}"
mkdir -p "$RUN_DIR"
environment_file="$RUN_DIR/environment.json"

gpu_json="null"
if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_csv="$(nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || true)"
  if [[ -n "$gpu_csv" ]]; then
    gpu_json="$(node -e '
      const [name, driver, memory] = process.argv.slice(1);
      process.stdout.write(JSON.stringify({
        name: name.trim(),
        driverVersion: driver.trim(),
        memoryTotalMiB: Number(memory.trim())
      }));
    ' "${gpu_csv%%,*}" "$(printf '%s' "$gpu_csv" | awk -F',' '{print $2}')" "$(printf '%s' "$gpu_csv" | awk -F',' '{print $3}')")"
  fi
fi

llama_commit="unknown"
llama_dir="${LLAMA_CPP_DIR:-$(dirname "$ROOT_DIR")/llama.cpp}"
if [[ -d "$llama_dir/.git" ]]; then
  llama_commit="$(git -C "$llama_dir" rev-parse HEAD 2>/dev/null || printf unknown)"
fi
node -e '
  const fs = require("node:fs");
  const [
    file,
    gpu,
    commit,
    cases,
    preset,
    contended,
    preexisting
  ] = process.argv.slice(1);
  const gemma = JSON.parse(fs.readFileSync("config/models/gemma4-interpreter.json", "utf8"));
  fs.writeFileSync(file, `${JSON.stringify({
    schemaVersion: 1,
    gpu: JSON.parse(gpu),
    llamaCpp: { commit },
    model: {
      revision: gemma.runtime.revision,
      mainSha256: gemma.runtime.files.find((item) => item.role === "main").sha256,
      mmprojSha256: gemma.runtime.files.find((item) => item.role === "mmproj").sha256,
      assistantSha256: gemma.assistantGguf.sha256
    },
    caseManifest: cases,
    preset,
    contendedGpuAllowed: contended === "1",
    preexistingGpuProcesses: preexisting
      ? preexisting.split("\n")
      : [],
    createdAt: new Date().toISOString()
  }, null, 2)}\n`);
' "$environment_file" "$gpu_json" "$llama_commit" "$(realpath "$CASE_MANIFEST")" "$PRESET" "$ALLOW_CONTENDED_GPU" "$existing_gpu_processes"

current_gpu_used() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null \
      | head -1 \
      | awk '{print $1}'
  fi
}

stop_server() {
  local current_ticks=""
  if [[ -z "$SERVER_PID" || ! -r "/proc/${SERVER_PID}/stat" ]]; then
    SERVER_PID=""
    SERVER_START_TICKS=""
    return
  fi
  current_ticks="$(awk '{print $22}' "/proc/${SERVER_PID}/stat" 2>/dev/null || true)"
  if [[ "$current_ticks" != "$SERVER_START_TICKS" ]]; then
    echo "[benchmark-gemma4-mtp] PID identity changed; refusing to signal ${SERVER_PID}" >&2
    return
  fi
  if ! tr '\0' ' ' <"/proc/${SERVER_PID}/cmdline" \
    | rg -q '(llama-server|run-gemma4-interpreter\.sh)'; then
    echo "[benchmark-gemma4-mtp] PID command changed; refusing to signal ${SERVER_PID}" >&2
    return
  fi
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  for _ in {1..100}; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[benchmark-gemma4-mtp] server did not exit after SIGTERM; no broader kill was attempted" >&2
  else
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
  SERVER_START_TICKS=""
}

cleanup() {
  stop_server
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

run_mode() {
  local mode="$1"
  local draft_tokens="$2"
  local result_name="$3"
  local result_file="$RUN_DIR/${result_name}.json"
  CURRENT_LOG="$RUN_DIR/${result_name}.log"
  local before_used
  local loaded_used
  local after_used
  before_used="$(current_gpu_used || true)"

  echo "[benchmark-gemma4-mtp] starting ${result_name}"
  if [[ "$mode" == "off" ]]; then
    env GEMMA4_MTP=off \
      ./scripts/run-gemma4-interpreter.sh --host "$HOST" --port "$PORT" \
      >"$CURRENT_LOG" 2>&1 &
  else
    env GEMMA4_MTP=on GEMMA4_INTERPRETER_DRAFT_TOKENS="$draft_tokens" \
      ./scripts/run-gemma4-interpreter.sh --host "$HOST" --port "$PORT" \
      >"$CURRENT_LOG" 2>&1 &
  fi
  SERVER_PID=$!
  SERVER_START_TICKS="$(awk '{print $22}' "/proc/${SERVER_PID}/stat")"

  local ready=0
  for ((attempt = 1; attempt <= READY_TIMEOUT_SECONDS; attempt += 1)); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "[benchmark-gemma4-mtp] ${result_name} exited before ready" >&2
      tail -80 "$CURRENT_LOG" >&2 || true
      return 1
    fi
    if curl -fsS --max-time 3 "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if ((ready != 1)); then
    echo "[benchmark-gemma4-mtp] ${result_name} readiness timeout" >&2
    tail -80 "$CURRENT_LOG" >&2 || true
    return 1
  fi
  loaded_used="$(current_gpu_used || true)"

  node scripts/gemma4-mtp-benchmark.mjs run \
    --endpoint "http://${HOST}:${PORT}/v1/chat/completions" \
    --cases "$CASE_MANIFEST" \
    --output "$result_file" \
    --mode "$mode" \
    --draft-tokens "$draft_tokens" \
    --runs "$RUNS" \
    --warmup "$WARMUP"
  after_used="$(current_gpu_used || true)"
  node -e '
    const fs = require("node:fs");
    const [file, before, loaded, after] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.gpuMemoryMiB = {
      before: before ? Number(before) : null,
      loaded: loaded ? Number(loaded) : null,
      afterTurns: after ? Number(after) : null,
      loadedDelta: before && loaded ? Number(loaded) - Number(before) : null,
      postTurnDelta: before && after ? Number(after) - Number(before) : null
    };
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  ' "$result_file" "$before_used" "$loaded_used" "$after_used"
  stop_server
}

run_mode off 0 off
for token in "${DRAFT_TOKENS[@]}"; do
  run_mode mtp "$token" "mtp-${token}"
done

report_args=(
  report
  --input "$RUN_DIR"
  --environment "$environment_file"
  --output "$OUTPUT"
)
if [[ -n "$APPROVE_DRAFT" ]]; then
  report_args+=(--approve-draft "$APPROVE_DRAFT")
fi
mkdir -p "$(dirname "$OUTPUT")"
node scripts/gemma4-mtp-benchmark.mjs "${report_args[@]}"
FINAL_STATUS="passed"
echo "[benchmark-gemma4-mtp] report=${OUTPUT}"
echo "[benchmark-gemma4-mtp] evidence=${RUN_DIR}"
