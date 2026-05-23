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
