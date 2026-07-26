#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRESET="${INTERPRETER_PRESET:-gemma4-supertonic}"
INPUT_MODE="api"
FIXTURE=""
EXPECT_SOURCE=""
EXPECT_TARGET=""
INTERPRETER_PORT="${INTERPRETER_SMOKE_PORT:-18766}"
NEMOTRON_PORT="${NEMOTRON_SMOKE_PORT:-18095}"
GEMMA_PORT="${GEMMA4_SMOKE_PORT:-18093}"
SILERO_PORT="${SILERO_SMOKE_PORT:-18094}"
READY_TIMEOUT_SECONDS="${INTERPRETER_SMOKE_READY_TIMEOUT_SECONDS:-180}"
TTS_ENABLED="${MH_INTERPRETER_TTS_ENABLED:-1}"
DRY_RUN=0
STACK_PID=""
STACK_START_TICKS=""
STATE_FILE=""
LOG_FILE=""
RESPONSE_FILE=""
FINAL_STATUS="failed"

usage() {
  cat <<'EOF'
Usage: ./scripts/smoke-interpreter-stack.sh [options]

Start one interpreter preset on dedicated loopback ports, submit one WAV turn
through the HTTP API or firmware-shaped Atom WebSocket frames, and stop only
the stack process created by this command.

Required for a live smoke:
  --fixture PATH          16 kHz, mono, PCM16 WAV
  --expect-source CODE    Expected primary source language, for example es
  --expect-target CODE    Expected primary target language, for example en

Options:
  --preset NAME           gemma4-supertonic | gemma4-qwen3 |
                          nemotron-gemma4-supertonic | nemotron-gemma4-qwen3
  --input MODE            api | atom-replay (default: api)
  --disable-tts           Do not load or dispatch the preset TTS engine
  --port PORT             Interpreter HTTP port (default: 18766)
  --nemotron-port PORT    Nemotron port (default: 18095)
  --gemma-port PORT       Gemma port (default: 18093)
  --silero-port PORT      Silero VAD port (default: 18094)
  --ready-timeout SEC     Health readiness timeout (default: 180)
  --dry-run               Print the isolated launch without starting anything
  -h, --help              Show this help

The atom-replay mode sends 1024-sample PCM16 frames directly to the isolated
interpreter WebSocket; it never connects to Atom hardware. The smoke disables
the supervised Atom HTTP bridge and authentication, binds only to 127.0.0.1,
records the exact parent PID and Linux start ticks, and never stops a process
by port number. Logs and the final response are retained under
.local/state/interpreter/smoke-* for diagnosis.
EOF
}

require_value() {
  if [[ -z "${2:-}" ]]; then
    echo "[smoke-interpreter] $1 requires a value" >&2
    exit 2
  fi
}

require_port() {
  local value="$1"
  local label="$2"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || ((value < 1 || value > 65535)); then
    echo "[smoke-interpreter] invalid ${label}: ${value}" >&2
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
    --input)
      require_value "$1" "${2:-}"
      INPUT_MODE="$2"
      shift 2
      ;;
    --fixture)
      require_value "$1" "${2:-}"
      FIXTURE="$2"
      shift 2
      ;;
    --expect-source)
      require_value "$1" "${2:-}"
      EXPECT_SOURCE="$2"
      shift 2
      ;;
    --expect-target)
      require_value "$1" "${2:-}"
      EXPECT_TARGET="$2"
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
    --disable-tts)
      TTS_ENABLED=0
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
      echo "[smoke-interpreter] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$PRESET" == "light-cloud" ]]; then
  echo "[smoke-interpreter] warning: light-cloud is deprecated; using nemotron-gemma4-supertonic" >&2
  PRESET="nemotron-gemma4-supertonic"
fi

case "$PRESET" in
  gemma4-supertonic|gemma4-qwen3|nemotron-gemma4-supertonic|nemotron-gemma4-qwen3) ;;
  *)
    echo "[smoke-interpreter] unsupported preset: $PRESET" >&2
    exit 2
    ;;
esac

case "$INPUT_MODE" in
  api|atom-replay) ;;
  *)
    echo "[smoke-interpreter] unsupported input mode: $INPUT_MODE" >&2
    exit 2
    ;;
esac

if [[ "$TTS_ENABLED" != "0" && "$TTS_ENABLED" != "1" ]]; then
  echo "[smoke-interpreter] MH_INTERPRETER_TTS_ENABLED must be 0 or 1" >&2
  exit 2
fi

