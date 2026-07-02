from __future__ import annotations

from datetime import datetime, timedelta, timezone

from vision_worker.db import VisionDB
from vision_worker.gate import ChangeGate
from vision_worker.model_client import MockModelClient
from vision_worker.pipeline import Pipeline
from vision_worker.situation import (
    compose_situation,
    humanize_seconds,
    render_situation_presence_line,
    render_situation_text,
    salience_reasons,
)
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
    # After a restart, in-memory last_change_at is None; the digest still derives
    # the change time from the latest DB row. But with no observation yet this
    # session (last_observed_at None), stable_seconds is null — we cannot honestly
    # claim a confirmed-stable duration from a stale DB row.
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
    assert digest["current"]["stable_seconds"] is None


def test_stale_when_observing_but_camera_silent():
    # Loop says it is observing, but no fresh frame has arrived for 220s: the
    # camera is unreachable. stable_seconds must FREEZE at the last confirmation
    # (80s), not keep growing toward 300s, and `stale` flags it.
    changed_at = datetime(2026, 6, 21, 12, 0, 0, tzinfo=UTC)
    last_look = changed_at + timedelta(seconds=80)
    now = changed_at + timedelta(seconds=300)
    latest = {"overview": "x", "is_text": False, "ocr_full": "", "created_at": changed_at.isoformat()}
    digest = compose_situation(
        now=now, observing=True, latest=latest,
        last_change_at=changed_at, last_observed_at=last_look, recent=[], stale_after_s=30,
    )
    c = digest["current"]
    assert c["stale"] is True
    assert c["stable_seconds"] == 80  # frozen at last confirmation, not 300
    assert c["confirmed_age_seconds"] == 220


def test_not_stale_when_recently_confirmed():
    changed_at = datetime(2026, 6, 21, 12, 0, 0, tzinfo=UTC)
    last_look = changed_at + timedelta(seconds=40)
    now = last_look + timedelta(seconds=5)
    latest = {"overview": "x", "is_text": False, "ocr_full": "", "created_at": changed_at.isoformat()}
    digest = compose_situation(
        now=now, observing=True, latest=latest,
        last_change_at=changed_at, last_observed_at=last_look, recent=[], stale_after_s=30,
    )
    assert digest["current"]["stale"] is False
    assert digest["current"]["stable_seconds"] == 40


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


def test_humanize_seconds():
    assert humanize_seconds(None) == "不明"
    assert humanize_seconds(40) == "約40秒"
    assert humanize_seconds(200) == "約3分"
    assert humanize_seconds(7200) == "約2時間"
    assert humanize_seconds(3 * 86400) == "約3日"


def test_render_text_empty():
    out = render_situation_text({"current": None, "observing": False})
    assert "まだ観測がありません" in out
    assert "安全用途不可" in out


def test_render_text_full():
    digest = {
        "observing": True,
        "current": {"overview": "机に本とノートPC", "is_text": False, "ocr": "", "stable_seconds": 40},
        "recent": [
            {"at": "t2", "overview": "o2", "change": "マグカップが片付けられた"},
            {"at": "t1", "overview": "o1", "change": "人の手が伸びてきた"},
        ],
        "summaries": [
            {"level": 1, "text": "本とPCが置かれた"},
            {"level": 2, "text": "朝の作業が続いた"},
        ],
    }
    out = render_situation_text(digest)
    assert "観測中" in out
    assert "机に本とノートPC" in out
    assert "約40秒 変化なし" in out
    assert "マグカップが片付けられた" in out
    assert "直近: 本とPCが置かれた" in out  # tier-1 label
    assert "1時間: 朝の作業が続いた" in out  # tier-2 label
    assert "安全用途不可" in out


def test_render_text_merges_t1_and_caps_summary_lines():
    digest = {
        "observing": True,
        "current": {"overview": "机", "is_text": False, "ocr": "", "stable_seconds": 10},
        "recent": [],
        "summaries": [
            {"level": 1, "text": "T1新"},
            {"level": 1, "text": "T1中"},
            {"level": 1, "text": "T1古"},
            {"level": 2, "text": "T2新"},
            {"level": 2, "text": "T2中"},
            {"level": 2, "text": "T2余分"},
            {"level": 3, "text": "T3新"},
            {"level": 4, "text": "T4新"},
        ],
    }
    out = render_situation_text(digest)
    summary_lines = [
        line for line in out.splitlines()
        if line.startswith(("直近:", "1時間:", "6時間:", "1日:"))
    ]
    assert summary_lines == [
        "直近: T1新 ← T1中 ← T1古",
        "1時間: T2新",
        "1時間: T2中",
        "1時間: T2余分",
        "6時間: T3新",
    ]
    assert len(summary_lines) == 5
    assert "1日: T4新" not in out


def test_render_text_filters_baseline_marker():
    digest = {
        "observing": True,
        "current": {"overview": "壁", "is_text": False, "ocr": "", "stable_seconds": 10},
        "recent": [
            {"at": "t2", "overview": "o2", "change": "最初のフレームです。"},
            {"at": "t1", "overview": "o1", "change": "人が現れた"},
        ],
        "summaries": [],
    }
    out = render_situation_text(digest)
    assert "最初のフレーム" not in out
    assert "人が現れた" in out


def test_render_text_stale_camera_does_not_claim_stable():
    digest = {
        "observing": True,
        "current": {"overview": "机", "is_text": False, "ocr": "",
                    "stable_seconds": 80, "confirmed_age_seconds": 220,
                    "as_of_age_seconds": 220, "stale": True},
        "recent": [],
        "summaries": [],
    }
    out = render_situation_text(digest)
    assert "最後に見えた光景" in out  # not "現在"
    assert "カメラ応答なし" in out
    assert "前" in out  # how long ago we last saw it
    assert "変化なし" not in out  # must not falsely claim a live stable duration


