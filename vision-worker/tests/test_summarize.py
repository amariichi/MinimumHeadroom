from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from vision_worker.db import VisionDB
from vision_worker.records import Observation
from vision_worker.situation import render_situation_text
from vision_worker.summarize import (
    MAX_LEVEL,
    Summarizer,
    bucket_start,
    closed_bands,
    consolidate_closed_bands,
    extractive_summary,
    situation_summaries,
    tier_band,
)

UTC = timezone.utc

# A fixed reference time with clean tier alignment, used across the ladder tests:
#   T1 (10 min) closed band -> [08:10, 08:20)
#   T2 (1 h)    closed band -> [07:00, 08:00)
#   T3 (6 h)    closed band -> [00:00, 06:00)
#   T4 (1 day)  closed band -> [2026-06-21 00:00, 2026-06-22 00:00)
NOW = datetime(2026, 6, 22, 8, 25, 30, tzinfo=UTC)


# ---- extractive_summary (pure, model-free) ---------------------------------


def test_extractive_empty_is_blank():
    assert extractive_summary([]) == ""
    assert extractive_summary([{"overview": "", "change_from_prev": ""}]) == ""


def test_extractive_single_is_that_change():
    out = extractive_summary([{"overview": "机に本", "change_from_prev": "本が置かれた"}])
    assert out == "本が置かれた"  # prefers the change description


def test_extractive_multiple_spans_endpoints():
    changes = [  # newest first
        {"overview": "c", "change_from_prev": "マグカップが消えた"},
        {"overview": "b", "change_from_prev": "スマホが置かれた"},
        {"overview": "a", "change_from_prev": "本が置かれた"},
    ]
    out = extractive_summary(changes)
    assert out.startswith("3件の変化")
    assert "本が置かれた" in out  # oldest
    assert "マグカップが消えた" in out  # newest


# ---- Summarizer fallback ----------------------------------------------------


def test_summarizer_disabled_uses_extractive():
    s = Summarizer(base_url="http://unused", model_name="m", enabled=False)
    assert s.summarize([{"change_from_prev": "本が置かれた"}]) == "本が置かれた"


def test_summarizer_falls_back_when_endpoint_unreachable():
    # Port 1 refuses instantly; the LLM call fails and we degrade to extractive
    # rather than raising — a read must never fail because the model is down.
    s = Summarizer(base_url="http://127.0.0.1:1/v1", model_name="m", timeout=1.0)
    out = s.summarize([{"change_from_prev": "本が置かれた"}, {"change_from_prev": "スマホが置かれた"}])
    assert out.startswith("2件の変化")


def test_summarizer_empty_changes_is_blank():
    s = Summarizer(base_url="http://127.0.0.1:1/v1", model_name="m", timeout=1.0)
    assert s.summarize([]) == ""


# ---- DB summary table round-trip -------------------------------------------


