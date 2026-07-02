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
    output_lang: str  # language for spoken fields (overview/change_from_prev)
    cache_dir: str
    db_path: str
    frame_dir: str | None
    camera_url: str | None
    camera_rotate: int  # degrees CCW applied to network frames (M12 USB-down = 90)
    camera_resolve_device_id: str | None  # re-resolve snapshot URL after failures
    camera_auth_token: str | None  # X-Headroom-Auth for /snapshot (device token)
    camera_rediscover_after_failures: int
    capture_interval_ms: int  # ACTIVE/burst cadence (fast, just after a change)
    idle_interval_ms: int  # slow cadence when the scene is static (fewer fetches)
    burst_frames: int  # frames to stay at the fast cadence after a change
    narrate_changes: bool  # speak a short line on each salient committed change
    narrate_min_interval_ms: int  # rate-limit between spoken change lines
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
    situation_recent_n: int  # how many raw recent changes GET /situation returns
    summary_enabled: bool  # build hierarchical summaries (reuses the loaded VLM)
    summary_max_tokens: int  # output cap for one summarization call
    correction_ttl_s: float  # human-correction wall-clock cap (last-resort expiry)
    correction_hash_drift: int  # avg-hash Hamming distance that retires a correction
    correction_max: int  # how many active corrections to keep (newest wins)
    correction_to_model: bool  # feed active corrections into the VLM prompt (M5b, opt-in)
    debug_prompt: bool  # log outbound VLM prompt text for live validation/debugging


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
        output_lang=os.getenv("VISION_OUTPUT_LANG", "en").strip().lower(),
        cache_dir=cache_dir,
        db_path=db_path,
        frame_dir=os.getenv("VISION_FRAME_DIR") or None,
        camera_url=os.getenv("VISION_CAMERA_URL") or None,
        camera_rotate=_int("VISION_CAMERA_ROTATE", 90),
        camera_resolve_device_id=os.getenv("VISION_CAMERA_RESOLVE_DEVICE_ID") or None,
        camera_auth_token=(os.getenv("VISION_CAMERA_AUTH_TOKEN") or os.getenv("MH_FACE_AUTH_TOKEN") or None),
        camera_rediscover_after_failures=_int("VISION_CAMERA_REDISCOVER_AFTER_FAILURES", 5),
        capture_interval_ms=_int("VISION_CAPTURE_INTERVAL_MS", 1500),
        idle_interval_ms=_int("VISION_IDLE_INTERVAL_MS", 5000),
        burst_frames=_int("VISION_BURST_FRAMES", 4),
        narrate_changes=_bool("VISION_NARRATE_CHANGES", False),
        narrate_min_interval_ms=_int("VISION_NARRATE_MIN_INTERVAL_MS", 4000),
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
        situation_recent_n=_int("VISION_SITUATION_RECENT_N", 8),
        summary_enabled=_bool("VISION_SUMMARY_ENABLED", True),
        summary_max_tokens=_int("VISION_SUMMARY_MAX_TOKENS", 80),
        correction_ttl_s=_float("VISION_CORRECTION_TTL_S", 120.0),
        correction_hash_drift=_int("VISION_CORRECTION_HASH_DRIFT", 8),
        correction_max=_int("VISION_CORRECTION_MAX", 3),
        correction_to_model=_bool("VISION_CORRECTION_TO_MODEL", False),
        debug_prompt=_bool("VISION_DEBUG_PROMPT", False),
    )
