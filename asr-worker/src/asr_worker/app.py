from __future__ import annotations

import base64
import gc
import io
import os
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from nemo.collections.asr.models import ASRModel
from pydantic import BaseModel, Field


Language = Literal["ja", "en", "mixed", "unknown"]


def parse_bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def ordered_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


class AsrRequest(BaseModel):
    audioBase64: str = Field(min_length=16)
    mimeType: str = Field(default="audio/webm")
    model: str | None = None


class AsrResponse(BaseModel):
    text: str
    language: Language
    languageConfidence: dict[Literal["ja", "en"], float]
    jaConfidence: float
    enConfidence: float
    clipped: bool = False
    audioSeconds: float = 0.0


@dataclass
class WorkerSettings:
    fast_model: str = os.getenv("ASR_MODEL_FAST", "nvidia/parakeet-tdt-0.6b-v2")
    en_model: str = os.getenv("ASR_MODEL_EN", "nvidia/parakeet-tdt-0.6b-v2")
    ja_model: str = os.getenv("ASR_MODEL_JA", "nvidia/parakeet-tdt_ctc-0.6b-ja")
    fast_clip_seconds: float = float(os.getenv("ASR_FAST_CLIP_SECONDS", "8.0"))
    device: str = os.getenv("ASR_DEVICE", "cuda").strip().lower()
    single_model_cache: bool = parse_bool_env("ASR_SINGLE_MODEL_CACHE", True)
    preload_models: bool = parse_bool_env("ASR_PRELOAD_MODELS", False)


class ModelRegistry:
    def __init__(self, settings: WorkerSettings):
        self.settings = settings
        self._cache: dict[str, ASRModel] = {}
        self._lock = threading.Lock()

    def get(self, model_name: str) -> ASRModel:
        with self._lock:
            model = self._cache.get(model_name)
            if model is not None:
                return model

            if self.settings.single_model_cache and self.settings.device == "cuda" and self._cache:
                self._evict_all_locked()

            model = ASRModel.from_pretrained(
                model_name=model_name,
                map_location=resolve_map_location(self.settings.device),
            )
            self._cache[model_name] = model
            return model

    def loaded_models(self) -> list[str]:
        with self._lock:
            return sorted(self._cache.keys())

    def loaded_model_devices(self) -> dict[str, str]:
        with self._lock:
            return {name: model_device_name(model) for name, model in self._cache.items()}

    def _evict_all_locked(self) -> None:
        self._cache.clear()
        gc.collect()
        maybe_empty_cuda_cache()


def create_app() -> FastAPI:
    settings = WorkerSettings()
    registry = ModelRegistry(settings)
    inference_lock = threading.Lock()
    app = FastAPI(title="minimum-headroom-asr-worker", version="0.2.0")
    configured_models = ordered_unique([settings.fast_model, settings.en_model, settings.ja_model])

    @app.on_event("startup")
    def preload_on_startup() -> None:
        if not settings.preload_models:
            return
        for model_name in configured_models:
            registry.get(model_name)

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "fastModel": settings.fast_model,
            "enModel": settings.en_model,
            "jaModel": settings.ja_model,
            "loadedModels": registry.loaded_models(),
            "loadedModelDevices": registry.loaded_model_devices(),
            "configuredModels": configured_models,
            "device": settings.device,
            "singleModelCache": settings.single_model_cache,
            "preloadModels": settings.preload_models,
        }

    @app.post("/v1/asr/fast", response_model=AsrResponse)
    def fast_decode(request: AsrRequest) -> AsrResponse:
        with inference_lock:
            audio, sample_rate = decode_audio_base64(request.audioBase64, request.mimeType)
            clipped, was_clipped, audio_seconds = clip_audio(audio, sample_rate, settings.fast_clip_seconds)
            transcript = transcribe(
                registry,
                model_name=request.model or settings.fast_model,
                audio=clipped,
                sample_rate=sample_rate,
            )
            confidence = estimate_language_confidence(transcript)
            language = confidence_to_language(confidence)
            return AsrResponse(
                text=transcript,
                language=language,
                languageConfidence=confidence,
                jaConfidence=confidence["ja"],
                enConfidence=confidence["en"],
                clipped=was_clipped,
                audioSeconds=audio_seconds,
            )

    @app.post("/v1/asr/en", response_model=AsrResponse)
    def en_decode(request: AsrRequest) -> AsrResponse:
        with inference_lock:
            transcript, audio_seconds = decode_with_single_model(
                registry, request.audioBase64, request.mimeType, request.model or settings.en_model
            )
            confidence = estimate_language_confidence(transcript)
            return AsrResponse(
                text=transcript,
                language="en",
                languageConfidence=confidence,
                jaConfidence=confidence["ja"],
                enConfidence=confidence["en"],
                clipped=False,
                audioSeconds=audio_seconds,
            )

    @app.post("/v1/asr/ja", response_model=AsrResponse)
    def ja_decode(request: AsrRequest) -> AsrResponse:
        with inference_lock:
            transcript, audio_seconds = decode_with_single_model(
                registry, request.audioBase64, request.mimeType, request.model or settings.ja_model
            )
            confidence = estimate_language_confidence(transcript)
            return AsrResponse(
                text=transcript,
                language="ja",
                languageConfidence=confidence,
                jaConfidence=confidence["ja"],
                enConfidence=confidence["en"],
                clipped=False,
                audioSeconds=audio_seconds,
            )

    @app.post("/v1/asr/mixed", response_model=AsrResponse)
    def mixed_decode(request: AsrRequest) -> AsrResponse:
        with inference_lock:
            audio, sample_rate = decode_audio_base64(request.audioBase64, request.mimeType)
            en_text = transcribe(
                registry,
                model_name=settings.en_model,
                audio=audio,
                sample_rate=sample_rate,
            )
            ja_text = transcribe(
                registry,
                model_name=settings.ja_model,
                audio=audio,
                sample_rate=sample_rate,
            )

            text = merge_mixed_transcripts(ja_text, en_text)
            confidence = estimate_language_confidence(text)
            return AsrResponse(
                text=text,
                language="mixed",
                languageConfidence=confidence,
                jaConfidence=confidence["ja"],
                enConfidence=confidence["en"],
                clipped=False,
                audioSeconds=duration_seconds(audio, sample_rate),
            )

    return app


