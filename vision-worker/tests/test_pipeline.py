from __future__ import annotations

import os
import uuid

from vision_worker.db import VisionDB
from vision_worker.gate import ChangeGate
from vision_worker.model_client import MockModelClient
from vision_worker.pipeline import Pipeline
from vision_worker.records import Observation
from vision_worker.store import FrameStore


class _AlwaysChanged:
    """Gate stub that reports every frame as changed (isolates dedup/prune)."""

    def is_changed(self, frame_jpeg: bytes) -> bool:
        return True

    @property
    def last_hash_hex(self) -> str:
        return "stub"


class _UniqueModel:
    """Model stub returning a unique, low-similarity observation per call.

    Used to isolate prune behavior from the OCR-jitter dedup heuristic.
    """

    name = "unique-stub"

    def observe(self, frame_jpeg: bytes, prev) -> Observation:
        token = uuid.uuid4().hex
        return Observation(
            is_text=True,
            ocr_full=token,
            overview=token[:8],
            change_from_prev="changed",
            model=self.name,
        )


def _pipeline(tmp_path, gate=None, max_changes=50):
    db = VisionDB(str(tmp_path / "v.db"))
    store = FrameStore(str(tmp_path / "cache"))
    gate = gate or ChangeGate()
    pipeline = Pipeline(db, store, gate, MockModelClient(), max_changes=max_changes)
    return pipeline, db


def test_identical_frames_yield_one_observation(tmp_path, make_frame):
    pipeline, db = _pipeline(tmp_path)
    frame = make_frame(0x0F0F)
    for _ in range(100):
        pipeline.process_frame(frame)
    assert db.counts()["observations"] == 1
    assert pipeline.stats.gate_suppressed == 99
    assert pipeline.stats.observations_written == 1


def test_alternating_scenes_are_all_changes(tmp_path, make_frame):
    pipeline, db = _pipeline(tmp_path)
    a = make_frame(0x000F)
    b = make_frame(0xF000)
    for frame in [a, b] * 5:
        pipeline.process_frame(frame)
    assert db.counts()["observations"] == 10


def test_rolling_window_prunes_to_fifty(tmp_path, make_frame):
    db = VisionDB(str(tmp_path / "v.db"))
    store = FrameStore(str(tmp_path / "cache"))
    pipeline = Pipeline(db, store, _AlwaysChanged(), _UniqueModel(), max_changes=50)
    for seed in range(1, 61):  # 60 frames -> 60 unique observations
        pipeline.process_frame(make_frame(seed))
    assert db.counts()["observations"] == 50
    assert len(db.recent_changes(100)) == 50
    frames_on_disk = os.listdir(tmp_path / "cache" / "frames")
    assert len(frames_on_disk) == 50


def test_scene_frames_route_as_non_text(tmp_path, make_scene):
    pipeline, db = _pipeline(tmp_path, gate=_AlwaysChanged())
    pipeline.process_frame(make_scene(1))
    latest = db.latest()
    assert latest["is_text"] is False
    assert latest["ocr_full"] == ""
