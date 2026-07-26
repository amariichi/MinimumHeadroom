from __future__ import annotations

import base64
import binascii
import logging
import os
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .runtime import (
    DEFAULT_MODEL_ID,
    DEFAULT_MODEL_REVISION,
    NemotronAsrRuntime,
)

logger = logging.getLogger(__name__)


class AsrRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    audio_base64: str = Field(alias="audioBase64", min_length=1)
    mime_type: str = Field(default="audio/wav", alias="mimeType")
    language: str = "auto"


def create_runtime() -> NemotronAsrRuntime:
    return NemotronAsrRuntime(
        model_id=os.environ.get("NEMOTRON_ASR_MODEL_ID", DEFAULT_MODEL_ID),
        revision=os.environ.get(
            "NEMOTRON_ASR_MODEL_REVISION",
            DEFAULT_MODEL_REVISION,
        ),
        cache_dir=os.environ.get("NEMOTRON_ASR_CACHE_DIR") or None,
        device=os.environ.get("NEMOTRON_ASR_DEVICE", "cuda"),
    )


def create_app(runtime: NemotronAsrRuntime | None = None) -> FastAPI:
    active_runtime = runtime or create_runtime()
    app = FastAPI(title="Minimum Headroom Nemotron ASR", docs_url=None, redoc_url=None)

    @app.on_event("startup")
    def load_model() -> None:
        active_runtime.load()

    @app.get("/healthz")
    def health() -> dict[str, Any]:
        payload = active_runtime.health()
        if not payload["ok"]:
            raise HTTPException(status_code=503, detail=payload)
        return payload

    @app.post("/v1/asr/auto")
    def transcribe(request: AsrRequest) -> dict[str, Any]:
        if request.mime_type.split(";", 1)[0].strip().lower() not in {
            "audio/wav",
            "audio/x-wav",
            "audio/wave",
        }:
            raise HTTPException(status_code=415, detail="unsupported_media_type")
        if request.language.strip().lower() != "auto":
            raise HTTPException(status_code=422, detail="language_must_be_auto")
        try:
            audio = base64.b64decode(request.audio_base64, validate=True)
        except (binascii.Error, ValueError) as error:
            raise HTTPException(status_code=400, detail="invalid_audio_base64") from error
        if len(audio) > 16 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="audio_too_large")
        try:
            return active_runtime.transcribe_wav(audio)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except Exception as error:
            logger.exception("Nemotron ASR inference failed")
            raise HTTPException(status_code=502, detail="asr_inference_failed") from error

    return app
