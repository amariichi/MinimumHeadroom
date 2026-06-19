# vision-worker

Continuous camera perception for the **AtomS3R-M12 Camera Kit**. It pulls
frames, gates on visual change, asks a vision-language model for a structured
record (full OCR + scene overview + change-from-previous), and keeps a small
rolling memory in SQLite that cloud agents (Claude/codex/agy) query through a
skill + HTTP API.

This worker is **GPU-free by default**. The perception model is swappable; the
bundled `MockModelClient` runs the whole pipeline and the test suite without a
GPU. The real model (`nvidia/diffusiongemma-26B-A4B-it-NVFP4` via an
OpenAI-compatible vLLM endpoint) is wired in milestone M2.

See the full design in
[`.agent/execplans/atoms3r-m12-vision-memory.md`](../.agent/execplans/atoms3r-m12-vision-memory.md).

## Run (mock backend, no GPU)

    ./scripts/run-vision-worker.sh                # HTTP server on VISION_PORT (default 8095)

Replay a folder of frames through the pipeline (writes to the shared SQLite DB):

    VISION_FRAME_DIR=/path/to/frames ./scripts/run-vision-worker.sh --replay-once

Then query it:

    curl -s http://127.0.0.1:8095/healthz
    curl -s http://127.0.0.1:8095/latest
    curl -s "http://127.0.0.1:8095/diffs?n=50"
    curl -s http://127.0.0.1:8095/frame/1 --output /tmp/frame1.jpg

## Tests

    uv run --project vision-worker pytest

## Real model (milestone M2, needs a free GPU)

    ./scripts/setup-vllm-diffusiongemma.sh
    ./scripts/run-vllm-diffusiongemma.sh
    VISION_MODEL_BACKEND=diffusiongemma VISION_MODEL_URL=http://127.0.0.1:8000/v1 \
      ./scripts/run-vision-worker.sh

## Key environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `VISION_HOST` / `VISION_PORT` | `127.0.0.1` / `8095` | HTTP bind |
| `VISION_MODEL_BACKEND` | `mock` | `mock` or `diffusiongemma` |
| `VISION_MODEL_URL` | `http://127.0.0.1:8000/v1` | OpenAI-compatible endpoint |
| `VISION_MODEL_NAME` | `nvidia/diffusiongemma-26B-A4B-it-NVFP4` | model id |
| `VISION_GUIDED_DECODING` | `0` | force JSON via vLLM guided decoding |
| `VISION_CACHE_DIR` | `~/.cache/minimum-headroom/vision` | frame + DB storage |
| `VISION_DB_PATH` | `<cache>/vision.db` | SQLite path |
| `VISION_FRAME_DIR` | unset | replay source folder |
| `VISION_CAMERA_URL` | unset | network snapshot URL (M3) |
| `VISION_CAPTURE_INTERVAL_MS` | `1500` | replay/poll interval |
| `VISION_VOTE_K` | `1` | temporal voting count (M2) |
| `VISION_MAX_CHANGES` | `50` | rolling change-window size |
| `VISION_GATE_HAMMING` | `6` | perceptual-hash change threshold |
| `VISION_GATE_PIXELDIFF` | `0.06` | pixel-diff change threshold |
