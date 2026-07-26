from __future__ import annotations

import base64
import os
import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Literal

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
    # Silero keeps recurrent state between chunks. The caller supplies a
    # stable stream identity and an epoch that changes whenever buffered
    # audio is invalidated, so independent Atom sessions cannot contaminate
    # each other and TTS/generation resets also reset model state.
    sessionId: str = Field(default="atom-headroom", min_length=1, max_length=128)
    streamEpoch: int = Field(default=0, ge=0)
    generation: int = Field(default=0, ge=0)
    sequence: int = Field(default=0, ge=0)


class VadResponse(BaseModel):
    is_speech: bool
    speech_prob: float
    chunks: int
    durationMs: float
    device: Literal["cpu", "cuda"]
    sessionId: str
    streamEpoch: int
    generation: int
    sequence: int
    stateReset: bool


def _decode_pcm16(audio_base64: str) -> np.ndarray:
    raw = base64.b64decode(audio_base64, validate=False)
    if len(raw) < 2:
        raise HTTPException(status_code=400, detail="audio too short")
    if len(raw) % 2 != 0:
        raise HTTPException(status_code=400, detail="audio is not aligned to 16-bit samples")
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return samples


def _max_sessions(value: int | None = None) -> int:
    if value is None:
        try:
            value = int(os.getenv("MH_SILERO_MAX_SESSIONS", "8"))
        except ValueError:
            value = 8
    return max(1, min(64, int(value)))


def _reset_model(model: Any) -> None:
    reset = getattr(model, "reset_states", None)
    if callable(reset):
        reset()


@dataclass
class _SessionModel:
    model: Any
    stream_epoch: int
    generation: int
    last_sequence: int = 0


class SileroSessionPool:
    """Bounded LRU pool of stateful Silero models, one per audio stream."""

    def __init__(
        self,
        loader: Callable[[], Any],
        *,
        device: str,
        max_sessions: int,
        initial_model: Any,
    ) -> None:
        self._loader = loader
        self._device = device
        self._max_sessions = max_sessions
        self._sessions: OrderedDict[str, _SessionModel] = OrderedDict()
        self._spare_models: list[Any] = [initial_model]

    @property
    def active_sessions(self) -> int:
        return len(self._sessions)

    @property
    def max_sessions(self) -> int:
        return self._max_sessions

    def _prepare_model(self, model: Any) -> Any:
        if self._device == "cuda":
            model = model.to("cuda")
        _reset_model(model)
        return model

    def _take_model(self) -> Any:
        if self._spare_models:
            return self._prepare_model(self._spare_models.pop())
        if len(self._sessions) >= self._max_sessions:
            _, evicted = self._sessions.popitem(last=False)
            return self._prepare_model(evicted.model)
        return self._prepare_model(self._loader())

    def acquire(
        self,
        session_id: str,
        *,
        stream_epoch: int,
        generation: int,
    ) -> tuple[_SessionModel, bool]:
        key = session_id.strip() or "atom-headroom"
        state = self._sessions.pop(key, None)
        state_reset = False
        if state is None:
            state = _SessionModel(
                model=self._take_model(),
                stream_epoch=stream_epoch,
                generation=generation,
            )
            state_reset = True
        elif (
            state.stream_epoch != stream_epoch
            or state.generation != generation
        ):
            _reset_model(state.model)
            state.stream_epoch = stream_epoch
            state.generation = generation
            state.last_sequence = 0
            state_reset = True
        self._sessions[key] = state
        return state, state_reset


def create_app(
    model_loader: Callable[[], Any] | None = None,
    max_sessions: int | None = None,
) -> FastAPI:
    import torch
    from silero_vad import load_silero_vad

    app = FastAPI(title="silero-vad-worker")
    device = _resolve_device()
    if device == "cuda" and not torch.cuda.is_available():
        device = "cpu"

    state_lock = threading.Lock()
    # load_silero_vad returns an ONNX-or-PyTorch module depending on its
    # install; either way model(tensor, sample_rate) returns a 0-D speech
    # probability tensor. Keep a bounded model per logical stream because
    # the module stores recurrent context internally.
    loader = model_loader or load_silero_vad
    initial_model = loader()
    if device == "cuda":
        try:
            initial_model = initial_model.to(device)
        except Exception:
            device = "cpu"
    pool = SileroSessionPool(
        loader,
        device=device,
        max_sessions=_max_sessions(max_sessions),
        initial_model=initial_model,
    )

    @app.get("/health")
    def health() -> dict:
        with state_lock:
            return {
                "ok": True,
                "service": "silero-vad-worker",
                "device": device,
                "sampleRates": sorted(SILERO_CHUNK_SAMPLES.keys()),
                "activeSessions": pool.active_sessions,
                "maxSessions": pool.max_sessions,
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
            session_id = req.sessionId.strip() or "atom-headroom"
            session, state_reset = pool.acquire(
                session_id,
                stream_epoch=req.streamEpoch,
                generation=req.generation,
            )
            import torch
            with torch.no_grad():
                for chunk in chunks:
                    tensor = torch.from_numpy(chunk)
                    if device == "cuda":
                        tensor = tensor.to("cuda")
                    prob = session.model(tensor, req.sampleRate).item()
                    probs.append(float(prob))
            session.last_sequence = req.sequence

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
            sessionId=session_id,
            streamEpoch=req.streamEpoch,
            generation=req.generation,
            sequence=req.sequence,
            stateReset=state_reset,
        )

    return app
