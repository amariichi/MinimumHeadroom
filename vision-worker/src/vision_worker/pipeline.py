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
from typing import Callable

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
    nochange_suppressed: int = 0
    observations_written: int = 0

    def as_dict(self) -> dict:
        return {
            "frames_seen": self.frames_seen,
            "gate_suppressed": self.gate_suppressed,
            "dedup_suppressed": self.dedup_suppressed,
            "nochange_suppressed": self.nochange_suppressed,
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
        on_observation: Callable[[Observation], None] | None = None,
    ) -> None:
        self.db = db
        self.store = store
        self.gate = gate
        self.model_client = model_client
        self.max_changes = max_changes
        self.dedup_threshold = dedup_threshold
        self.vote_k = max(1, vote_k)
        self.on_observation = on_observation
        self.stats = PipelineStats()
        self._prev: PrevState | None = None
        # When the most recent change was committed (a real write, including the
        # first baseline). Drives `stable_seconds` in GET /situation: the current
        # scene has held since this moment. None until the first commit; on a
        # fresh restart the digest falls back to the latest DB row's created_at.
        self.last_change_at: datetime | None = None
        # Perceptual (average) hash of the most recent processed frame, taken
        # from the gate's own computation (no second hash). Anchors human
        # corrections to the live scene so one can be retired once the view
        # drifts, independent of what the model narrates (see corrections.py).
        self.last_visual_hash: int | None = None
        # Open voting window for the current not-yet-committed scene:
        self._pending: list[tuple[Observation, bytes]] = []

    def _is_jitter(self, obs: Observation) -> bool:
        if self._prev is None:
            return False
        if obs.is_text:
            return dedup.is_duplicate(self._prev.ocr_full, obs.ocr_full, self.dedup_threshold)
        return dedup.is_duplicate(self._prev.overview, obs.overview, self.dedup_threshold)

    def _commit(self, obs: Observation, frame_jpeg: bytes) -> Observation | None:
        # The cheap perceptual gate over-fires (lighting, sensor noise, a hand of
        # framing drift). The model is the arbiter: if it says nothing meaningful
        # changed, this is not a change point — drop it like jitter. The very
        # first observation (no prior state) is always kept as the baseline.
        if self._prev is not None and not obs.changed:
            self.stats.nochange_suppressed += 1
            return None
        if self._is_jitter(obs):
            self.stats.dedup_suppressed += 1
            return None
        now_dt = datetime.now(timezone.utc)
        when = now_dt.isoformat()
        full_path, thumb_path, width, height = self.store.save(frame_jpeg)
        frame_id = self.db.insert_frame(
            when, self.gate.last_hash_hex, full_path, thumb_path, width, height
        )
        self.db.insert_observation(frame_id, obs)
        self._prev = PrevState(obs.ocr_full, obs.overview)
        for removed_full, removed_thumb in self.db.prune(self.max_changes):
            self.store.remove(removed_full, removed_thumb)
        self.stats.observations_written += 1
        # Mark the start of the now-current scene so stable_seconds resets here.
        self.last_change_at = now_dt
        if self.on_observation is not None:
            self.on_observation(obs)
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
        # Reuse the gate's own avg-hash (real ChangeGate exposes it); tolerate a
        # gate double that doesn't, leaving the anchor hash unavailable.
        self.last_visual_hash = getattr(self.gate, "last_hash", None)

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


def build_pipeline(settings, db, store, model_client, on_observation=None) -> Pipeline:
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
        on_observation=on_observation,
    )
