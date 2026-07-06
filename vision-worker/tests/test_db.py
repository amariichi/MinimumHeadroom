from __future__ import annotations

import sqlite3

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


def test_existing_db_migrates_human_note_column(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE frames (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                captured_at TEXT NOT NULL,
                phash TEXT,
                full_path TEXT NOT NULL,
                thumb_path TEXT,
                width INTEGER,
                height INTEGER
            );
            CREATE TABLE observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                frame_id INTEGER NOT NULL REFERENCES frames(id),
                is_text INTEGER NOT NULL,
                ocr_full TEXT NOT NULL DEFAULT '',
                overview TEXT NOT NULL DEFAULT '',
                change_from_prev TEXT NOT NULL DEFAULT '',
                model TEXT NOT NULL DEFAULT '',
                latency_ms INTEGER NOT NULL DEFAULT 0,
                low_confidence INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            """
        )
        conn.execute(
            "INSERT INTO frames(captured_at, phash, full_path, thumb_path, width, height)"
            " VALUES(?, ?, ?, ?, ?, ?)",
            ("2026-06-22T08:00:00+00:00", "h", "/tmp/old.jpg", None, 64, 64),
        )
        conn.execute(
            "INSERT INTO observations(frame_id, is_text, ocr_full, overview, change_from_prev,"
            " model, latency_ms, low_confidence, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (1, 0, "", "赤信号", "赤信号が見える", "test", 0, 0, "2026-06-22T08:00:00+00:00"),
        )

    db = VisionDB(str(path))
    with db._conn() as conn:
        columns = {r["name"] for r in conn.execute("PRAGMA table_info(observations)")}
    assert "human_note" in columns
    assert db.latest()["human_note"] is None

    stamped = db.stamp_human_note_at_or_before(
        "2026-06-22T08:00:00+00:00", "救急車の赤色灯"
    )
    assert stamped is not None
    assert stamped["human_note"] == "救急車の赤色灯"
    assert db.latest()["human_note"] == "救急車の赤色灯"


def test_delete_summaries_containing_removes_all_covering_tiers(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    ts = "2026-06-22T08:05:00+00:00"
    covering = [
        (1, "2026-06-22T08:00:00+00:00", "2026-06-22T08:10:00+00:00"),
        (2, "2026-06-22T08:00:00+00:00", "2026-06-22T09:00:00+00:00"),
        (3, "2026-06-22T06:00:00+00:00", "2026-06-22T12:00:00+00:00"),
        (4, "2026-06-22T00:00:00+00:00", "2026-06-23T00:00:00+00:00"),
    ]
    for level, start, end in covering:
        db.upsert_summary(level, start, end, f"stale-{level}", 1)
    db.upsert_summary(1, "2026-06-22T08:10:00+00:00", "2026-06-22T08:20:00+00:00", "keep", 1)
    db.upsert_summary(2, "2026-06-22T07:00:00+00:00", "2026-06-22T08:00:00+00:00", "keep2", 1)

    assert db.delete_summaries_containing(ts) == 4
    for level, start, _ in covering:
        assert db.get_summary(level, start) is None
    assert db.get_summary(1, "2026-06-22T08:10:00+00:00")["text"] == "keep"
    assert db.get_summary(2, "2026-06-22T07:00:00+00:00")["text"] == "keep2"


def test_upsert_entities_inserts_and_bumps(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    db.upsert_entities(["イチゴ柄のマグカップ", "Amazonの箱"], at_iso="2026-07-01T00:00:00+00:00", context="机の上")
    db.upsert_entities(["イチゴ柄のマグカップ"], at_iso="2026-07-02T00:00:00+00:00", context="棚の上")
    rows = db.recent_entities(8)
    assert [r["name"] for r in rows] == ["イチゴ柄のマグカップ", "Amazonの箱"]
    mug = rows[0]
    assert mug["first_seen"] == "2026-07-01T00:00:00+00:00"
    assert mug["last_seen"] == "2026-07-02T00:00:00+00:00"
    assert mug["seen_count"] == 2
    assert mug["last_context"] == "棚の上"


def test_upsert_entities_skips_blank_and_caps_length(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    db.upsert_entities(["  ", "", "x" * 200], at_iso="2026-07-01T00:00:00+00:00")
    rows = db.recent_entities(8)
    assert len(rows) == 1
    assert len(rows[0]["name"]) == 64


def test_prune_entities_drops_old_and_caps_count(tmp_path):
    from datetime import datetime, timedelta, timezone

    db = VisionDB(str(tmp_path / "v.db"))
    now = datetime.now(timezone.utc)
    ancient = (now - timedelta(days=30)).isoformat()
    fresh = now.isoformat()
    db.upsert_entities(["古い物"], at_iso=ancient)
    for i in range(5):
        db.upsert_entities([f"物-{i}"], at_iso=fresh)
    db.prune_entities(max_age_days=14, keep=3)
    names = [r["name"] for r in db.recent_entities(10)]
    assert "古い物" not in names
    assert len(names) == 3