def decode_with_single_model(
    registry: ModelRegistry, audio_base64: str, mime_type: str, model_name: str
) -> tuple[str, float]:
    audio, sample_rate = decode_audio_base64(audio_base64, mime_type)
    transcript = transcribe(registry, model_name=model_name, audio=audio, sample_rate=sample_rate)
    return transcript, duration_seconds(audio, sample_rate)


def decode_audio_base64(audio_base64: str, mime_type: str | None = None) -> tuple[np.ndarray, int]:
    try:
        raw = base64.b64decode(audio_base64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Invalid audioBase64: {exc}") from exc

    try:
        waveform, sample_rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
    except Exception as exc:  # noqa: BLE001
        try:
            waveform, sample_rate = decode_with_ffmpeg(raw, mime_type)
        except HTTPException:
            raise
        except Exception:  # noqa: BLE001
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported audio payload: {exc}",
            ) from exc

    if waveform.ndim == 2:
        waveform = waveform.mean(axis=1)
    if waveform.size == 0:
        raise HTTPException(status_code=400, detail="Audio payload is empty")
    return waveform.astype("float32"), int(sample_rate)


def decode_with_ffmpeg(raw: bytes, mime_type: str | None) -> tuple[np.ndarray, int]:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise HTTPException(
            status_code=400,
            detail="Unsupported audio payload and ffmpeg is not available for fallback decode",
        )

    input_suffix = suffix_from_mime_type(mime_type)
    with tempfile.NamedTemporaryFile(suffix=input_suffix, delete=False) as src:
        src.write(raw)
        src_path = src.name
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as dst:
        dst_path = dst.name

    try:
        cmd = [
            ffmpeg,
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-i",
            src_path,
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "wav",
            dst_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            stderr = (result.stderr or "").strip()
            detail = stderr[:300] if stderr else f"ffmpeg exited with code {result.returncode}"
            raise HTTPException(status_code=400, detail=f"Unsupported audio payload: {detail}")
        waveform, sample_rate = sf.read(dst_path, dtype="float32", always_2d=False)
        return waveform, int(sample_rate)
    finally:
        try:
            os.remove(src_path)
        except OSError:
            pass
        try:
            os.remove(dst_path)
        except OSError:
            pass


def suffix_from_mime_type(mime_type: str | None) -> str:
    normalized = (mime_type or "").lower().strip()
    if ";" in normalized:
        normalized = normalized.split(";", 1)[0].strip()
    if normalized == "audio/webm":
        return ".webm"
    if normalized == "audio/ogg":
        return ".ogg"
    if normalized in {"audio/mp4", "audio/m4a", "audio/aac"}:
        return ".m4a"
    if normalized == "audio/mpeg":
        return ".mp3"
    if normalized in {"audio/wav", "audio/x-wav"}:
        return ".wav"
    return ".bin"


def clip_audio(audio: np.ndarray, sample_rate: int, seconds: float) -> tuple[np.ndarray, bool, float]:
    audio_seconds = duration_seconds(audio, sample_rate)
    if seconds <= 0:
        return audio, False, audio_seconds
    max_len = int(sample_rate * seconds)
    if audio.shape[0] <= max_len:
        return audio, False, audio_seconds
    return audio[:max_len], True, audio_seconds


def duration_seconds(audio: np.ndarray, sample_rate: int) -> float:
    if sample_rate <= 0:
        return 0.0
    return round(float(audio.shape[0] / sample_rate), 3)


def transcribe(registry: ModelRegistry, model_name: str, audio: np.ndarray, sample_rate: int) -> str:
    model = registry.get(model_name)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        sf.write(tmp_path, audio, sample_rate, format="WAV")
        output = call_model_transcribe(model, tmp_path)
        return normalize_transcription(output)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"ASR transcription failed: {exc}") from exc
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def call_model_transcribe(model: ASRModel, audio_path: str) -> Any:
    attempts = (
        lambda: model.transcribe(paths2audio_files=[audio_path], batch_size=1),
        lambda: model.transcribe(audio=[audio_path], batch_size=1),
        lambda: model.transcribe([audio_path], batch_size=1),
    )

    errors: list[str] = []
    for attempt in attempts:
        try:
            return attempt()
        except TypeError as exc:
            errors.append(str(exc))
            continue

    joined = " | ".join(errors) if errors else "unknown signature mismatch"
    raise TypeError(f"ASR transcribe signature mismatch: {joined}")


