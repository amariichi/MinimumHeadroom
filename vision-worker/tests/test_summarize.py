from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from vision_worker.db import VisionDB
from vision_worker.records import Observation
from vision_worker.summarize import (
    Summarizer,
    extractive_summary,
    situation_summaries,
    t1_band,
)

UTC = timezone.utc


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
    changes = [{"change_from_prev": "本が置かれた"}]
    assert s.summarize(changes) == "本が置かれた"


def test_summarizer_falls_back_when_endpoint_unreachable():
    # Port 1 refuses instantly; the LLM call fails and we degrade to extractive
    # rather than raising — a read must never fail because the model is down.
    s = Summarizer(base_url="http://127.0.0.1:1/v1", model_name="m", timeout=1.0)
    changes = [
        {"change_from_prev": "本が置かれた"},
        {"change_from_prev": "スマホが置かれた"},
    ]
    out = s.summarize(changes)
    assert out.startswith("2件の変化")


def test_summarizer_empty_changes_is_blank():
    s = Summarizer(base_url="http://127.0.0.1:1/v1", model_name="m", timeout=1.0)
    assert s.summarize([]) == ""


# ---- DB summary table round-trip -------------------------------------------


def test_summary_upsert_get_and_recent(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    db.upsert_summary(1, "2026-06-21T12:00:00+00:00", "2026-06-21T12:07:00+00:00", "要約A", 3)
    got = db.get_summary(1, "2026-06-21T12:00:00+00:00")
    assert got["text"] == "要約A"
    assert got["source_count"] == 3
    # Upsert replaces in place (same level+period_start), not duplicates.
    db.upsert_summary(1, "2026-06-21T12:00:00+00:00", "2026-06-21T12:07:00+00:00", "要約B", 5)
    got2 = db.get_summary(1, "2026-06-21T12:00:00+00:00")
    assert got2["text"] == "要約B"
    assert got2["source_count"] == 5
    db.upsert_summary(1, "2026-06-21T12:10:00+00:00", "2026-06-21T12:17:00+00:00", "要約C", 1)
    recent = db.recent_summaries(1, 10)
    assert [r["text"] for r in recent] == ["要約C", "要約B"]  # newest period first


def _insert_change(db: VisionDB, overview: str, change: str) -> None:
    fid = db.insert_frame(
        datetime.now(UTC).isoformat(), "h", str("/tmp/none.jpg"), None, 64, 64
    )
    db.insert_observation(
        fid,
        Observation(is_text=False, ocr_full="", overview=overview, change_from_prev=change),
    )


def test_changes_between_filters_by_time(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    _insert_change(db, "now-a", "変化A")
    now = datetime.now(UTC)
    # A window around now finds it; a window 3-10 min ago does not.
    near = db.changes_between((now - timedelta(minutes=1)).isoformat(), (now + timedelta(minutes=1)).isoformat())
    far = db.changes_between((now - timedelta(minutes=10)).isoformat(), (now - timedelta(minutes=3)).isoformat())
    assert len(near) == 1
    assert far == []


# ---- situation_summaries orchestration -------------------------------------


class _FakeSummarizer(Summarizer):
    """Summarizer whose 'LLM' is a canned string (no network)."""

    def __init__(self, enabled: bool = True):
        super().__init__(base_url="http://unused", model_name="m", enabled=enabled)

    def _summarize_llm(self, changes):
        return "LLMによる要約"


def _now_ahead(minutes: int) -> datetime:
    # A synthetic 'now' N minutes ahead so just-inserted rows land in the
    # tier-1 [now-10, now-3] band without fabricating backdated timestamps.
    return datetime.now(UTC) + timedelta(minutes=minutes)


def test_situation_summaries_empty_band_returns_nothing(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    _insert_change(db, "x", "変化X")  # at real now
    # Band 3-10 min behind a 'now' that is only +1 min ahead excludes it.
    out = situation_summaries(db, _FakeSummarizer(), _now_ahead(1), idle=True)
    assert out == []


def test_situation_summaries_not_idle_returns_extractive_only(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    _insert_change(db, "a", "本が置かれた")
    _insert_change(db, "b", "スマホが置かれた")
    out = situation_summaries(db, _FakeSummarizer(), _now_ahead(6), idle=False)
    assert len(out) == 1
    assert out[0]["level"] == 1
    assert out[0]["pending_llm"] is False
    assert out[0]["text"].startswith("2件の変化")
    # Not idle => no LLM job scheduled => nothing cached.
    start, _ = t1_band(_now_ahead(6))
    assert db.get_summary(1, start.isoformat()) is None


def test_situation_summaries_idle_schedules_llm_and_caches(tmp_path):
    db = VisionDB(str(tmp_path / "v.db"))
    _insert_change(db, "a", "本が置かれた")
    _insert_change(db, "b", "スマホが置かれた")
    now = _now_ahead(6)
    out = situation_summaries(db, _FakeSummarizer(), now, idle=True)
    assert out[0]["pending_llm"] is True
    assert out[0]["text"].startswith("2件の変化")  # instant extractive first

    start, _ = t1_band(now)
    # The background job upserts the LLM summary shortly after.
    deadline = time.time() + 3.0
    while time.time() < deadline and db.get_summary(1, start.isoformat()) is None:
        time.sleep(0.02)
    cached = db.get_summary(1, start.isoformat())
    assert cached is not None and cached["text"] == "LLMによる要約"

    # The next read returns the cached LLM summary, not the extractive one.
    out2 = situation_summaries(db, _FakeSummarizer(), now, idle=True)
    assert out2[0]["text"] == "LLMによる要約"
    assert out2[0]["pending_llm"] is False
