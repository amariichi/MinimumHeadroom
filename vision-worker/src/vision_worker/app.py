"""FastAPI HTTP service exposing the rolling visual memory.

Stable endpoints (consumed by the agent skill and the alert layer):
  GET  /healthz            liveness + which model backend is active
  GET  /latest             most recent observation
  GET  /previous           second most recent observation
  GET  /diffs?n=50         rolling window of recent change observations
  GET  /search?q=...       substring search over OCR text + overview
  GET  /frame/{id}         original full-resolution JPEG for accurate re-reads
  GET  /metrics            counts + pipeline statistics
  POST /ingest             accept one frame (multipart "image") for processing
  POST /watches            register an alert watch (alerting itself is M5)
  GET  /watches            list registered watches
"""

from __future__ import annotations

import os
import threading
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import __version__
from .alerts import build_alert_sink, make_alert_text
from .capture import build_capture_source
from .config import load_settings
from .db import VisionDB
from .model_client import build_model_client
from .perception import PerceptionLoop, decide_start
from .pipeline import build_pipeline
from .store import FrameStore
from .vram import free_vram_mb
from .vram import model_healthy as vram_model_healthy
from .watches import Watch, WatchRegistry

#: Surfaced anywhere a user might mistake this for a safety device.
DISCLAIMER = (
    "Informational/assistive only. This camera pipeline samples slowly and runs "
    "over the network, so it must not be relied on for safety-critical alerts "
    "such as street crossing or driving."
)


class WatchIn(BaseModel):
    name: str = Field(min_length=1)
    rule: str = Field(min_length=1)
    kind: Literal["keyword", "enum"] = "keyword"


