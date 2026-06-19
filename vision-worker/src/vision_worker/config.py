"""Environment-driven settings for the vision-worker.

Every knob has a stable `VISION_*` environment variable and a sensible default
so the worker runs with zero configuration in mock mode.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass
class Settings:
    host: str
    port: int
    model_backend: str  # "mock" | "diffusiongemma"
    model_url: str
    model_name: str
    guided_decoding: bool
    cache_dir: str
    db_path: str
    frame_dir: str | None
    camera_url: str | None
    capture_interval_ms: int
    vote_k: int
    max_changes: int
    gate_hamming: int
    gate_pixeldiff: float
    steady_frames: int
    thumb_max: int
    alert_enabled: bool
    alert_webhook: str | None
    perception_lock: bool
    model_vram_mb: int


def load_settings() -> Settings:
    cache_dir = os.path.expanduser(
        os.getenv("VISION_CACHE_DIR", "~/.cache/minimum-headroom/vision")
    )
    db_path = os.getenv("VISION_DB_PATH") or os.path.join(cache_dir, "vision.db")
    return Settings(
        host=os.getenv("VISION_HOST", "127.0.0.1"),
        port=_int("VISION_PORT", 8095),
        model_backend=os.getenv("VISION_MODEL_BACKEND", "mock").strip().lower(),
        model_url=os.getenv("VISION_MODEL_URL", "http://127.0.0.1:8000/v1"),
        model_name=os.getenv(
            "VISION_MODEL_NAME", "nvidia/diffusiongemma-26B-A4B-it-NVFP4"
        ),
        guided_decoding=_bool("VISION_GUIDED_DECODING", False),
        cache_dir=cache_dir,
        db_path=db_path,
        frame_dir=os.getenv("VISION_FRAME_DIR") or None,
        camera_url=os.getenv("VISION_CAMERA_URL") or None,
        capture_interval_ms=_int("VISION_CAPTURE_INTERVAL_MS", 1500),
        vote_k=_int("VISION_VOTE_K", 1),
        max_changes=_int("VISION_MAX_CHANGES", 50),
        gate_hamming=_int("VISION_GATE_HAMMING", 6),
        gate_pixeldiff=_float("VISION_GATE_PIXELDIFF", 0.06),
        steady_frames=_int("VISION_STEADY_FRAMES", 2),
        thumb_max=_int("VISION_THUMB_MAX", 256),
        alert_enabled=_bool("VISION_ALERT_ENABLED", False),
        alert_webhook=os.getenv("VISION_ALERT_WEBHOOK") or None,
        perception_lock=_bool("VISION_PERCEPTION_LOCK", False),
        model_vram_mb=_int("VISION_MODEL_VRAM_MB", 24000),
    )