def test_summary_upsert_get_and_recent(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    db.upsert_summary(1, "2026-06-21T12:00:00+00:00", "2026-06-21T12:10:00+00:00", "要約A", 3)
    got = db.get_summary(1, "2026-06-21T12:00:00+00:00")
    assert got["text"] == "要約A" and got["source_count"] == 3
    db.upsert_summary(1, "2026-06-21T12:00:00+00:00", "2026-06-21T12:10:00+00:00", "要約B", 5)
    got2 = db.get_summary(1, "2026-06-21T12:00:00+00:00")
    assert got2["text"] == "要約B" and got2["source_count"] == 5  # replaced in place
    db.upsert_summary(1, "2026-06-21T12:10:00+00:00", "2026-06-21T12:20:00+00:00", "要約C", 1)
    assert [r["text"] for r in db.recent_summaries(1, 10)] == ["要約C", "要約B"]


def test_summaries_between_filters_level_and_time(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    db.upsert_summary(1, "2026-06-22T07:10:00+00:00", "2026-06-22T07:20:00+00:00", "a", 1)
    db.upsert_summary(1, "2026-06-22T07:30:00+00:00", "2026-06-22T07:40:00+00:00", "b", 1)
    db.upsert_summary(1, "2026-06-22T08:10:00+00:00", "2026-06-22T08:20:00+00:00", "c", 1)  # outside
    db.upsert_summary(2, "2026-06-22T07:00:00+00:00", "2026-06-22T08:00:00+00:00", "lvl2", 1)  # wrong level
    got = db.summaries_between(1, "2026-06-22T07:00:00+00:00", "2026-06-22T08:00:00+00:00")
    assert [r["text"] for r in got] == ["b", "a"]  # newest first, c & lvl2 excluded


def test_prune_summaries_keeps_newest(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    for i in range(10):
        db.upsert_summary(1, f"2026-06-22T07:{i:02d}:00+00:00", f"2026-06-22T07:{i:02d}:30+00:00", f"s{i}", 1)
    db.prune_summaries(1, 3)
    kept = [r["period_start"] for r in db.recent_summaries(1, 50)]
    assert kept == ["2026-06-22T07:09:00+00:00", "2026-06-22T07:08:00+00:00", "2026-06-22T07:07:00+00:00"]


# ---- tier band geometry -----------------------------------------------------


def test_tier_band_alignment():
    assert tier_band(NOW, 1) == (datetime(2026, 6, 22, 8, 10, tzinfo=UTC), datetime(2026, 6, 22, 8, 20, tzinfo=UTC))
    assert tier_band(NOW, 2) == (datetime(2026, 6, 22, 7, 0, tzinfo=UTC), datetime(2026, 6, 22, 8, 0, tzinfo=UTC))
    assert tier_band(NOW, 3) == (datetime(2026, 6, 22, 0, 0, tzinfo=UTC), datetime(2026, 6, 22, 6, 0, tzinfo=UTC))
    assert tier_band(NOW, 4) == (datetime(2026, 6, 21, 0, 0, tzinfo=UTC), datetime(2026, 6, 22, 0, 0, tzinfo=UTC))


def test_bucket_start_aligns_to_grid():
    assert bucket_start(NOW, timedelta(hours=6)) == datetime(2026, 6, 22, 6, 0, tzinfo=UTC)
    assert bucket_start(NOW, timedelta(days=1)) == datetime(2026, 6, 22, 0, 0, tzinfo=UTC)


# ---- helpers for orchestration tests ---------------------------------------


def _insert_change_at(db: VisionDB, created_at_iso: str, overview: str, change: str) -> None:
    """Insert a change observation with an explicit created_at (the public API
    stamps 'now', so tests write the row directly to control the time band)."""
    with db._conn() as conn:
        cur = conn.execute(
            "INSERT INTO frames(captured_at, phash, full_path, thumb_path, width, height)"
            " VALUES(?, ?, ?, ?, ?, ?)",
            (created_at_iso, "h", "/tmp/none.jpg", None, 64, 64),
        )
        conn.execute(
            "INSERT INTO observations(frame_id, is_text, ocr_full, overview, change_from_prev,"
            " model, latency_ms, low_confidence, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (cur.lastrowid, 0, "", overview, change, "test", 0, 0, created_at_iso),
        )


class _FakeSummarizer(Summarizer):
    """Summarizer whose 'LLM' is a canned string (no network)."""

    def __init__(self, enabled: bool = True):
        super().__init__(base_url="http://unused", model_name="m", enabled=enabled)

    def _summarize_llm(self, changes):
        return "LLMによる要約"


# ---- situation_summaries orchestration -------------------------------------


def test_no_closed_band_content_returns_nothing(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    # A change in the *open* tier-1 bucket (08:20-08:30) is not in any closed band.
    _insert_change_at(db, "2026-06-22T08:24:00+00:00", "x", "変化X")
    assert situation_summaries(db, _FakeSummarizer(), NOW, idle=True) == []


def test_tier1_not_idle_returns_extractive_only(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    _insert_change_at(db, "2026-06-22T08:12:00+00:00", "a", "本が置かれた")
    _insert_change_at(db, "2026-06-22T08:15:00+00:00", "b", "スマホが置かれた")
    out = situation_summaries(db, _FakeSummarizer(), NOW, idle=False)
    assert len(out) == 1 and out[0]["level"] == 1
    assert out[0]["pending_llm"] is False
    assert out[0]["text"].startswith("2件の変化")
    # Not idle => no LLM scheduled => nothing cached.
    start, _ = tier_band(NOW, 1)
    assert db.get_summary(1, start.isoformat()) is None


def test_tier1_idle_schedules_llm_and_caches(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    _insert_change_at(db, "2026-06-22T08:12:00+00:00", "a", "本が置かれた")
    _insert_change_at(db, "2026-06-22T08:15:00+00:00", "b", "スマホが置かれた")
    out = situation_summaries(db, _FakeSummarizer(), NOW, idle=True)
    assert out[0]["pending_llm"] is True
    assert out[0]["text"].startswith("2件の変化")  # instant extractive first

    start, _ = tier_band(NOW, 1)
    deadline = time.time() + 3.0
    while time.time() < deadline and db.get_summary(1, start.isoformat()) is None:
        time.sleep(0.02)
    cached = db.get_summary(1, start.isoformat())
    assert cached is not None and cached["text"] == "LLMによる要約"

    out2 = situation_summaries(db, _FakeSummarizer(), NOW, idle=True)
    lvl1 = [e for e in out2 if e["level"] == 1][0]
    assert lvl1["text"] == "LLMによる要約" and lvl1["pending_llm"] is False


def test_tier2_consolidates_tier1_summaries(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    # Three tier-1 summaries inside the closed tier-2 (hour) band [07:00, 08:00).
    db.upsert_summary(1, "2026-06-22T07:10:00+00:00", "2026-06-22T07:20:00+00:00", "本が置かれた", 2)
    db.upsert_summary(1, "2026-06-22T07:30:00+00:00", "2026-06-22T07:40:00+00:00", "PCが開かれた", 1)
    db.upsert_summary(1, "2026-06-22T07:50:00+00:00", "2026-06-22T08:00:00+00:00", "人が現れた", 1)
    out = situation_summaries(db, _FakeSummarizer(), NOW, idle=False)
    lvl2 = [e for e in out if e["level"] == 2]
    assert len(lvl2) == 1
    assert lvl2[0]["source_count"] == 3
    assert lvl2[0]["text"].startswith("3件の変化")  # extractive over the 3 lower summaries
    assert lvl2[0]["period_start"] == "2026-06-22T07:00:00+00:00"


def test_tier3_consolidates_tier2_and_tier4_consolidates_tier3(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    # tier-2 summaries inside the closed tier-3 band [00:00, 06:00)
    db.upsert_summary(2, "2026-06-22T03:00:00+00:00", "2026-06-22T04:00:00+00:00", "朝の活動", 4)
    db.upsert_summary(2, "2026-06-22T04:00:00+00:00", "2026-06-22T05:00:00+00:00", "片付け", 2)
    # tier-3 summaries inside the closed tier-4 band [06-21 00:00, 06-22 00:00)
    db.upsert_summary(3, "2026-06-21T06:00:00+00:00", "2026-06-21T12:00:00+00:00", "昼の様子", 5)
    db.upsert_summary(3, "2026-06-21T12:00:00+00:00", "2026-06-21T18:00:00+00:00", "夕方の様子", 3)
    out = situation_summaries(db, _FakeSummarizer(), NOW, idle=False)
    levels = {e["level"]: e for e in out}
    assert 3 in levels and levels[3]["source_count"] == 2
    assert 4 in levels and levels[4]["source_count"] == 2
    assert levels[4]["period_start"] == "2026-06-21T00:00:00+00:00"


def test_full_ladder_returns_one_entry_per_populated_tier(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    _insert_change_at(db, "2026-06-22T08:12:00+00:00", "a", "本が置かれた")  # T1 raw
    db.upsert_summary(1, "2026-06-22T07:10:00+00:00", "2026-06-22T07:20:00+00:00", "x", 1)  # -> T2
    db.upsert_summary(2, "2026-06-22T03:00:00+00:00", "2026-06-22T04:00:00+00:00", "y", 1)  # -> T3
    db.upsert_summary(3, "2026-06-21T06:00:00+00:00", "2026-06-21T12:00:00+00:00", "z", 1)  # -> T4
    out = situation_summaries(db, _FakeSummarizer(), NOW, idle=False)
    assert [e["level"] for e in out] == [1, 2, 3, 4]
    assert MAX_LEVEL == 4


def test_situation_summaries_looks_past_empty_newest_t1_bucket(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    now = datetime(2026, 6, 22, 8, 44, tzinfo=UTC)
    # Newest closed T1 is [08:30, 08:40), intentionally empty. The activity sits
    # in the next two older closed buckets, matching the now-25..now-15 gap.
    _insert_change_at(db, (now - timedelta(minutes=25)).isoformat(), "a", "古い変化A")
    _insert_change_at(db, (now - timedelta(minutes=15)).isoformat(), "b", "古い変化B")

    summaries = situation_summaries(db, _FakeSummarizer(), now, idle=False)
    lvl1 = [s for s in summaries if s["level"] == 1]
    assert [s["period_start"] for s in lvl1] == [
        "2026-06-22T08:20:00+00:00",
        "2026-06-22T08:10:00+00:00",
    ]

    text = render_situation_text({
        "observing": True,
        "current": {
            "overview": "机",
            "is_text": False,
            "ocr": "",
            "stable_seconds": 5,
            "stale": False,
        },
        "recent": [],
        "summaries": summaries,
    })
    assert "直近: 古い変化B ← 古い変化A" in text


def test_retention_prunes_when_idle(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    # 20 tier-1 summaries; retention cap for tier 1 is 12.
    for i in range(20):
        db.upsert_summary(1, f"2026-06-22T05:{i:02d}:00+00:00", f"2026-06-22T05:{i:02d}:30+00:00", f"s{i}", 1)
    situation_summaries(db, _FakeSummarizer(), NOW, idle=True)
    assert len(db.recent_summaries(1, 100)) == 12



def _join_threads(threads):
    for thread in threads:
        thread.join(timeout=3.0)
        assert not thread.is_alive()


def test_closed_bands_returns_retention_horizon_newest_first():
    bands = closed_bands(NOW, 1, n=3)
    assert bands == [
        (datetime(2026, 6, 22, 8, 10, tzinfo=UTC), datetime(2026, 6, 22, 8, 20, tzinfo=UTC)),
        (datetime(2026, 6, 22, 8, 0, tzinfo=UTC), datetime(2026, 6, 22, 8, 10, tzinfo=UTC)),
        (datetime(2026, 6, 22, 7, 50, tzinfo=UTC), datetime(2026, 6, 22, 8, 0, tzinfo=UTC)),
    ]


def test_background_consolidation_schedules_uncached_bands_for_all_tiers(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    _insert_change_at(db, "2026-06-22T08:12:00+00:00", "a", "本が置かれた")
    db.upsert_summary(1, "2026-06-22T07:10:00+00:00", "2026-06-22T07:20:00+00:00", "本が置かれた", 2)
    db.upsert_summary(1, "2026-06-22T07:30:00+00:00", "2026-06-22T07:40:00+00:00", "PCが開かれた", 1)
    db.upsert_summary(2, "2026-06-22T03:00:00+00:00", "2026-06-22T04:00:00+00:00", "朝の活動", 4)
    db.upsert_summary(2, "2026-06-22T04:00:00+00:00", "2026-06-22T05:00:00+00:00", "片付け", 2)
    db.upsert_summary(3, "2026-06-21T06:00:00+00:00", "2026-06-21T12:00:00+00:00", "昼の様子", 5)
    db.upsert_summary(3, "2026-06-21T12:00:00+00:00", "2026-06-21T18:00:00+00:00", "夕方の様子", 3)

    _join_threads(consolidate_closed_bands(db, _FakeSummarizer(), NOW))

    assert db.get_summary(1, "2026-06-22T08:10:00+00:00")["text"] == "LLMによる要約"
    assert db.get_summary(2, "2026-06-22T07:00:00+00:00")["text"] == "LLMによる要約"
    assert db.get_summary(3, "2026-06-22T00:00:00+00:00")["text"] == "LLMによる要約"
    assert db.get_summary(4, "2026-06-21T00:00:00+00:00")["text"] == "LLMによる要約"


def test_background_consolidation_caches_extractive_fallback_when_model_down(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    _insert_change_at(db, "2026-06-22T08:12:00+00:00", "a", "本が置かれた")
    _insert_change_at(db, "2026-06-22T08:15:00+00:00", "b", "スマホが置かれた")
    down = Summarizer(base_url="http://127.0.0.1:1/v1", model_name="m", timeout=0.1)

    _join_threads(consolidate_closed_bands(db, down, NOW))

    cached = db.get_summary(1, "2026-06-22T08:10:00+00:00")
    assert cached is not None
    assert cached["text"].startswith("2件の変化")
    assert cached["source_count"] == 2


def test_prune_preserves_unconsolidated_t1_inputs_until_background_summary(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    start = datetime(2026, 6, 22, 8, 0, tzinfo=UTC)
    for i in range(120):
        at = start + timedelta(seconds=15 * i)
        _insert_change_at(db, at.isoformat(), f"scene-{i}", f"変化{i}")
        db.prune(max_changes=50, now=at, hard_limit=500)

    now = datetime(2026, 6, 22, 8, 35, tzinfo=UTC)
    for minute in (0, 10, 20):
        band_start = datetime(2026, 6, 22, 8, minute, tzinfo=UTC)
        band_end = band_start + timedelta(minutes=10)
        assert len(db.changes_between(band_start.isoformat(), band_end.isoformat())) == 40

    _join_threads(consolidate_closed_bands(db, _FakeSummarizer(), now))

    for minute in (0, 10, 20):
        band_start = datetime(2026, 6, 22, 8, minute, tzinfo=UTC)
        cached = db.get_summary(1, band_start.isoformat())
        assert cached is not None
        assert cached["source_count"] == 40
    assert db.counts()["observations"] == 120

    db.prune(max_changes=50, now=now, hard_limit=500)
    assert db.counts()["observations"] == 50


def test_prune_hard_limit_bounds_unhealthy_summarizer_growth(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    start = datetime(2026, 6, 22, 8, 0, tzinfo=UTC)
    for i in range(80):
        at = start + timedelta(seconds=15 * i)
        _insert_change_at(db, at.isoformat(), f"scene-{i}", f"変化{i}")
    db.prune(max_changes=10, now=datetime(2026, 6, 22, 8, 25, tzinfo=UTC), hard_limit=60)
    assert db.counts()["observations"] == 60
