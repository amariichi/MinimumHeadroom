#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRESET="${INTERPRETER_PRESET:-gemma4-supertonic}"
LLAMA_DIR="${LLAMA_CPP_DIR:-$(dirname "$ROOT_DIR")/llama.cpp}"
MODEL_DIR="${GEMMA4_MODEL_DIR:-$HOME/models/google/gemma-4-12B-it-qat-q4_0-gguf}"
NEMOTRON_CACHE="${NEMOTRON_ASR_CACHE_DIR:-$ROOT_DIR/.cache/huggingface}"
NEMOTRON_VENV="${NEMOTRON_ASR_VENV:-$ROOT_DIR/.venv-nemotron-asr}"
SUPERTONIC_CACHE="${SUPERTONIC_CACHE_DIR:-$HOME/.cache/supertonic3}"
SUPERTONIC_VENV="${SUPERTONIC_VENV:-$ROOT_DIR/.venv-supertonic}"
QWEN_CACHE="${QWEN3_TTS_HF_HOME:-${HF_HOME:-$HOME/.cache/huggingface}}"
QWEN_VENV="${QWEN3_TTS_VENV:-$ROOT_DIR/.venv-qwen-tts}"
MTP_MODE="${GEMMA4_MTP:-off}"
ATOM_TTS_CODEC="${MH_ATOM_TTS_CODEC:-auto}"
FFMPEG_COMMAND="${MH_INTERPRETER_FFMPEG_COMMAND:-ffmpeg}"
NO_HASH=0
FAILURES=0
WARNINGS=0

NEMOTRON_REVISION="f3d333391852ba876df169dcc9ba902d25b6ab0b"
QWEN_REVISION="85e237c12c027371202489a0ec509ded67b5e4b5"
MAIN_NAME="gemma-4-12b-it-qat-q4_0.gguf"
MMPROJ_NAME="mmproj-gemma-4-12b-it-qat-q4_0.gguf"
MTP_NAME="mtp-gemma-4-12B-it-qat-Q4_0.gguf"
MAIN_SHA="93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b"
MMPROJ_SHA="cb018338a7538a9814d994bfe54644c71eb7ed54e31eae2f721e45fd3c260da7"
MTP_SHA="25f143b4c15b20cd04216e35e99bd7a56afc6f65e7a4e090a3e20091bb590cbb"

usage() {
  cat <<'EOF'
Usage: ./scripts/interpreter-doctor.sh --preset NAME [options]

Read-only prerequisite check. It never starts a model or downloads a file.

Options:
  --preset NAME       gemma4-supertonic | gemma4-qwen3 |
                      nemotron-gemma4-supertonic | nemotron-gemma4-qwen3
  --llama-dir PATH    Existing llama.cpp checkout
  --model-dir PATH    Gemma runtime GGUF directory
  --no-hash           Check file presence/size without hashing large GGUFs
  -h, --help          Show this help

GEMMA4_MTP=off checks audio runtime only. on additionally checks the assistant
artifact and MTP server flags. auto is treated as off unless an approved local
benchmark manifest recommends MTP.
EOF
}

while (($# > 0)); do
  case "$1" in
    --preset)
      [[ -n "${2:-}" ]] || { echo "[interpreter-doctor] --preset requires a value" >&2; exit 2; }
      PRESET="$2"
      shift 2
      ;;
    --llama-dir)
      [[ -n "${2:-}" ]] || { echo "[interpreter-doctor] --llama-dir requires a value" >&2; exit 2; }
      LLAMA_DIR="$2"
      shift 2
      ;;
    --model-dir)
      [[ -n "${2:-}" ]] || { echo "[interpreter-doctor] --model-dir requires a value" >&2; exit 2; }
      MODEL_DIR="$2"
      shift 2
      ;;
    --no-hash)
      NO_HASH=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[interpreter-doctor] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$PRESET" == "light-cloud" ]]; then
  echo "[interpreter-doctor] warning: light-cloud is deprecated; using nemotron-gemma4-supertonic" >&2
  PRESET="nemotron-gemma4-supertonic"
