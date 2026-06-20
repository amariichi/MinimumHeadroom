#!/usr/bin/env bash
# Run the M12 alert speaker bridge (vision-worker alert webhook -> kokoro TTS ->
# AtomS3R-M12 Echo Base). Uses the tts-worker virtualenv for kokoro.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PY="$ROOT_DIR/tts-worker/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "[run-m12-alert-speaker] tts-worker venv python not found at $PY" >&2
  echo "[run-m12-alert-speaker] set up the tts-worker first." >&2
  exit 2
fi

# Auth token: prefer the environment, else load from the shared env file.
if [[ -z "${MH_FACE_AUTH_TOKEN:-}" && -f "$HOME/.config/minimum-headroom.env" ]]; then
  set -a; source "$HOME/.config/minimum-headroom.env"; set +a
fi

echo "[run-m12-alert-speaker] M12_AUDIO_URL=${M12_AUDIO_URL:-http://192.168.1.25/api/headroom/audio} port=${M12_SPEAKER_PORT:-8096}"
exec "$PY" "$ROOT_DIR/scripts/m12_alert_speaker.py"
