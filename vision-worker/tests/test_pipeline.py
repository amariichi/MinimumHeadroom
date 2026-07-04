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

    def observe(self, frame_jpeg: bytes, prev, correction=None) -> Observation:
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


class _ScriptedGate:
    """Gate returning a preset changed/steady sequence (for voting tests)."""

    def __init__(self, changes):
        self.changes = list(changes)
        self.i = 0

    def is_changed(self, frame_jpeg: bytes) -> bool:
        c = self.changes[self.i]
        self.i += 1
        return c

    @property
    def last_hash_hex(self) -> str:
        return f"h{self.i}"


class _ScriptedModel:
    """Model returning preset (ocr, is_text) observations in order."""

    name = "scripted"

    def __init__(self, scripted):
        self.scripted = list(scripted)
        self.i = 0

    def observe(self, frame_jpeg: bytes, prev, correction=None):
        ocr, is_text = self.scripted[self.i]
        self.i += 1
        return Observation(
            is_text=is_text,
            ocr_full=ocr if is_text else "",
            overview="document" if is_text else ocr,
            change_from_prev="c",
            model=self.name,
        )


def test_voting_reconciles_a_steady_window(tmp_path, make_frame):
    db = VisionDB(str(tmp_path / "v.db"))
    store = FrameStore(str(tmp_path / "cache"))
    gate = _ScriptedGate([True, False, False])  # one change, then steady
    model = _ScriptedModel(
        [
            ("Problem 12 solve for x", True),
            ("Problem 12 solve for x", True),
            ("Problrm l2 zolve fnr x", True),  # outlier voted down
        ]
    )
    pipeline = Pipeline(db, store, gate, model, vote_k=3)
    for _ in range(3):
        pipeline.process_frame(make_frame(1))
    assert db.counts()["observations"] == 1
    assert db.latest()["ocr_full"] == "Problem 12 solve for x"
    assert pipeline.stats.observations_written == 1


def test_change_before_k_flushes_partial_window(tmp_path, make_frame):
    db = VisionDB(str(tmp_path / "v.db"))
    store = FrameStore(str(tmp_path / "cache"))
    gate = _ScriptedGate([True, True])  # second frame is a new scene
    model = _ScriptedModel([("scene one here", False), ("scene two there", False)])
    pipeline = Pipeline(db, store, gate, model, vote_k=3)
    pipeline.process_frame(make_frame(1))  # opens window A
    pipeline.process_frame(make_frame(2))  # change -> commits A, opens B
    pipeline.flush()  # commits B at end of stream
    assert db.counts()["observations"] == 2


class _ChangedModel:
    """Model stub returning a preset `changed` verdict per call (overview unique
    so the text-dedup heuristic never interferes)."""

    name = "changed-stub"

    def __init__(self, verdicts):
        self.verdicts = list(verdicts)
        self.i = 0

    def observe(self, frame_jpeg: bytes, prev, correction=None) -> Observation:
        changed = self.verdicts[self.i]
        self.i += 1
        token = uuid.uuid4().hex
        return Observation(
            is_text=False,
            ocr_full="",
            overview=token[:8],
            change_from_prev="c" if changed else "no significant change",
            changed=changed,
            model=self.name,
        )


def test_vlm_no_change_verdict_is_suppressed(tmp_path, make_frame):
    # The perceptual gate fires on every frame (lighting jitter), but the model
    # judges only the 2nd frame a real change. The baseline (1st) is kept; the
    # no-change 3rd frame is dropped — so two observations, one suppressed.
    db = VisionDB(str(tmp_path / "v.db"))
    store = FrameStore(str(tmp_path / "cache"))
    model = _ChangedModel([False, True, False])  # baseline, change, no-change
    pipeline = Pipeline(db, store, _AlwaysChanged(), model)
    for seed in (1, 2, 3):
        pipeline.process_frame(make_frame(seed))
    assert db.counts()["observations"] == 2
    assert pipeline.stats.observations_written == 2
    assert pipeline.stats.nochange_suppressed == 1


def test_no_change_does_not_advance_prev_state(tmp_path, make_frame):
    # A suppressed no-change frame must not become the new baseline, so a later
    # frame is still diffed against the last *real* state.
    db = VisionDB(str(tmp_path / "v.db"))
    store = FrameStore(str(tmp_path / "cache"))
    model = _ChangedModel([False, False, True])  # baseline, no-change, change
    pipeline = Pipeline(db, store, _AlwaysChanged(), model)
    for seed in (1, 2, 3):
        pipeline.process_frame(make_frame(seed))
    assert db.counts()["observations"] == 2  # baseline + the real change
    assert pipeline.stats.nochange_suppressed == 1


def test_on_observation_callback_fires_on_commit(tmp_path, make_frame):
    db = VisionDB(str(tmp_path / "v.db"))
    store = FrameStore(str(tmp_path / "cache"))
    seen = []
    pipeline = Pipeline(db, store, ChangeGate(), MockModelClient(), on_observation=seen.append)
    pipeline.process_frame(make_frame(0x0F0F))
    assert len(seen) == 1
    assert seen[0].overview.startswith("text document")


class _RecordingModel:
    """Model stub that records the `correction` advisory passed to observe."""

    name = "recording"

    def __init__(self):
        self.seen = []

    def observe(self, frame_jpeg, prev, correction=None) -> Observation:
        self.seen.append(correction)
        token = uuid.uuid4().hex
        return Observation(
            is_text=False,
            ocr_full="",
            overview=token[:8],
            changed=True,
            change_from_prev="changed",
            low_confidence=False,
            latency_ms=1,
            model=self.name,
        )


def _recording_pipeline(model, tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    store = FrameStore(str(tmp_path / "cache"))
    return Pipeline(db, store, _AlwaysChanged(), model)


def test_correction_advisory_passed_to_model_when_provider_set(tmp_path, make_scene):
    model = _RecordingModel()
    pipeline = _recording_pipeline(model, tmp_path)
    pipeline.correction_provider = lambda: "救急車の赤色灯"
    pipeline.process_frame(make_scene(1))
    assert model.seen[-1] == "救急車の赤色灯"


def test_no_advisory_without_provider(tmp_path, make_scene):
    model = _RecordingModel()
    pipeline = _recording_pipeline(model, tmp_path)
    pipeline.process_frame(make_scene(1))
    assert model.seen[-1] is None


def test_advisory_none_when_provider_returns_none(tmp_path, make_scene):
    model = _RecordingModel()
    pipeline = _recording_pipeline(model, tmp_path)
    pipeline.correction_provider = lambda: None
    pipeline.process_frame(make_scene(1))
    assert model.seen[-1] is None