def normalize_transcription(output: Any) -> str:
    if isinstance(output, list) and output:
        first = output[0]
        if isinstance(first, str):
            return first.strip()
        if isinstance(first, dict):
            if isinstance(first.get("text"), str):
                return first["text"].strip()
        if hasattr(first, "text") and isinstance(first.text, str):
            return first.text.strip()
        return str(first).strip()

    if isinstance(output, str):
        return output.strip()

    return str(output).strip()


def merge_mixed_transcripts(ja_text: str, en_text: str) -> str:
    ja = ja_text.strip()
    en = en_text.strip()
    if ja and en:
        if ja == en:
            return ja
        return f"{ja}\n{en}"
    if ja:
        return ja
    if en:
        return en
    return ""


def estimate_language_confidence(text: str) -> dict[Literal["ja", "en"], float]:
    stripped = text.strip()
    if not stripped:
        return {"ja": 0.5, "en": 0.5}

    ja_chars = len([c for c in stripped if is_japanese_char(c)])
    latin_chars = len([c for c in stripped if ("a" <= c.lower() <= "z")])

    if ja_chars == 0 and latin_chars == 0:
        return {"ja": 0.5, "en": 0.5}

    total = max(1, ja_chars + latin_chars)
    ja_ratio = ja_chars / total
    en_ratio = latin_chars / total

    if ja_ratio >= 0.85:
        return {"ja": 0.9, "en": 0.1}
    if en_ratio >= 0.85:
        return {"ja": 0.1, "en": 0.9}
    if ja_ratio >= 0.6:
        return {"ja": 0.78, "en": 0.22}
    if en_ratio >= 0.6:
        return {"ja": 0.22, "en": 0.78}
    return {"ja": 0.5, "en": 0.5}


def confidence_to_language(confidence: dict[Literal["ja", "en"], float]) -> Language:
    if confidence["ja"] >= 0.75 and confidence["ja"] > confidence["en"]:
        return "ja"
    if confidence["en"] >= 0.75 and confidence["en"] > confidence["ja"]:
        return "en"
    return "mixed"


def is_japanese_char(char: str) -> bool:
    code = ord(char)
    return (
        0x3040 <= code <= 0x30FF  # Hiragana + Katakana
        or 0x4E00 <= code <= 0x9FFF  # CJK Unified Ideographs
        or 0xFF66 <= code <= 0xFF9D  # Half-width Katakana
    )


def resolve_map_location(device: str) -> str:
    normalized = device.strip().lower()
    if normalized in {"cpu", "cuda"}:
        return normalized
    if normalized in {"auto", ""}:
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:  # noqa: BLE001
            return "cpu"
    return "cpu"


def maybe_empty_cuda_cache() -> None:
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        return


def model_device_name(model: ASRModel) -> str:
    try:
        first_parameter = next(model.parameters())
    except Exception:  # noqa: BLE001
        return "unknown"
    return str(first_parameter.device)
