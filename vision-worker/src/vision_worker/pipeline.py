"""Perception pipeline: gate -> (vote) -> dedup -> store -> database.

`process_frame` is the single entry point used by both the HTTP `/ingest`
endpoint and the offline directory-replay tool. With temporal voting
(`vote_k > 1`), a changed frame opens a "voting window" for the new scene; while
the gate reports that scene steady, subsequent frames add votes until `vote_k`
candidates are collected, at which point they are reconciled into one
observation and committed. With `vote_k == 1` the behavior is the immediate
"changed -> write" path. Call `flush()` at end of stream to commit a window that
never reached `vote_k`.

`process_frame` returns the `Observation` committed as a result of that frame
(possibly the *previous* scene's, when a change flushes a still-open window), or
`None` when nothing was committed.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from . import dedup, vote
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
        vote_k: int = 1,
    ) -> None:
        self.db = db
        self.store = store
        self.gate = gate
        self.model_client = model_client
        self.max_changes = max_changes
        self.dedup_threshold = dedup_threshold
        self.vote_k = max(1, vote_k)
        self.stats = PipelineStats()
        self._prev: PrevState | None = None
        # Open voting window for the current not-yet-committed scene:
        self._pending: list[tuple[Observation, bytes]] = []

    def _is_jitter(self, obs: Observation) -> bool:
        if self._prev is None:
            return False
        if obs.is_text:
            return dedup.is_duplicate(self._prev.ocr_full, obs.ocr_full, self.dedup_threshold)
        return dedup.is_duplicate(self._prev.overview, obs.overview, self.dedup_threshold)

    def _commit(self, obs: Observation, frame_jpeg: bytes) -> Observation | None:
        if self._is_jitter(obs):
            self.stats.dedup_suppressed += 1
            return None
        when = datetime.now(timezone.utc).isoformat()
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

    def flush(self) -> Observation | None:
        """Reconcile and commit the open voting window, if any."""
        if not self._pending:
            return None
        candidates = [obs for obs, _ in self._pending]
        frames = [frame for _, frame in self._pending]
        merged, rep_idx = vote.reconcile(candidates)
        self._pending = []
        return self._commit(merged, frames[rep_idx])

    def process_frame(self, frame_jpeg: bytes, captured_at: str | None = None) -> Observation | None:
        self.stats.frames_seen += 1
        changed = self.gate.is_changed(frame_jpeg)

        if changed:
            # The scene changed: commit whatever window was still open, then
            # open a fresh window for the new scene.
            committed = self.flush()
            obs = self.model_client.observe(frame_jpeg, self._prev)
            self._pending = [(obs, frame_jpeg)]
            if len(self._pending) >= self.vote_k:
                return self.flush() or committed
            return committed

        # Steady scene: add a vote if a window is open and not yet full.
        if self._pending and len(self._pending) < self.vote_k:
            obs = self.model_client.observe(frame_jpeg, self._prev)
            self._pending.append((obs, frame_jpeg))
            if len(self._pending) >= self.vote_k:
                return self.flush()
            return None

        self.stats.gate_suppressed += 1
        return None


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
        vote_k=settings.vote_k,
    )