def test_render_text_last_seen_includes_age_when_not_live():
    # Loop stopped; the digest must say it's the LAST SEEN scene and how old.
    digest = {
        "observing": False,
        "current": {"overview": "机に本", "is_text": False, "ocr": "",
                    "stable_seconds": None, "as_of_age_seconds": 7200, "stale": False},
        "recent": [],
        "summaries": [],
    }
    out = render_situation_text(digest)
    assert "観測停止中" in out
    assert "最後に見えた光景: 机に本" in out
    assert "約2時間前" in out


def test_render_text_includes_ocr_when_text():
    digest = {
        "observing": True,
        "current": {"overview": "ホワイトボード", "is_text": True, "ocr": "9:00 会議", "stable_seconds": 5},
        "recent": [],
        "summaries": [],
    }
    out = render_situation_text(digest)
    assert "表示テキスト: 9:00 会議" in out


def test_render_text_shows_active_correction():
    digest = {
        "observing": True,
        "current": {"overview": "赤信号らしき光", "is_text": False, "ocr": "",
                    "stable_seconds": 12, "stale": False},
        "recent": [],
        "summaries": [],
    }
    corrections = [
        {"text": "赤信号に見えるのは救急車の赤色灯", "age_seconds": 8, "stale_soon": False}
    ]
    out = render_situation_text(digest, corrections=corrections)
    assert "[人の補足] 赤信号に見えるのは救急車の赤色灯" in out
    assert "現シーン限定" in out
    assert "確認してください" not in out  # not stale_soon -> no nudge


def test_render_text_correction_nudge_when_stale_soon():
    digest = {
        "observing": True,
        "current": {"overview": "x", "is_text": False, "ocr": "",
                    "stable_seconds": 100, "stale": False},
        "recent": [],
        "summaries": [],
    }
    corrections = [{"text": "救急車の赤色灯", "age_seconds": 100, "stale_soon": True}]
    out = render_situation_text(digest, corrections=corrections)
    assert "[人の補足] 救急車の赤色灯" in out
    assert "確認してください" in out


def test_render_text_correction_flagged_unverified_when_camera_stale():
    digest = {
        "observing": True,
        "current": {"overview": "机", "is_text": False, "ocr": "",
                    "stable_seconds": 80, "confirmed_age_seconds": 220,
                    "as_of_age_seconds": 220, "stale": True},
        "recent": [],
        "summaries": [],
    }
    corrections = [{"text": "救急車の赤色灯", "age_seconds": 30, "stale_soon": True}]
    out = render_situation_text(digest, corrections=corrections)
    assert "[人の補足] 救急車の赤色灯" in out
    assert "カメラ応答なし・未確認" in out
    assert "確認してください" not in out  # nudge suppressed while unverifiable


def test_render_text_no_correction_line_without_corrections():
    digest = {
        "observing": True,
        "current": {"overview": "机", "is_text": False, "ocr": "",
                    "stable_seconds": 5, "stale": False},
        "recent": [],
        "summaries": [],
    }
    assert "[人の補足]" not in render_situation_text(digest)


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


def _local_dt(hour: int = 12, minute: int = 34) -> datetime:
    return datetime(2026, 6, 21, hour, minute, 0, tzinfo=datetime.now().astimezone().tzinfo)


def test_render_presence_line_is_one_line_with_absolute_time():
    now = _local_dt(12, 34)
    digest = {
        "now": now.isoformat(),
        "observing": True,
        "current": {
            "overview": "机の上の本",
            "is_text": False,
            "ocr": "",
            "stable_seconds": 12 * 60,
            "stale": False,
        },
        "recent": [],
        "summaries": [],
    }
    out = render_situation_presence_line(digest)
    assert out == "[カメラ 12:34] 机の上の本（約12分変化なし・詳細はGET /situation）"
    assert "\n" not in out


def test_render_full_block_header_has_absolute_time():
    now = _local_dt(12, 34)
    digest = {
        "now": now.isoformat(),
        "observing": True,
        "current": {"overview": "机", "is_text": False, "ocr": "", "stable_seconds": 10},
        "recent": [],
        "summaries": [],
    }
    assert render_situation_text(digest).splitlines()[0] == "[カメラの状況 12:34] 観測中"


def test_salience_reasons_scene_change_after_watermark():
    since = _local_dt(12, 0)
    digest = {
        "current": {"changed_at": (since + timedelta(seconds=1)).isoformat()},
        "observing": True,
    }
    assert salience_reasons(digest, since=since) == ["scene_change"]


def test_salience_reasons_active_correction_even_without_new_change():
    since = _local_dt(12, 0)
    digest = {"current": {"changed_at": (since - timedelta(seconds=1)).isoformat()}}
    reasons = salience_reasons(digest, since=since, corrections=[{"text": "救急車"}])
    assert reasons == ["correction"]


def test_salience_reasons_observing_stale_state_flip():
    since = _local_dt(12, 0)
    digest = {"current": {"changed_at": (since - timedelta(seconds=1)).isoformat()}}
    reasons = salience_reasons(
        digest,
        since=since,
        state_changed_at=since + timedelta(seconds=1),
    )
    assert reasons == ["state"]


def test_salience_reasons_future_last_narration_field():
    since = _local_dt(12, 0)
    digest = {
        "current": {"changed_at": (since - timedelta(seconds=1)).isoformat()},
        "last_narration": {"text": "机に本があります", "at": (since + timedelta(seconds=1)).isoformat()},
    }
    assert salience_reasons(digest, since=since) == ["narration"]
