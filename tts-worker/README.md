# minimum-headroom tts-worker

Local TTS worker for `minimum-headroom`. The face-app process spawns this
worker as a child and talks to it over stdin/stdout using a newline-delimited
JSON protocol; you do not run it manually in normal use.

Two engines are available:

- **Kokoro ONNX (default).** English-first voice via `kokoro-onnx` + `misaki`.
  Japanese is handled with `pyopenjtalk` + `fugashi` and the bundled English
  Kokoro voices.
- **Qwen3-TTS (optional).** Japanese-focused backend for higher-quality JA
  speech; requires the Qwen TTS runtime to be installed separately.

## Setup

From the repository root:

```bash
uv sync --project tts-worker --locked
# or: npm run setup  (does this and the other workers in one step)
```

Model assets for Kokoro are downloaded separately and placed under
`assets/kokoro/` (see `assets/kokoro/README.md`).

## Smoke test

```bash
uv run --project tts-worker tts-worker --smoke
```

This initializes the engine, emits a single `ready` line on stdout, and
exits. Use it to confirm the model files and Python dependencies are in
place without bringing up the full face-app.

## Manual invocation

```bash
uv run --project tts-worker tts-worker
```

The worker reads JSONL commands on stdin and writes JSONL events on stdout.
The protocol is consumed by face-app; running the worker by hand is only
useful for debugging — feed it lines that match the `ParsedCommand` shape in
`src/tts_worker/protocol.py`.

## Environment knobs

Common environment variables (see `src/tts_worker/` for the full set):

- `MH_TTS_ENGINE` — `kokoro` (default) or `qwen3`.
- `MH_TTS_CHUNK_MAX_CHARS` — soft cap for synthesis chunk size. Defaults are
  safe for desktop browsers; lower values reduce per-chunk latency on
  bandwidth-constrained clients such as AtomS3R.
- `MH_QWEN_TTS_*` — Qwen3 engine tuning (style, language, gain, speed, dtype).
- Audio target / device selection is resolved by face-app from its own
  configuration and forwarded to the worker on spawn.

### Anomaly capture (diagnostics)

Off by default. When enabled, the worker inspects each freshly synthesized
waveform and, if it looks noise-like (broadband hiss, heavy clipping, or
NaN/inf samples), saves a forensic WAV plus a JSON sidecar (input text,
prepared text, and the metrics) to a capture directory. This is **capture
only** — it never changes what is played or sent to the browser, is wrapped so
a capture failure can never break TTS, and is bounded by a per-process budget.
Use it to catch rare, non-reproducible "noise-filled walkie-talkie" utterances.

- `MH_TTS_CAPTURE_ANOMALY` — `1`/`true` to enable (default off).
- `MH_TTS_CAPTURE_DIR` — output directory (default
  `~/.cache/minimum-headroom/tts-captures`).
- `MH_TTS_CAPTURE_RMS_FLOOR` — minimum RMS before the broadband-noise trigger
  fires (default `0.02`); guards against flagging quiet audio.
- `MH_TTS_CAPTURE_ZCR_THRESHOLD` — zero-crossing-rate threshold for the
  broadband-noise trigger (default `0.35`; voiced speech sits well below this,
  broadband hiss approaches `0.5`).
- `MH_TTS_CAPTURE_CLIP_FRACTION` — fraction of near-full-scale samples that
  trips the clipping trigger (default `0.2`).
- `MH_TTS_CAPTURE_MAX` — per-process cap on the number of captures written
  (default `20`).

From the operator stack, the simplest way to turn it on is to prefix the
launcher: `MH_TTS_CAPTURE_ANOMALY=1 ./scripts/run-operator-once.sh ...` (also
honored by `run-operator-stack.sh` and `restart-operator-stack-in-place.sh`),
which forwards the flag through the tmux allowlist into the spawned worker.