require_port "$INTERPRETER_PORT" "interpreter port"
require_port "$NEMOTRON_PORT" "Nemotron port"
require_port "$GEMMA_PORT" "Gemma port"
require_port "$SILERO_PORT" "Silero port"
if [[ ! "$READY_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || ((READY_TIMEOUT_SECONDS < 1)); then
  echo "[smoke-interpreter] ready timeout must be a positive integer" >&2
  exit 2
fi

if ((DRY_RUN == 1)); then
  echo "[smoke-interpreter] dry-run preset=${PRESET} input=${INPUT_MODE} tts_enabled=${TTS_ENABLED}"
  echo "[smoke-interpreter] fixture=${FIXTURE:-<required-for-live-run>}"
  echo "[smoke-interpreter] expected=${EXPECT_SOURCE:-<source>}->${EXPECT_TARGET:-<target>}"
  echo "[smoke-interpreter] ports: interpreter=${INTERPRETER_PORT} nemotron=${NEMOTRON_PORT} gemma=${GEMMA_PORT} silero=${SILERO_PORT}"
  echo "[dry-run] MH_INTERPRETER_START_ATOM_BRIDGE=0 MH_INTERPRETER_TTS_ENABLED=${TTS_ENABLED} ./scripts/run-interpreter-stack.sh --preset ${PRESET} --host 127.0.0.1 --port ${INTERPRETER_PORT}"
  echo "[dry-run] wait GET http://127.0.0.1:${INTERPRETER_PORT}/healthz"
  if [[ "$INPUT_MODE" == "atom-replay" ]]; then
    echo "[dry-run] node scripts/atom-interpreter-replay.mjs --ws-url ws://127.0.0.1:${INTERPRETER_PORT}/ws and validate ${EXPECT_SOURCE:-source}->${EXPECT_TARGET:-target} endpoint=atom"
  else
    echo "[dry-run] POST one WAV to /api/interpreter/turn and validate ${EXPECT_SOURCE:-source}->${EXPECT_TARGET:-target}"
  fi
  echo "[dry-run] stop only the recorded run-interpreter-stack.sh PID"
  exit 0
fi

if [[ -z "$FIXTURE" || -z "$EXPECT_SOURCE" || -z "$EXPECT_TARGET" ]]; then
  echo "[smoke-interpreter] --fixture, --expect-source, and --expect-target are required" >&2
  exit 2
fi
if [[ ! -f "$FIXTURE" ]]; then
  echo "[smoke-interpreter] fixture not found: $FIXTURE" >&2
  exit 2
fi
if [[ "$EXPECT_SOURCE" == "$EXPECT_TARGET" ]]; then
  echo "[smoke-interpreter] source and target must differ" >&2
  exit 2
fi
command -v curl >/dev/null 2>&1 || {
  echo "[smoke-interpreter] curl is required" >&2
  exit 2
}
command -v node >/dev/null 2>&1 || {
  echo "[smoke-interpreter] node is required" >&2
  exit 2
}
command -v ss >/dev/null 2>&1 || {
  echo "[smoke-interpreter] ss is required for non-destructive port checks" >&2
  exit 2
}

port_is_listening() {
  local port="$1"
  ss -ltnH 2>/dev/null | awk -v port="$port" '
    $4 ~ ("[:.]" port "$") { listening = 1 }
    END { exit(listening ? 0 : 1) }
  '
}

declare -a REQUIRED_PORTS=("$INTERPRETER_PORT" "$SILERO_PORT" "$GEMMA_PORT")
if [[ "$PRESET" == nemotron-* ]]; then
  REQUIRED_PORTS+=("$NEMOTRON_PORT")
fi
for port in "${REQUIRED_PORTS[@]}"; do
  if port_is_listening "$port"; then
    echo "[smoke-interpreter] port ${port} is already in use; no process was stopped" >&2
    exit 2
  fi
done

run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
state_dir="$ROOT_DIR/.local/state/interpreter"
mkdir -p "$state_dir"
STATE_FILE="$state_dir/smoke-${run_id}.json"
LOG_FILE="$state_dir/smoke-${run_id}.log"
RESPONSE_FILE="$state_dir/smoke-${run_id}-response.json"

write_state() {
  local status="$1"
  node -e '
    const fs = require("node:fs");
    const [file, status, preset, inputMode, ttsEnabled, pid, ticks, log, response] = process.argv.slice(1);
    fs.writeFileSync(file, `${JSON.stringify({
      schemaVersion: 1,
      status,
      preset,
      inputMode,
      ttsEnabled: ttsEnabled === "1",
      pid: pid ? Number(pid) : null,
      linuxStartTicks: ticks || null,
      log,
      response,
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`);
  ' "$STATE_FILE" "$status" "$PRESET" "$INPUT_MODE" "$TTS_ENABLED" "$STACK_PID" "$STACK_START_TICKS" "$LOG_FILE" "$RESPONSE_FILE"
}

cleanup() {
  local current_ticks=""
  if [[ -n "$STACK_PID" && -r "/proc/${STACK_PID}/stat" ]]; then
    current_ticks="$(awk '{print $22}' "/proc/${STACK_PID}/stat" 2>/dev/null || true)"
    if [[ "$current_ticks" == "$STACK_START_TICKS" ]] \
      && tr '\0' ' ' <"/proc/${STACK_PID}/cmdline" \
        | grep -E 'run-interpreter-stack\.sh' >/dev/null; then
      kill "$STACK_PID" >/dev/null 2>&1 || true
      for _ in {1..50}; do
        if ! kill -0 "$STACK_PID" 2>/dev/null; then
          break
        fi
        sleep 0.1
      done
      if kill -0 "$STACK_PID" 2>/dev/null; then
        echo "[smoke-interpreter] stack did not exit after SIGTERM; no broader kill was attempted" >&2
      else
        wait "$STACK_PID" 2>/dev/null || true
      fi
    else
      echo "[smoke-interpreter] PID identity changed; refusing to signal ${STACK_PID}" >&2
    fi
  fi
  if [[ -n "$STATE_FILE" ]]; then
    write_state "$FINAL_STATUS" || true
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

echo "[smoke-interpreter] starting isolated preset=${PRESET}"
env \
  INTERPRETER_PRESET="$PRESET" \
  INTERPRETER_HOST=127.0.0.1 \
  INTERPRETER_PORT="$INTERPRETER_PORT" \
  NEMOTRON_ASR_PORT="$NEMOTRON_PORT" \
  GEMMA4_INTERPRETER_PORT="$GEMMA_PORT" \
  INTERPRETER_SILERO_PORT="$SILERO_PORT" \
  MH_INTERPRETER_AUTH_TOKEN= \
  MH_FACE_AUTH_TOKEN= \
  MH_INTERPRETER_START_ATOM_BRIDGE=0 \
  MH_INTERPRETER_TTS_ENABLED="$TTS_ENABLED" \
  ./scripts/run-interpreter-stack.sh \
    --preset "$PRESET" \
    --host 127.0.0.1 \
    --port "$INTERPRETER_PORT" \
    >"$LOG_FILE" 2>&1 &
STACK_PID=$!
STACK_START_TICKS="$(awk '{print $22}' "/proc/${STACK_PID}/stat")"
write_state "starting"
echo "[smoke-interpreter] stack pid=${STACK_PID} log=${LOG_FILE}"

health_url="http://127.0.0.1:${INTERPRETER_PORT}/healthz"
ready=0
for ((attempt = 1; attempt <= READY_TIMEOUT_SECONDS; attempt += 1)); do
  if ! kill -0 "$STACK_PID" 2>/dev/null; then
    echo "[smoke-interpreter] stack exited before becoming ready" >&2
    tail -80 "$LOG_FILE" >&2 || true
    exit 1
  fi
  if curl -fsS --max-time 3 "$health_url" 2>/dev/null \
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
  echo "[smoke-interpreter] readiness timeout after ${READY_TIMEOUT_SECONDS}s" >&2
  tail -80 "$LOG_FILE" >&2 || true
  exit 1
fi
write_state "ready"
echo "[smoke-interpreter] health ok"

if [[ "$INPUT_MODE" == "atom-replay" ]]; then
  node scripts/atom-interpreter-replay.mjs \
    --ws-url "ws://127.0.0.1:${INTERPRETER_PORT}/ws" \
    --fixture "$FIXTURE" \
    --expect-source "$EXPECT_SOURCE" \
    --expect-target "$EXPECT_TARGET" \
    --session-id "smoke-${run_id}" \
    --device-id "device-free-smoke-${run_id}" \
    --output "$RESPONSE_FILE"
else
  turn_id="smoke-${run_id}"
  curl -fsS --max-time 180 \
    -H 'Content-Type: audio/wav' \
    -H "X-Interpreter-Session-Id: smoke-${run_id}" \
    -H "X-Interpreter-Turn-Id: ${turn_id}" \
    --data-binary "@${FIXTURE}" \
    "http://127.0.0.1:${INTERPRETER_PORT}/api/interpreter/turn" \
    >"$RESPONSE_FILE"

  node -e '
    const fs = require("node:fs");
    const [file, source, target] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.ok !== true) throw new Error(`turn failed: ${value?.error ?? "unknown"}`);
    if (value.sourceLanguage !== source) {
      throw new Error(`source mismatch: ${value.sourceLanguage} != ${source}`);
    }
    if (value.targetLanguage !== target) {
      throw new Error(`target mismatch: ${value.targetLanguage} != ${target}`);
    }
    if (typeof value.translation !== "string" || value.translation.trim() === "") {
      throw new Error("translation is empty");
    }
    if (!["queued", "disabled", "unsupported"].includes(value?.tts?.status)) {
      throw new Error(`unexpected TTS status: ${value?.tts?.status}`);
    }
    process.stdout.write(
      `[smoke-interpreter] turn ${value.sourceLanguage}->${value.targetLanguage} tts=${value.tts.status}\n`
    );
  ' "$RESPONSE_FILE" "$EXPECT_SOURCE" "$EXPECT_TARGET"
fi

FINAL_STATUS="passed"
echo "[smoke-interpreter] shutdown clean (cleanup owns pid=${STACK_PID})"
