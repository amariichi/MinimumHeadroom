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
  POST /correction         record a human correction bound to the current scene
  GET  /corrections        list still-active human corrections
  DELETE /corrections      clear all human corrections
  POST /watches            register an alert watch (alerting itself is M5)
  GET  /watches            list registered watches
"""

from __future__ import annotations

import itertools
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field

from . import __version__
from .alerts import (
    AsyncAlertSink,
    ChangeNarrator,
    LastSpokenAlertSink,
    build_alert_sink,
    make_alert_text,
)
from .capture import build_capture_source
from .config import load_settings
from .corrections import make_correction, partition_corrections
from .db import VisionDB
from .model_client import build_model_client
from .perception import PerceptionLoop, decide_start
from .pipeline import build_pipeline
from .situation import (
    compose_situation,
    render_situation_presence_line,
    render_situation_text,
    salience_reasons,
    situation_state_token,
)
from .store import FrameStore
from .summarize import build_summarizer, consolidate_closed_bands, situation_summaries
from .vram import free_vram_mb
from .vram import model_healthy as vram_model_healthy
from .watches import Watch, WatchRegistry

#: Surfaced anywhere a user might mistake this for a safety device.
DISCLAIMER = (
    "Informational/assistive only. This camera pipeline samples slowly and runs "
    "over the network, so it must not be relied on for safety-critical alerts "
    "such as street crossing or driving."
)

logger = logging.getLogger(__name__)


class WatchIn(BaseModel):
    name: str = Field(min_length=1)
    rule: str = Field(min_length=1)
    kind: Literal["keyword", "enum"] = "keyword"


class NarrateIn(BaseModel):
    on: bool


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


class CorrectionIn(BaseModel):
    text: str = Field(min_length=1)
    # Optional override of the wall-clock cap; falls back to VISION_CORRECTION_TTL_S.
    ttl_s: float | None = None


def create_app() -> FastAPI:
    settings = load_settings()
    db = VisionDB(settings.db_path)
    store = FrameStore(settings.cache_dir, thumb_max=settings.thumb_max)
    model_client = build_model_client(settings)
    registry = WatchRegistry()
    # Deliver alerts off the perception loop: the bridge round-trip + TTS synth
    # is slow, and doing it inline stalls observation (the cause of the laggy,
    # sporadic ambient narration). Only wrap when a real voice webhook is active.
    raw_sink = build_alert_sink(settings)
    last_spoken_sink = LastSpokenAlertSink(raw_sink)
    sink = (
        AsyncAlertSink(last_spoken_sink)
        if settings.alert_enabled and settings.alert_webhook
        else last_spoken_sink
    )
    narrator = ChangeNarrator(
        sink,
        enabled=settings.narrate_changes,
        min_interval_s=settings.narrate_min_interval_ms / 1000.0,
    )

    def _on_observation(obs) -> None:
        for fired in registry.evaluate(obs):
            sink.notify(make_alert_text(fired, obs), fired.name)
        narrator.consider(obs)

    pipeline = build_pipeline(settings, db, store, model_client, on_observation=_on_observation)
    summarizer = build_summarizer(settings)

    def _consolidate_when_idle() -> None:
        consolidate_closed_bands(db, summarizer, datetime.now(timezone.utc))

    pipeline_lock = threading.Lock()
    capture_source = build_capture_source(settings)
    perception = (
        PerceptionLoop(
            pipeline,
            capture_source,
            settings.capture_interval_ms,
            pipeline_lock,
            idle_interval_ms=settings.idle_interval_ms,
            burst_frames=settings.burst_frames,
            idle_callback=_consolidate_when_idle,
        )
        if capture_source is not None
        else None
    )

    app = FastAPI(title="vision-worker", version=__version__)
    app.state.settings = settings
    app.state.db = db
    app.state.pipeline = pipeline
    app.state.watches = registry
    app.state.perception = perception
    app.state.narrator = narrator
    app.state.last_spoken_alerts = last_spoken_sink

    # Human corrections live only in memory: a correction is a claim about the
    # live scene, so a restart (which has not re-observed it) should drop them
    # rather than re-apply a stale note. Guarded by a lock because FastAPI runs
    # sync endpoints in a threadpool.
    corrections: list[dict] = []
    corrections_lock = threading.Lock()
    correction_seq = itertools.count(1)
    correction_retirements = {"change": 0, "drift": 0, "ttl": 0}
    app.state.corrections = corrections
    app.state.correction_retirements = correction_retirements
    app.state.situation_state_token = None
    app.state.situation_state_changed_at = None

    def _active_corrections(now: datetime) -> list[dict]:
        with corrections_lock:
            active, retired = partition_corrections(
                list(corrections),
                now=now,
                current_change_at=pipeline.last_change_at,
                current_hash=pipeline.last_visual_hash,
                drift_threshold=settings.correction_hash_drift,
            )
            if retired:
                active_ids = {c["id"] for c in active}
                corrections[:] = [c for c in corrections if c["id"] in active_ids]
                for c in retired:
                    cause = c["retired_cause"]
                    correction_retirements[cause] += 1
                    logger.info(
                        "correction retired id=%s cause=%s lifetime_seconds=%s",
                        c.get("id"),
                        cause,
                        c.get("lifetime_seconds"),
                    )
            return active

    def _last_narration(now: datetime) -> dict | None:
        last = last_spoken_sink.last_spoken
        if last is None:
            return None
        text, at = last
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        age_seconds = max(0, int((now - at).total_seconds()))
        return {"text": text, "at": at.isoformat(), "age_seconds": age_seconds}

    def _correction_advisory() -> str | None:
        """The freshest active correction text to advise the VLM with (M5b).

        None unless VISION_CORRECTION_TO_MODEL is on and a correction is live, so
        the captioner is biased only when explicitly opted in."""
        if not settings.correction_to_model:
            return None
        active = _active_corrections(datetime.now(timezone.utc))
        return active[0]["text"] if active else None

    # The loop runs the model via the pipeline; give it the advisory provider so
    # an active correction can reach the captioner itself when opted in.
    pipeline.correction_provider = _correction_advisory

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
        return {
            "counts": db.counts(),
            "pipeline": pipeline.stats.as_dict(),
            "corrections": {
                "retired_by_change": correction_retirements["change"],
                "retired_by_drift": correction_retirements["drift"],
                "retired_by_ttl": correction_retirements["ttl"],
            },
        }

    @app.get("/situation")
    def situation(format: str = "json", since: str | None = None):
        """Cheap, read-only situational digest for the conversational LLM.

        Returns what the camera sees now, how long that view has been stable,
        and a multi-resolution history (tiered summaries). Runs no vision model,
        so it is safe to read on every conversational turn. With `?format=text`
        it returns a compact Japanese text block ready to inject into the
        conversational agent's context (Design B)."""
        now = datetime.now(timezone.utc)
        observing = perception.is_running() if perception is not None else False
        last_observed_at = (
            perception.last_observed_at if perception is not None else None
        )
        # The camera is "stale" if no fresh frame has arrived for several poll
        # cycles while the loop is meant to be observing (unplugged/unreachable).
        stale_after_s = max(15.0, 3 * settings.idle_interval_ms / 1000.0)
        digest = compose_situation(
            now=now,
            observing=observing,
            latest=db.latest(),
            last_change_at=pipeline.last_change_at,
            last_observed_at=last_observed_at,
            recent=db.recent_changes(settings.situation_recent_n),
            summaries=[],
            stale_after_s=stale_after_s,
        )
        # "Idle" = the loop is running and the scene has held still at least one
        # slow-poll cycle (not mid-burst). Summarization (the LLM text call) is
        # gated to idle so it never competes with real-time recognition.
        current = digest["current"]
        stable = current["stable_seconds"] if current else None
        idle = (
            observing
            and stable is not None
            and stable >= settings.idle_interval_ms / 1000.0
        )
        digest["summaries"] = situation_summaries(db, summarizer, now, idle=idle)
        digest["last_narration"] = _last_narration(now)
        active = _active_corrections(now)
        state_token = situation_state_token(digest)
        state_changed_at = app.state.situation_state_changed_at
        if app.state.situation_state_token is None:
            app.state.situation_state_token = state_token
        elif app.state.situation_state_token != state_token:
            app.state.situation_state_token = state_token
            app.state.situation_state_changed_at = now
            state_changed_at = now

        if format == "text":
            watermark = now.isoformat()
            since_dt = _parse_iso(since)
            reasons = salience_reasons(
                digest,
                since=since_dt,
                corrections=active,
                state_changed_at=state_changed_at,
            )
            if since_dt is not None and not reasons:
                text = render_situation_presence_line(digest)
            else:
                text = render_situation_text(digest, corrections=active)
            return PlainTextResponse(text, headers={"X-Situation-Watermark": watermark})
        digest["disclaimer"] = DISCLAIMER
        digest["corrections"] = [
            {
                "id": c["id"],
                "text": c["text"],
                "age_seconds": c["age_seconds"],
                "stale_soon": c["stale_soon"],
            }
            for c in active
        ]
        return digest

    @app.post("/look")
    def look(store: int = 1):
        """On-demand fresh look ("what do you see right now?"): grab one frame
        and run the vision model on it NOW, returning the description, and (by
        default) commit it to the rolling memory so on-demand looks join the same
        timeline the conversational agent and the ambient loop share. Storing goes
        through the normal pipeline, so an unchanged scene adds no duplicate row.
        Pass store=0 for a purely ephemeral peek (no GPU-side commit, no memory).
        A deliberate question always gets a fresh answer even if the scene matched
        the last stored one."""
        if capture_source is None:
            raise HTTPException(status_code=503, detail="no camera configured (set VISION_CAMERA_URL)")
        try:
            frame = capture_source.capture()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"camera capture failed: {exc}") from exc
        if not frame:
            raise HTTPException(status_code=503, detail="camera returned no frame")
        committed = None
        if store:
            with pipeline_lock:
                committed = pipeline.process_frame(frame)
        # Reuse the committed observation when the frame was a real change (one
        # model call); otherwise describe a fresh frame so the answer is never
        # empty just because nothing changed since the last stored frame.
        obs = committed if committed is not None else model_client.observe(frame, None)
        return {
            "overview": obs.overview,
            "ocr_full": obs.ocr_full,
            "is_text": obs.is_text,
            "low_confidence": obs.low_confidence,
            "model": obs.model,
            "latency_ms": obs.latency_ms,
            "disclaimer": DISCLAIMER,
        }

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

    @app.post("/perception/narrate")
    def perception_narrate(body: NarrateIn) -> dict:
        """Turn spoken change-narration on/off at runtime (ambient mode). Only has
        an audible effect when the alert webhook is configured."""
        narrator.enabled = body.on
        return {
            "narrate": narrator.enabled,
            "voice_wired": settings.alert_enabled and bool(settings.alert_webhook),
            "disclaimer": DISCLAIMER,
        }

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
            "narrate": narrator.enabled,
            "voice_wired": settings.alert_enabled and bool(settings.alert_webhook),
            "last_error": perception.last_error if perception is not None else None,
        }

    @app.post("/correction")
    def add_correction(body: CorrectionIn) -> dict:
        """Record a human correction of what the camera reported, bound to the
        CURRENT scene.

        The conversational LLM posts here when the user corrects a camera-derived
        claim (for example: "that's not a red light, it's an ambulance"). The note
        is anchored to the live scene and retired automatically once the scene
        changes, the view drifts, or its cap elapses, so it can never haunt an
        unrelated scene. Rejected with 409 when nothing has been observed yet:
        there is no scene to attach the note to, and it could then only be expired
        by the wall-clock cap, defeating the scene-bound design."""
        if pipeline.last_change_at is None:
            raise HTTPException(
                status_code=409,
                detail="no live scene to attach a correction to (nothing observed yet)",
            )
        text = body.text.strip()
        if not text:
            raise HTTPException(status_code=422, detail="empty correction text")
        latest = db.latest()
        if latest is None:
            raise HTTPException(
                status_code=409,
                detail="no live scene to attach a correction to (nothing observed yet)",
            )
        now = datetime.now(timezone.utc)
        ttl = body.ttl_s if (body.ttl_s and body.ttl_s > 0) else settings.correction_ttl_s
        anchor_change_at = _parse_iso(latest.get("created_at")) or pipeline.last_change_at
        rec = make_correction(
            correction_id=next(correction_seq),
            text=text,
            now=now,
            anchor_change_at=anchor_change_at,
            anchor_hash=pipeline.last_visual_hash,
            ttl_s=ttl,
        )
        stamped = db.stamp_human_note_at_or_before(latest["created_at"], text)
        invalidated = (
            db.delete_summaries_containing(stamped["created_at"]) if stamped is not None else 0
        )
        with corrections_lock:
            corrections.append(rec)
            # Keep only the newest N active notes.
            overflow = len(corrections) - settings.correction_max
            if overflow > 0:
                del corrections[:overflow]
        return {
            "recorded": {"id": rec["id"], "text": rec["text"]},
            "memory": {
                "obs_id": stamped["obs_id"] if stamped is not None else None,
                "invalidated_summaries": invalidated,
            },
            "ttl_s": ttl,
            "disclaimer": DISCLAIMER,
        }

    @app.get("/corrections")
    def list_corrections() -> dict:
        now = datetime.now(timezone.utc)
        active = _active_corrections(now)
        with corrections_lock:
            total = len(corrections)
        return {
            "active": [
                {
                    "id": c["id"],
                    "text": c["text"],
                    "age_seconds": c["age_seconds"],
                    "stale_soon": c["stale_soon"],
                }
                for c in active
            ],
            "total_stored": total,
        }

    @app.delete("/corrections")
    def clear_corrections() -> dict:
        with corrections_lock:
            n = len(corrections)
            corrections.clear()
        return {"cleared": n}

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
