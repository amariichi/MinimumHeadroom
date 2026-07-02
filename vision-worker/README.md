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

## Full M12 Vision Stack

The reboot-safe stack entrypoint is:

    ./scripts/run-vision-stack.sh --check   # dry run, starts nothing
    ./scripts/run-vision-stack.sh           # start/reuse diffusiongemma + worker + M12 speaker

It reads persistent configuration from `~/.config/minimum-headroom.env`, never
from `/tmp`. Required live key:

| Variable | Meaning |
| --- | --- |
| `MH_FACE_AUTH_TOKEN` | auth token sent to AtomS3R `/health` and audio endpoints |

M12 endpoint URLs can be explicit or discovered at startup:

| Variable | Meaning |
| --- | --- |
| `VISION_CAMERA_URL` | AtomS3R-M12 snapshot URL, or unset/`auto` for discovery |
| `M12_AUDIO_URL` | AtomS3R-M12 `/api/headroom/audio` URL, or unset/`auto` |
| `MH_M12_DEVICE_ID` | expected M12 firmware `device_id` (default `atom-headroom-m12`) |
| `ATOM_HEADROOM_DISCOVERY_SUBNETS` | optional extra routed `/24` subnets to probe |

Discovery uses `scripts/resolve-atoms3r-device.py`: it first considers the
existing device->PC websocket source IPs on port 8765, then uses the same
AtomS3R `/health` subnet-probing pattern as `scripts/atoms3r-http-bridge.mjs`.
Results are cached under `~/.cache/minimum-headroom/` unless
`MH_DEVICE_REGISTRY_PATH` overrides it. The faced Atom bridge already keeps its
own push URL fresh with `ATOM_HEADROOM_DISCOVERY_SUBNETS`; set
`ATOM_HEADROOM_URL=auto` or leave it unset to let that bridge discovery win over
any stale static IP.

The script sets the live worker profile to `VISION_MODEL_BACKEND=diffusiongemma`,
`VISION_OUTPUT_LANG=ja`, `VISION_CORRECTION_TO_MODEL=1`,
`VISION_NARRATE_CHANGES=1`, `VISION_ALERT_ENABLED=1`, and
`VISION_ALERT_WEBHOOK=http://127.0.0.1:8096/alert` unless an explicit override is
already present. Useful optional overrides include `VISION_PORT`,
`VISION_CACHE_DIR`, `VISION_DB_PATH`, `VISION_CAMERA_REDISCOVER_AFTER_FAILURES`,
other `VISION_*` knobs, `VLLM_DGEMMA_*`, and `M12_SPEAKER_*`.

The script does not start Voxtral or any ASR service. The operator stack owns
ASR; keep Parakeet on CPU there with `MH_ASR_DEVICE=cpu` when GPU memory is
tight.

Deferred live smoke checklist for the next physical M12 pass:

1. After reboot, run `./scripts/run-vision-stack.sh --check`, then
   `./scripts/run-vision-stack.sh`.
2. Confirm diffusiongemma `/v1/models`, vision-worker `/healthz`, and the
   speaker bridge port are healthy.
3. Confirm `POST /look` works against the M12.
4. Confirm the face stack remains up and no CUDA OOM appears while
   diffusiongemma is loaded.
5. Trigger a vision alert or narration and confirm speech reaches the M12 Echo
   Base.

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
| `VISION_CAMERA_URL` | unset/`auto` | network snapshot URL, discovered by `run-vision-stack.sh` when unset/`auto` |
| `VISION_CAMERA_RESOLVE_DEVICE_ID` | unset | device id used to re-resolve the snapshot URL after failures |
| `VISION_CAMERA_REDISCOVER_AFTER_FAILURES` | `5` | consecutive network capture failures before re-resolution |
| `VISION_CAPTURE_INTERVAL_MS` | `1500` | replay/poll interval |
| `VISION_VOTE_K` | `1` | temporal voting count (M2) |
| `VISION_MAX_CHANGES` | `50` | rolling change-window size |
| `VISION_GATE_HAMMING` | `6` | perceptual-hash change threshold |
| `VISION_GATE_PIXELDIFF` | `0.06` | pixel-diff change threshold |
