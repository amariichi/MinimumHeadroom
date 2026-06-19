from __future__ import annotations

from vision_worker.db import VisionDB
from vision_worker.records import Observation


def _obs(tag: str) -> Observation:
    return Observation(
        is_text=True,
        ocr_full=f"text-{tag}",
        overview=f"overview-{tag}",
        change_from_prev="changed",
        model="mock",
    )


def _insert(db: VisionDB, tag: str) -> int:
    frame_id = db.insert_frame(
        captured_at="2026-06-19T00:00:00Z",
        phash="abc",
        full_path=f"/tmp/{tag}.jpg",
        thumb_path=f"/tmp/{tag}_t.jpg",
        width=96,
        height=96,
    )
    db.insert_observation(frame_id, _obs(tag))
    return frame_id


def test_latest_and_previous(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    assert db.latest() is None
    _insert(db, "a")
    _insert(db, "b")
    assert db.latest()["overview"] == "overview-b"
    assert db.previous()["overview"] == "overview-a"


def test_search(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    _insert(db, "apple")
    _insert(db, "banana")
    results = db.search("banana")
    assert len(results) == 1
    assert results[0]["ocr_full"] == "text-banana"


def test_prune_keeps_only_max_changes(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    for i in range(5):
        _insert(db, f"f{i}")
    orphans = db.prune(max_changes=2)
    assert db.counts()["observations"] == 2
    assert db.counts()["frames"] == 2
    assert len(orphans) == 3  # three frames became unreferenced
    assert db.latest()["overview"] == "overview-f4"


def test_frame_path_roundtrip(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    frame_id = _insert(db, "x")
    assert db.frame_path(frame_id) == "/tmp/x.jpg"
    assert db.frame_path(99999) is None
