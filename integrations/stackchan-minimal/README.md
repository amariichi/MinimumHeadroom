# StackChan Minimal sidecar

This directory contains sidecar services for using StackChan Minimal with this repository's local speech stack.

It does not start the minimum-headroom operator UI. It starts only the pieces StackChan Minimal expects:

- a whisper.cpp-compatible STT adapter on port `8081`, backed by `asr-worker` Parakeet JA/EN
- a piper/VOICEVOX-shaped TTS adapter on port `5000`, backed by Kokoro ONNX
- an optional `llama-server` OpenAI-compatible LLM endpoint on port `8080`

## Quick start

The launcher auto-detects this local Qwen GGUF when it exists:

    /home/amari1/models/unsloth/Qwen3.6-35B-A3B/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf

You can also set a local GGUF model path explicitly, then run:

    export STACKCHAN_LLM_MODEL_PATH=/home/amari1/models/unsloth/Qwen3.6-35B-A3B/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf
    ./scripts/run-stackchan-sidecar.sh

To use Nemotron instead, point `STACKCHAN_LLM_MODEL_PATH` at the Nemotron GGUF file. The launcher does not hard-code a model because local filenames and quantization choices vary.

## StackChan Minimal settings

Use the host IP printed by `run-stackchan-sidecar.sh`.

- STT server IP: printed host IP
- STT server port: `8081`
- STT path: `/inference`
- TTS server IP: printed host IP
- TTS server port: `5000`
- LLM base URL: `http://<host-ip>:8080/v1`

The LLM endpoint is OpenAI-compatible through llama.cpp. Use the model name expected by your StackChan Minimal build; llama.cpp accepts chat completions at `/v1/chat/completions`.

The llama-server defaults use the safer 32GB VRAM starting point from english-trainer's `.env.example`:

    LLAMA_CTX_SIZE=8192
    LLAMA_PARALLEL=1
    LLAMA_GPU_LAYERS=-1
    LLAMA_FLASH_ATTN=on
    LLAMA_JINJA=1
    LLAMA_REASONING=off

On a 32GB VRAM GPU this is the intended starting point for the Qwen3.6 35B Q4_K_XL model plus Parakeet JA on CUDA. The english-trainer README also records `12288` as a single-user Nemotron Cascade operating point; try `LLAMA_CTX_SIZE=12288` only after confirming the Qwen sidecar is stable at `8192`.

The local llama.cpp build reports `--jinja` as enabled by default and `--flash-attn` as `auto` by default. The sidecar still passes them explicitly so the Qwen chat template path and attention mode are visible in the launch command. Set `LLAMA_FLASH_ATTN=auto` if a future llama.cpp build or model combination has trouble with forced Flash Attention.

`LLAMA_REASONING=off` is intentional for StackChan Minimal. Qwen thinking chunks can be returned as `reasoning_content`; StackChan Minimal expects normal `content` chunks for display and TTS, so reasoning output can leave the spoken response empty.

## Environment

Copy or source `stackchan.env.example` for the most common knobs.

The defaults bind the adapter and llama-server ports to `0.0.0.0` so an M5Stack device on the same trusted LAN can reach them. Do not expose these ports to an untrusted network.

If you already have services running:

    STACKCHAN_START_ASR_WORKER=0 ./scripts/run-stackchan-sidecar.sh
    STACKCHAN_START_LLM=0 ./scripts/run-stackchan-sidecar.sh

## Parakeet GPU mode

The sidecar starts minimum-headroom `asr-worker` with CUDA by default:

    ASR_DEVICE=cuda
    STACKCHAN_ASR_DEVICE=cuda
    ASR_SINGLE_MODEL_CACHE=true
    ASR_PRELOAD_MODELS=false
    ASR_MODEL_JA=nvidia/parakeet-tdt_ctc-0.6b-ja

This mirrors the safer english-trainer GPU posture: keep only one ASR model resident at a time and avoid preloading EN/JA together. That keeps VRAM pressure lower while still running the Japanese Parakeet model on GPU.

If your login shell already exports `ASR_DEVICE=cpu`, set `STACKCHAN_ASR_DEVICE=cuda` or unset `ASR_DEVICE` before launching. The launcher prints the effective ASR device at startup.

## Adapter endpoints

ASR adapter:

- `GET /health`
- `POST /inference`
- `POST /v1/audio/transcriptions`

The request may be whisper.cpp-style multipart form data with a file field, raw audio bytes, or JSON containing `audioBase64` and `mimeType`.

TTS adapter:

- `GET /health`
- `GET /voices`
- `GET /tts_live.wav?text=...`
- `POST /synthesize`
- `POST /tts`
- `POST /api/tts`
- `POST /audio_query`
- `POST /synthesis`

The piper-like endpoints return `audio/wav`. The VOICEVOX-like endpoints are minimal compatibility endpoints for clients that call `audio_query` and then `synthesis`.