def create_app() -> FastAPI:
    settings = load_settings()
    db = VisionDB(settings.db_path)
    store = FrameStore(settings.cache_dir, thumb_max=settings.thumb_max)
    model_client = build_model_client(settings)
    registry = WatchRegistry()
    sink = build_alert_sink(settings)

    def _on_observation(obs) -> None:
        for fired in registry.evaluate(obs):
            sink.notify(make_alert_text(fired, obs), fired.name)

    pipeline = build_pipeline(settings, db, store, model_client, on_observation=_on_observation)

    pipeline_lock = threading.Lock()
    capture_source = build_capture_source(settings)
    perception = (
        PerceptionLoop(pipeline, capture_source, settings.capture_interval_ms, pipeline_lock)
        if capture_source is not None
        else None
    )

    app = FastAPI(title="vision-worker", version=__version__)
    app.state.settings = settings
    app.state.db = db
    app.state.pipeline = pipeline
    app.state.watches = registry
    app.state.perception = perception

    @app.get("/healthz")
    def healthz() -> dict:
        return {
            "ok": True,
            "version": __version__,
            "model_backend": settings.model_backend,
            "model": model_client.name,
        }

    @app.get("/latest")
    def latest() -> dict:
        record = db.latest()
        if record is None:
            raise HTTPException(status_code=404, detail="no observations yet")
        return record

    @app.get("/previous")
    def previous() -> dict:
        record = db.previous()
        if record is None:
            raise HTTPException(status_code=404, detail="no previous observation")
        return record

    @app.get("/diffs")
    def diffs(n: int = 50) -> dict:
        n = min(max(n, 1), 500)
        return {"changes": db.recent_changes(n)}

    @app.get("/search")
    def search(q: str) -> dict:
        return {"query": q, "results": db.search(q)}

    @app.get("/frame/{frame_id}")
    def frame(frame_id: int):
        path = db.frame_path(frame_id)
        if not path or not os.path.exists(path):
            raise HTTPException(status_code=404, detail="frame not found")
        return FileResponse(path, media_type="image/jpeg")

    @app.get("/metrics")
    def metrics() -> dict:
        return {"counts": db.counts(), "pipeline": pipeline.stats.as_dict()}

    @app.post("/ingest")
    async def ingest(image: UploadFile = File(...)) -> dict:
        data = await image.read()
        if not data:
            raise HTTPException(status_code=400, detail="empty upload")
        with pipeline_lock:
            obs = pipeline.process_frame(data)
        if obs is None:
            return {"changed": False}
        record = db.latest()
        return {"changed": True, **(record or obs.as_dict())}

    @app.post("/flush")
    def flush() -> dict:
        """Commit any open temporal-voting window (useful when VISION_VOTE_K > 1
        and frames arrive one at a time over /ingest)."""
        with pipeline_lock:
            obs = pipeline.flush()
        if obs is None:
            return {"flushed": False}
        record = db.latest()
        return {"flushed": True, **(record or obs.as_dict())}

    @app.post("/capture")
    def capture(full: int = 0, store: int = 0):
        """Mode A (on-demand): grab one fresh frame now and return the JPEG so the
        agent can read it with its own vision. No model/GPU is used unless
        store=1. `full` (full-resolution) is honored once the M12 camera is wired
        (M3)."""
        if capture_source is None:
            raise HTTPException(status_code=503, detail="no camera configured (set VISION_CAMERA_URL)")
        try:
            frame = capture_source.capture()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"camera capture failed: {exc}") from exc
        if not frame:
            raise HTTPException(status_code=503, detail="camera returned no frame")
        if store:
            with pipeline_lock:
                pipeline.process_frame(frame)
        return Response(content=frame, media_type="image/jpeg")

    @app.post("/perception/start")
    def perception_start() -> dict:
        """Mode B (ambient watching): start the continuous loop. Gated by the
        prohibition lock and by free VRAM; the worker never stops another process
        itself — on a conflict it reports so the agent can confirm with the user."""
        if perception is None:
            return {"started": False, "reason": "no_camera"}
        if perception.is_running():
            return {"started": True, "reason": "already_running"}
        backend = settings.model_backend
        healthy = vram_model_healthy(settings.model_url) if backend == "diffusiongemma" else True
        decision = decide_start(
            locked=settings.perception_lock,
            backend=backend,
            model_is_healthy=healthy,
            free_vram_mb=free_vram_mb(),
            needed_vram_mb=settings.model_vram_mb,
        )
        if not decision.get("can_start"):
            return {"started": False, **decision, "disclaimer": DISCLAIMER}
        perception.start()
        return {"started": True, "reason": "ok"}

    @app.post("/perception/stop")
    def perception_stop() -> dict:
        if perception is not None:
            perception.stop()
        return {"running": False}

    @app.get("/perception/status")
    def perception_status() -> dict:
        running = perception.is_running() if perception is not None else False
        backend = settings.model_backend
        healthy = vram_model_healthy(settings.model_url) if backend == "diffusiongemma" else True
        free = free_vram_mb()
        if settings.perception_lock:
            capability = "locked"
        elif running:
            capability = "running"
        elif backend != "diffusiongemma" or healthy:
            capability = "available"
        elif free is not None and free >= settings.model_vram_mb:
            capability = "needs_model_start"
        else:
            capability = "needs_vram"
        return {
            "running": running,
            "locked": settings.perception_lock,
            "camera_configured": capture_source is not None,
            "model_backend": backend,
            "model_healthy": healthy,
            "free_vram_mb": free,
            "needed_vram_mb": settings.model_vram_mb,
            "capability": capability,
        }

    @app.post("/watches")
    def add_watch(watch: WatchIn) -> dict:
        registry.add(Watch(name=watch.name, rule=watch.rule, kind=watch.kind))
        return {
            "registered": {"name": watch.name, "rule": watch.rule, "kind": watch.kind},
            "active": len(registry),
            "disclaimer": DISCLAIMER,
        }

    @app.get("/watches")
    def list_watches() -> dict:
        return {"watches": registry.list(), "disclaimer": DISCLAIMER}

    return app
