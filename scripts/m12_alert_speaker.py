"""M12 alert speaker bridge.

Receives vision-worker alert webhooks and makes the AtomS3R-M12 announce them
through its own Echo Base (ES8311) speaker. This closes the loop: camera sees ->
diffusiongemma observes -> vision-worker watch fires -> POST here -> kokoro TTS
-> M12 /api/headroom/audio -> Echo Base speech.

Why a separate bridge: the vision-worker stays generic (it only POSTs the alert
as JSON), and all M12/Japanese/audio specifics live here:
  * kokoro TTS (loaded once),
  * a short lead-in silence to absorb the ES8311 startup transient,
  * a conservative amplitude (the M12 firmware speaker volume is high and the
    M5.Speaker volume curve is non-linear; final loudness is set by amplitude),
  * the M12 audio HTTP endpoint + auth.

Run (uses the tts-worker venv for kokoro):
  MH_FACE_AUTH_TOKEN=... \
  ./scripts/run-m12-alert-speaker.sh        # or: <tts venv python> scripts/m12_alert_speaker.py

Then point the vision-worker at it:
  VISION_ALERT_ENABLED=1 \
  VISION_ALERT_WEBHOOK=http://127.0.0.1:8096/alert \
  ... ./scripts/run-vision-worker.sh

POST /alert  body {"text": "...", "watch": "コップ"}  -> speaks "コップが見えました。"
POST /alert  body {"text": "...", "watch": "change"} -> speaks `text` verbatim
             (ambient change-narration; the line is already a full sentence)
POST /say    body {"text": "任意の文"}                -> speaks the text verbatim
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tts-worker", "src"))
from tts_worker.kokoro_engine import KokoroEngine, resolve_model_paths  # noqa: E402

M12_AUDIO_URL = os.getenv("M12_AUDIO_URL", "http://192.168.1.25/api/headroom/audio")
AUTH_TOKEN = os.getenv("MH_FACE_AUTH_TOKEN", "")
BIND_HOST = os.getenv("M12_SPEAKER_HOST", "127.0.0.1")
BIND_PORT = int(os.getenv("M12_SPEAKER_PORT", "8096"))
AMP = float(os.getenv("M12_SPEAKER_AMP", "0.22"))          # linear loudness control
LEAD_SILENCE_S = float(os.getenv("M12_SPEAKER_LEAD_SILENCE", "0.25"))  # ES8311 settle
MIN_INTERVAL_S = float(os.getenv("M12_SPEAKER_MIN_INTERVAL", "4.0"))   # rate limit

print("[m12-speaker] loading kokoro...", flush=True)
with contextlib.redirect_stdout(sys.stderr):
    _engine = KokoroEngine(model_paths=resolve_model_paths())
print(f"[m12-speaker] ready: bind {BIND_HOST}:{BIND_PORT} -> {M12_AUDIO_URL}", flush=True)

_last_spoken_at = 0.0


def _synth_wav(text: str) -> bytes:
    with contextlib.redirect_stdout(sys.stderr):
        audio, sr = _engine.synthesize_text(text)
    audio = np.asarray(audio, dtype=np.float32)
    peak = float(np.max(np.abs(audio))) or 1.0
    audio = audio / peak * AMP
    audio = np.concatenate([np.zeros(int(sr * LEAD_SILENCE_S), dtype=np.float32), audio])
    pcm16 = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    w = wave.open(buf, "wb")
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(int(sr))
    w.writeframes(pcm16.tobytes())
    w.close()
    return buf.getvalue()


def _send_to_m12(wav: bytes) -> int:
    req = urllib.request.Request(
        M12_AUDIO_URL,
        data=wav,
        headers={"Content-Type": "audio/wav", "X-Headroom-Auth": AUTH_TOKEN},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status


def _speak(text: str) -> tuple[bool, str]:
    global _last_spoken_at
    now = time.time()
    if now - _last_spoken_at < MIN_INTERVAL_S:
        return False, "rate_limited"
    _last_spoken_at = now
    wav = _synth_wav(text)
    status = _send_to_m12(wav)
    return (200 <= status < 300), f"m12_status={status}"


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n).decode("utf-8") if n else "{}"
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return self._json(400, {"ok": False, "error": "bad_json"})

        if self.path.rstrip("/") == "/say":
            text = (data.get("text") or "").strip()
        else:  # /alert (default): build a Japanese phrase from the watch label
            watch = (data.get("watch") or "").strip()
            if watch == "change":
                # Ambient change-narration: the vision-worker already put the full
                # spoken line in `text` (a scene description, not a keyword), so
                # speak it verbatim instead of "<watch>が見えました".
                text = (data.get("text") or "").strip()
            else:
                text = f"{watch}が見えました。" if watch else (data.get("text") or "").strip()

        if not text:
            return self._json(400, {"ok": False, "error": "empty_text"})

        try:
            ok, detail = _speak(text)
        except Exception as exc:  # noqa: BLE001 - never crash the bridge
            print(f"[m12-speaker] ERROR speaking {text!r}: {exc}", file=sys.stderr, flush=True)
            return self._json(502, {"ok": False, "error": str(exc)})

        print(f"[m12-speaker] {'spoke' if ok else 'skipped'}: {text!r} ({detail})", flush=True)
        return self._json(200, {"ok": ok, "spoken": text, "detail": detail})

    def log_message(self, *args):  # silence default logging
        pass


if __name__ == "__main__":
    if not AUTH_TOKEN:
        print("[m12-speaker] WARNING: MH_FACE_AUTH_TOKEN is empty", file=sys.stderr)
    ThreadingHTTPServer((BIND_HOST, BIND_PORT), Handler).serve_forever()