fi

case "$PRESET" in
  gemma4-supertonic|gemma4-qwen3|nemotron-gemma4-supertonic|nemotron-gemma4-qwen3) ;;
  *)
    echo "[interpreter-doctor] unsupported preset: $PRESET" >&2
    exit 2
    ;;
esac
case "${MTP_MODE,,}" in
  off|on|auto) ;;
  *)
    echo "[interpreter-doctor] GEMMA4_MTP must be off, on, or auto" >&2
    exit 2
    ;;
esac
case "${ATOM_TTS_CODEC,,}" in
  auto|pcm16|ima_adpcm) ;;
  *)
    echo "[interpreter-doctor] MH_ATOM_TTS_CODEC must be auto, pcm16, or ima_adpcm" >&2
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

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "command: $1"
  else
    fail "missing command: $1"
  fi
}

check_executable() {
  if [[ -x "$1" ]]; then
    ok "executable: $1"
  else
    fail "missing executable: $1"
  fi
}

check_file() {
  local path="$1"
  local expected_sha="$2"
  local label="$3"
  if [[ ! -f "$path" ]]; then
    fail "${label} missing: ${path}"
    return
  fi
  if ((NO_HASH == 1)); then
    ok "${label} present: ${path} ($(stat -c %s "$path") bytes; hash skipped)"
    return
  fi
  local actual_sha
  actual_sha="$(sha256sum "$path" | awk '{print $1}')"
  if [[ "$actual_sha" == "$expected_sha" ]]; then
    ok "${label} SHA256 verified"
  else
    fail "${label} SHA256 mismatch: ${actual_sha}"
  fi
}

package_version() {
  local python_bin="$1"
  local package_name="$2"
  "$python_bin" - "$package_name" <<'PY' 2>/dev/null
from importlib.metadata import version
import sys
print(version(sys.argv[1]))
PY
}

check_port() {
  local port="$1"
  local label="$2"
  if command -v ss >/dev/null 2>&1 && ss -ltnH 2>/dev/null | awk '{print $4}' | rg -q "[:.]${port}$"; then
    warn "${label} port ${port} is already listening; no process will be killed"
  else
    ok "${label} port ${port} is available"
  fi
}

check_browser_mp3_encoder() {
  if ! command -v "$FFMPEG_COMMAND" >/dev/null 2>&1; then
    warn "browser TTS MP3 encoder is unavailable (${FFMPEG_COMMAND}); runtime will fall back to PCM16"
    return
  fi
  local encoder_list
  encoder_list="$("$FFMPEG_COMMAND" -hide_banner -encoders 2>/dev/null || true)"
  if rg -q '^[[:space:]]*A[^[:space:]]*[[:space:]]+libmp3lame[[:space:]]' <<<"$encoder_list"; then
    ok "browser TTS MP3 encoder: ${FFMPEG_COMMAND} libmp3lame 128 kbit/s"
  else
    warn "browser TTS MP3 encoder lacks libmp3lame; runtime will fall back to PCM16"
  fi
}

echo "[interpreter-doctor] preset=${PRESET} mtp_mode=${MTP_MODE,,} read_only=true"
ok "Atom TTS codec mode: ${ATOM_TTS_CODEC,,}"
require_command node
require_command uv
check_browser_mp3_encoder
check_executable "$ROOT_DIR/scripts/run-interpreter-stack.sh"
if [[ -f "$ROOT_DIR/silero-vad-worker/pyproject.toml" ]]; then
  ok "Silero VAD project is present"
else
  fail "Silero VAD project is missing"
fi

effective_mtp=off
if [[ "${MTP_MODE,,}" == "on" ]]; then
  effective_mtp=on
