from __future__ import annotations

import base64
import os
import threading
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


# Silero VAD model expects exact chunk sizes per sample rate.
SILERO_CHUNK_SAMPLES = {16000: 512, 8000: 256}


def _resolve_device() -> str:
    # Silero is small enough that CPU is generally faster after the
    # PyTorch GPU launch overhead. Allow override anyway.
    env = (os.getenv("SILERO_DEVICE") or os.getenv("MH_SILERO_DEVICE") or "cpu").strip().lower()
    if env in {"cuda", "gpu"}:
        return "cuda"
    return "cpu"


class VadRequest(BaseModel):
    # PCM16 little-endian samples, base64-encoded. The worker re-chunks
    # internally so callers do not have to match Silero's exact 512-sample
    # window — pass a whole AtomS3R audio frame (1024 samples) and the
    # worker returns the aggregated decision over the chunks it contains.
    audioBase64: str = Field(min_length=4)
    sampleRate: int = Field(default=16000, ge=8000, le=48000)
    threshold: float = Field(default=0.5, ge=0.0, le=1.0)


class VadResponse(BaseModel):
    is_speech: bool
    speech_prob: float
    chunks: int
    durationMs: float
    device: Literal["cpu", "cuda"]


def _decode_pcm16(audio_base64: str) -> np.ndarray:
    raw = base64.b64decode(audio_base64, validate=False)
    if len(raw) < 2:
        raise HTTPException(status_code=400, detail="audio too short")
    if len(raw) % 2 != 0:
        raise HTTPException(status_code=400, detail="audio is not aligned to 16-bit samples")
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def create_app() -> FastAPI:
    import torch
    from silero_vad import load_silero_vad

    app = FastAPI(title="silero-vad-worker")
    device = _resolve_device()
    if device == "cuda" and not torch.cuda.is_available():
        device = "cpu"

    state_lock = threading.Lock()
    # load_silero_vad returns an ONNX-or-PyTorch module depending on its
    # install; either way model(tensor, sample_rate) returns a 0-D speech
    # probability tensor.
    model = load_silero_vad()
    if device == "cuda":
        try:
            model = model.to(device)
        except Exception:
            device = "cpu"

    @app.get("/health")
    def health() -> dict:
        return {
            "ok": True,
            "service": "silero-vad-worker",
            "device": device,
            "sampleRates": sorted(SILERO_CHUNK_SAMPLES.keys()),
        }

    @app.post("/v1/vad", response_model=VadResponse)
    def vad(req: VadRequest) -> VadResponse:
        chunk_size = SILERO_CHUNK_SAMPLES.get(req.sampleRate)
        if chunk_size is None:
            raise HTTPException(
                status_code=400,
                detail=f"unsupported sampleRate={req.sampleRate}; allowed={sorted(SILERO_CHUNK_SAMPLES)}",
            )
        samples = _decode_pcm16(req.audioBase64)
        if samples.size == 0:
            raise HTTPException(status_code=400, detail="audio is empty")

        # Re-chunk to the exact size Silero needs. Pad the trailing chunk
        # with zeros so the caller's frame size does not have to match.
        chunks = []
        for start in range(0, samples.size, chunk_size):
            chunk = samples[start:start + chunk_size]
            if chunk.size < chunk_size:
                padded = np.zeros(chunk_size, dtype=np.float32)
                padded[: chunk.size] = chunk
                chunk = padded
            chunks.append(chunk)

        probs: list[float] = []
        with state_lock:
            import torch
            with torch.no_grad():
                for chunk in chunks:
                    tensor = torch.from_numpy(chunk)
                    if device == "cuda":
                        tensor = tensor.to("cuda")
                    prob = model(tensor, req.sampleRate).item()
                    probs.append(float(prob))

        # Aggregate: the chunk-level decision a caller wants for a 1024-sample
        # AtomS3R frame is "did any 32 ms window inside this frame look like
        # speech". Use the max probability over chunks for that semantic; the
        # caller can also threshold the returned value directly if they want
        # a stricter rule.
        max_prob = max(probs) if probs else 0.0
        duration_ms = (samples.size / req.sampleRate) * 1000.0
        return VadResponse(
            is_speech=max_prob >= req.threshold,
            speech_prob=max_prob,
            chunks=len(chunks),
            durationMs=duration_ms,
            device=device,
        )

    return app
