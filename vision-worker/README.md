# vision-worker

Continuous camera perception for the **AtomS3R-M12 Camera Kit**. It pulls
frames, gates on visual change, asks a vision-language model for a structured
record (full OCR + scene overview + change-from-previous), and keeps a small
rolling memory in SQLite that cloud agents (Claude/codex/agy) query through a
skill + HTTP API.

This worker is **GPU-free by default**. The perception model is swappable; the
bundled `MockModelClient` runs the whole pipeline and the test suite without a
GPU. The real model (`nvidia/diffusiongemma-26B-A4B-it-NVFP4` via an
OpenAI-compatible vLLM endpoint) is wired in as an optional backend.

See the public guide in
[`doc/guides/m12-vision.md`](../doc/guides/m12-vision.md), which covers the
perception flow, the tiered situation memory, corrections, and alerts.

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

## Real model: diffusiongemma via vLLM

The default real-model path uses NVIDIA's NVFP4 diffusiongemma checkpoint:
[`nvidia/diffusiongemma-26B-A4B-it-NVFP4`](https://huggingface.co/nvidia/diffusiongemma-26B-A4B-it-NVFP4).
Use the Hugging Face model card for upstream model details, access and license
terms, supported hardware, and current vLLM compatibility notes. In this
repository, prefer the scripts below instead of copying raw vLLM flags from the
model card.

Prerequisites for the default Docker path:

- Docker with NVIDIA GPU access.
- A supported NVIDIA GPU for the NVFP4 checkpoint, as described by the model
  card.
- Optional `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` if your Hugging Face setup
  needs one for download or rate-limit handling.

Initial image pull:

    ./scripts/setup-vllm-diffusiongemma.sh

Start or reuse the model server:

    ./scripts/run-vllm-diffusiongemma.sh start

Then point the worker at it:

    VISION_MODEL_BACKEND=diffusiongemma VISION_MODEL_URL=http://127.0.0.1:8000/v1 \
      ./scripts/run-vision-worker.sh

For the full M12 camera path, prefer `./scripts/run-vision-stack.sh`; it starts
or reuses the vLLM server, the `vision-worker`, and the M12 alert speaker bridge
together.

Advanced users may point `VISION_MODEL_URL` and `VISION_MODEL_NAME` at another
OpenAI-compatible vision endpoint. That endpoint must accept image+text
`/chat/completions` requests and return one JSON object with these fields:
`is_text`, `ocr_full`, `overview`, `changed`, and `change_from_prev`.
`VISION_GUIDED_DECODING=1` asks vLLM to enforce this schema with `guided_json`
when the endpoint supports it. Runtime knobs such as `VLLM_DGEMMA_PORT`,
`VLLM_DGEMMA_GPU_MEM_UTIL`, `VLLM_DGEMMA_MAX_MODEL_LEN`, and
`VLLM_DGEMMA_BACKEND` are intentionally documented by
`scripts/run-vllm-diffusiongemma.sh`, which is the source of truth for the
repository's pinned vLLM options.

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
| `VISION_VOTE_K` | `1` | temporal voting count |
| `VISION_MAX_CHANGES` | `50` | rolling change-window size |
| `VISION_GATE_HAMMING` | `6` | perceptual-hash change threshold |
| `VISION_GATE_PIXELDIFF` | `0.06` | pixel-diff change threshold |