elif [[ "${MTP_MODE,,}" == "auto" ]]; then
  benchmark_manifest="${GEMMA4_MTP_BENCHMARK_MANIFEST:-$ROOT_DIR/.local/state/interpreter/gemma4-mtp-benchmark.json}"
  gpu_name="${GEMMA4_MTP_GPU_NAME:-}"
  gpu_memory="${GEMMA4_MTP_GPU_MEMORY_TOTAL_MIB:-}"
  if [[ -z "$gpu_name" || -z "$gpu_memory" ]] \
    && command -v nvidia-smi >/dev/null 2>&1; then
    gpu_line="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || true)"
    if [[ "$gpu_line" =~ ^.+,[[:space:]]*[0-9]+$ ]]; then
      gpu_name="${gpu_line%,*}"
      gpu_memory="${gpu_line##*,}"
    fi
  fi
  llama_commit="${GEMMA4_MTP_LLAMA_COMMIT:-}"
  if [[ -z "$llama_commit" && -d "$LLAMA_DIR/.git" ]]; then
    llama_commit="$(git -C "$LLAMA_DIR" rev-parse HEAD 2>/dev/null || true)"
  fi
  if [[ -f "$benchmark_manifest" ]] \
    && approved_draft="$(node scripts/validate-gemma4-mtp-benchmark.mjs \
      --manifest "$benchmark_manifest" \
      --gpu-name "$gpu_name" \
      --gpu-memory-mib "$gpu_memory" \
      --llama-commit "$llama_commit" 2>/dev/null)"; then
    effective_mtp=on
    ok "MTP auto has a matching approved benchmark manifest (draft=${approved_draft})"
  else
    ok "MTP auto resolves off without a matching approved benchmark manifest"
  fi
fi

NEEDS_NEMOTRON=0
TTS_OWNER=""
case "$PRESET" in
  gemma4-supertonic)
    TTS_OWNER="supertonic"
    ;;
  gemma4-qwen3)
    TTS_OWNER="qwen3"
    ;;
  nemotron-gemma4-supertonic)
    NEEDS_NEMOTRON=1
    TTS_OWNER="supertonic"
    ;;
  nemotron-gemma4-qwen3)
    NEEDS_NEMOTRON=1
    TTS_OWNER="qwen3"
    ;;
esac

if ((NEEDS_NEMOTRON == 1)); then
  check_executable "$NEMOTRON_VENV/bin/python"
  if [[ -x "$NEMOTRON_VENV/bin/python" ]]; then
    for package_spec in \
      "minimum-headroom-interpreter-asr-worker:0.1.0" \
      "transformers:5.13.1" \
      "torch:2.10.0" \
      "librosa:0.11.0" \
      "numpy:2.4.6"; do
      package_name="${package_spec%%:*}"
      expected_version="${package_spec##*:}"
      version="$(package_version "$NEMOTRON_VENV/bin/python" "$package_name" || true)"
      if [[ "$version" == "$expected_version" ]]; then
        ok "${package_name} package=${expected_version}"
      else
        fail "${package_name} package version is ${version:-unavailable}, expected ${expected_version}"
      fi
    done
    if "$NEMOTRON_VENV/bin/python" -c 'import librosa' 2>/dev/null; then
      ok "Nemotron audio feature dependencies import successfully"
    else
      fail "Nemotron audio feature dependencies cannot be imported"
    fi
  fi
  nemotron_snapshot="$NEMOTRON_CACHE/models--nvidia--nemotron-3.5-asr-streaming-0.6b/snapshots/$NEMOTRON_REVISION"
  if [[ -d "$nemotron_snapshot" ]]; then
    ok "Nemotron pinned snapshot is present"
  else
    fail "Nemotron pinned snapshot is missing: $nemotron_snapshot"
  fi
  check_port "${NEMOTRON_ASR_PORT:-8095}" Nemotron
fi

