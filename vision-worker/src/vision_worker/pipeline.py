"""Perception pipeline: gate -> model -> dedup -> store -> database.

`process_frame` is the single entry point used by both the HTTP `/ingest`
endpoint and the offline directory-replay tool. It returns the written
`Observation` when a frame produced a new memory entry, or `None` when the
frame was suppressed (unchanged by the gate, or text duplicating the previous
record).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from . import dedup
from .db import VisionDB
from .gate import ChangeGate
from .model_client import VisionModelClient
from .records import Observation, PrevState
from .store import FrameStore


@dataclass
class PipelineStats:
    frames_seen: int = 0
    gate_suppressed: int = 0
    dedup_suppressed: int = 0
    observations_written: int = 0

    def as_dict(self) -> dict:
        return {
            "frames_seen": self.frames_seen,
            "gate_suppressed": self.gate_suppressed,
            "dedup_suppressed": self.dedup_suppressed,
            "observations_written": self.observations_written,
        }


class Pipeline:
    def __init__(
        self,
        db: VisionDB,
        store: FrameStore,
        gate: ChangeGate,
        model_client: VisionModelClient,
        max_changes: int = 50,
        dedup_threshold: float = 0.92,
    ) -> None:
        self.db = db
        self.store = store
        self.gate = gate
        self.model_client = model_client
        self.max_changes = max_changes
        self.dedup_threshold = dedup_threshold
        self.stats = PipelineStats()
        self._prev: PrevState | None = None

    def _is_jitter(self, obs: Observation) -> bool:
        """True when this changed frame's text essentially repeats the previous
        record (OCR jitter rather than a real change)."""
        if self._prev is None:
            return False
        if obs.is_text:
            return dedup.is_duplicate(self._prev.ocr_full, obs.ocr_full, self.dedup_threshold)
        return dedup.is_duplicate(self._prev.overview, obs.overview, self.dedup_threshold)

    def process_frame(self, frame_jpeg: bytes, captured_at: str | None = None) -> Observation | None:
        self.stats.frames_seen += 1

        if not self.gate.is_changed(frame_jpeg):
            self.stats.gate_suppressed += 1
            return None

        obs = self.model_client.observe(frame_jpeg, self._prev)

        if self._is_jitter(obs):
            self.stats.dedup_suppressed += 1
            return None

        when = captured_at or datetime.now(timezone.utc).isoformat()
        full_path, thumb_path, width, height = self.store.save(frame_jpeg)
        frame_id = self.db.insert_frame(
            when, self.gate.last_hash_hex, full_path, thumb_path, width, height
        )
        self.db.insert_observation(frame_id, obs)
        self._prev = PrevState(obs.ocr_full, obs.overview)

        for removed_full, removed_thumb in self.db.prune(self.max_changes):
            self.store.remove(removed_full, removed_thumb)

        self.stats.observations_written += 1
        return obs


def build_pipeline(settings, db, store, model_client) -> Pipeline:
    """Construct a Pipeline with a gate configured from settings."""
    gate = ChangeGate(
        hamming_threshold=settings.gate_hamming,
        pixel_diff_threshold=settings.gate_pixeldiff,
        steady_frames=settings.steady_frames,
    )
    return Pipeline(
        db=db,
        store=store,
        gate=gate,
        model_client=model_client,
        max_changes=settings.max_changes,
    )
