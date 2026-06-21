from __future__ import annotations

from datetime import datetime, timedelta, timezone

from vision_worker.db import VisionDB
from vision_worker.gate import ChangeGate
from vision_worker.model_client import MockModelClient
from vision_worker.pipeline import Pipeline
from vision_worker.situation import compose_situation
from vision_worker.store import FrameStore

UTC = timezone.utc


def test_empty_situation_has_null_current():
    now = datetime(2026, 6, 21, 12, 0, 0, tzinfo=UTC)
    digest = compose_situation(
        now=now,
        observing=True,
        latest=None,
        last_change_at=None,
        last_observed_at=None,
        recent=[],
    )
    assert digest["current"] is None
    assert digest["recent"] == []
    assert digest["summaries"] == []
    assert digest["observing"] is True


def test_stable_seconds_grows_while_observing():
    changed_at = datetime(2026, 6, 21, 12, 0, 0, tzinfo=UTC)
    latest = {"overview": "机に本", "is_text": False, "ocr_full": "", "created_at": changed_at.isoformat()}

    def at(seconds: int) -> dict:
        return compose_situation(
            now=changed_at + timedelta(seconds=seconds),
            observing=True,
            latest=latest,
            last_change_at=changed_at,
            last_observed_at=changed_at + timedelta(seconds=seconds),
            recent=[],
        )

    assert at(5)["current"]["stable_seconds"] == 5
    assert at(42)["current"]["stable_seconds"] == 42
    # The headline grows on re-read of a still scene.
    assert at(60)["current"]["stable_seconds"] > at(42)["current"]["stable_seconds"]
    assert at(5)["current"]["overview"] == "机に本"
    assert at(5)["current"]["changed_at"] == changed_at.isoformat()


def test_stable_seconds_freezes_at_last_look_when_not_observing():
    changed_at = datetime(2026, 6, 21, 12, 0, 0, tzinfo=UTC)
    last_look = changed_at + timedelta(seconds=30)
    latest = {"overview": "x", "is_text": False, "ocr_full": "", "created_at": changed_at.isoformat()}
    # The loop stopped 30s after the change; even if 'now' is far later, the
    # confirmed stable duration stays pinned to the last actual observation.
    digest = compose_situation(
        now=changed_at + timedelta(seconds=600),
        observing=False,
        latest=latest,
        last_change_at=changed_at,
        last_observed_at=last_look,
        recent=[],
    )
    assert digest["current"]["stable_seconds"] == 30
    assert digest["current"]["confirmed_at"] == last_look.isoformat()


def test_changed_at_falls_back_to_db_created_at_after_restart():
    # After a restart, in-memory last_change_at is None; the digest derives the
    # change time from the latest DB row so stable_seconds is still sane.
    created = datetime(2026, 6, 21, 11, 59, 0, tzinfo=UTC)
    latest = {"overview": "x", "is_text": False, "ocr_full": "", "created_at": created.isoformat()}
    digest = compose_situation(
        now=created + timedelta(seconds=20),
        observing=True,
        latest=latest,
        last_change_at=None,
        last_observed_at=None,
        recent=[],
    )
    assert digest["current"]["changed_at"] == created.isoformat()
    assert digest["current"]["stable_seconds"] == 20


def test_stable_seconds_never_negative():
    changed_at = datetime(2026, 6, 21, 12, 0, 0, tzinfo=UTC)
    latest = {"overview": "x", "is_text": False, "ocr_full": "", "created_at": changed_at.isoformat()}
    digest = compose_situation(
        now=changed_at - timedelta(seconds=5),  # clock skew edge
        observing=True,
        latest=latest,
        last_change_at=changed_at,
        last_observed_at=changed_at,
        recent=[],
    )
    assert digest["current"]["stable_seconds"] == 0


def test_recent_is_shaped_to_at_overview_change():
    now = datetime(2026, 6, 21, 12, 0, 0, tzinfo=UTC)
    latest = {"overview": "now", "is_text": False, "ocr_full": "", "created_at": now.isoformat()}
    recent = [
        {"created_at": "t2", "overview": "o2", "change_from_prev": "c2", "extra": "drop"},
        {"created_at": "t1", "overview": "o1", "change_from_prev": "c1"},
    ]
    digest = compose_situation(
        now=now,
        observing=True,
        latest=latest,
        last_change_at=now,
        last_observed_at=now,
        recent=recent,
    )
    assert digest["recent"] == [
        {"at": "t2", "overview": "o2", "change": "c2"},
        {"at": "t1", "overview": "o1", "change": "c1"},
    ]


def test_pipeline_commit_sets_last_change_at_and_drives_stable_seconds(tmp_path, make_frame):
    # The plan's M1 acceptance: build a pipeline, commit one observation, advance
    # a fake clock, and assert stable_seconds grows off the real last_change_at.
    db = VisionDB(str(tmp_path / "v.db"))
    store = FrameStore(str(tmp_path / "cache"))
    pipeline = Pipeline(db, store, ChangeGate(), MockModelClient())
    assert pipeline.last_change_at is None
    pipeline.process_frame(make_frame(0x0F0F))
    assert pipeline.last_change_at is not None

    base = pipeline.last_change_at

    def stable_after(seconds: int) -> int:
        return compose_situation(
            now=base + timedelta(seconds=seconds),
            observing=True,
            latest=db.latest(),
            last_change_at=pipeline.last_change_at,
            last_observed_at=base + timedelta(seconds=seconds),
            recent=db.recent_changes(8),
        )["current"]["stable_seconds"]

    assert stable_after(3) == 3
    assert stable_after(11) == 11