check_file "$MODEL_DIR/$MAIN_NAME" "$MAIN_SHA" "Gemma main GGUF"
check_file "$MODEL_DIR/$MMPROJ_NAME" "$MMPROJ_SHA" "Gemma mmproj"
llama_args=(--llama-dir "$LLAMA_DIR" --mtp-mode "$effective_mtp")
if ! "$ROOT_DIR/scripts/check-llama-gemma4.sh" "${llama_args[@]}"; then
  fail "llama.cpp runtime compatibility check failed"
else
  ok "Gemma audio/text runtime ready"
fi
if [[ "$effective_mtp" == "on" ]]; then
  check_file "$MODEL_DIR/$MTP_NAME" "$MTP_SHA" "Gemma MTP GGUF"
else
  ok "MTP artifact is not required by the effective runtime mode"
fi
check_port "${GEMMA4_INTERPRETER_PORT:-8093}" Gemma

if [[ "$TTS_OWNER" == "supertonic" ]]; then
  check_executable "$SUPERTONIC_VENV/bin/python"
  if [[ -x "$SUPERTONIC_VENV/bin/python" ]]; then
    version="$(package_version "$SUPERTONIC_VENV/bin/python" supertonic || true)"
    [[ "$version" == "1.3.1" ]] && ok "supertonic package=1.3.1" || fail "supertonic package version is ${version:-unavailable}, expected 1.3.1"
  fi
  if [[ -d "$SUPERTONIC_CACHE" ]] && find "$SUPERTONIC_CACHE" -type f -print -quit 2>/dev/null | rg -q .; then
    ok "Supertonic asset cache is populated"
  else
    fail "Supertonic asset cache is missing or empty: $SUPERTONIC_CACHE"
  fi
else
  check_executable "$QWEN_VENV/bin/python"
  if [[ -x "$QWEN_VENV/bin/python" ]]; then
    version="$(package_version "$QWEN_VENV/bin/python" qwen-tts || true)"
    [[ "$version" == "0.1.1" ]] && ok "qwen-tts package=0.1.1" || fail "qwen-tts package version is ${version:-unavailable}, expected 0.1.1"
  fi
  qwen_snapshot="$QWEN_CACHE/hub/models--Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice/snapshots/$QWEN_REVISION"
  if [[ ! -d "$qwen_snapshot" ]]; then
    qwen_snapshot="$QWEN_CACHE/models--Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice/snapshots/$QWEN_REVISION"
  fi
  if [[ -d "$qwen_snapshot" ]]; then
    ok "Qwen3-TTS pinned snapshot is present"
  else
    fail "Qwen3-TTS pinned snapshot is missing under $QWEN_CACHE"
  fi
fi

check_port "${INTERPRETER_SILERO_PORT:-8094}" Silero
check_port "${INTERPRETER_PORT:-8765}" Interpreter

if command -v nvidia-smi >/dev/null 2>&1; then
  gpu_line="$(nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits 2>/dev/null | head -1 || true)"
  if [[ "$gpu_line" =~ ^.+,[[:space:]]*[0-9]+,[[:space:]]*[0-9]+$ ]]; then
    ok "GPU (MiB total/free): $gpu_line"
  else
    warn "nvidia-smi is installed but GPU telemetry is unavailable in this environment"
  fi
else
  fail "nvidia-smi is required by the selected GPU ASR/Gemma runtime"
fi

interpreter_host="${INTERPRETER_HOST:-127.0.0.1}"
if [[ "$interpreter_host" != "127.0.0.1" && "$interpreter_host" != "localhost" && "$interpreter_host" != "::1" ]]; then
  if [[ -n "${MH_INTERPRETER_AUTH_TOKEN:-${MH_FACE_AUTH_TOKEN:-}}" ]]; then
    ok "non-loopback interpreter bind has an auth token"
  else
    fail "MH_INTERPRETER_AUTH_TOKEN is required for host $interpreter_host"
  fi
fi

echo "[interpreter-doctor] failures=${FAILURES} warnings=${WARNINGS}"
((FAILURES == 0))
