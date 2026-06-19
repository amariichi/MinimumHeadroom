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
from typing import Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import __version__
from .config import load_settings
from .db import VisionDB
from .model_client import build_model_client
from .pipeline import build_pipeline
from .store import FrameStore

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
    pipeline = build_pipeline(settings, db, store, model_client)

    app = FastAPI(title="vision-worker", version=__version__)
    app.state.settings = settings
    app.state.db = db
    app.state.pipeline = pipeline
    app.state.watches = []

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
        obs = pipeline.process_frame(data)
        if obs is None:
            return {"changed": False}
        record = db.latest()
        return {"changed": True, **(record or obs.as_dict())}

    @app.post("/flush")
    def flush() -> dict:
        """Commit any open temporal-voting window (useful when VISION_VOTE_K > 1
        and frames arrive one at a time over /ingest)."""
        obs = pipeline.flush()
        if obs is None:
            return {"flushed": False}
        record = db.latest()
        return {"flushed": True, **(record or obs.as_dict())}

    @app.post("/watches")
    def add_watch(watch: WatchIn) -> dict:
        entry = {"name": watch.name, "rule": watch.rule, "kind": watch.kind}
        app.state.watches.append(entry)
        return {
            "registered": entry,
            "active": len(app.state.watches),
            "disclaimer": DISCLAIMER,
        }

    @app.get("/watches")
    def list_watches() -> dict:
        return {"watches": app.state.watches, "disclaimer": DISCLAIMER}

    return app
