from __future__ import annotations

import os
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from vision_worker.summarize import Summarizer, consolidate_closed_bands

UTC = timezone.utc


def _client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("VISION_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("VISION_DB_PATH", str(tmp_path / "v.db"))
    monkeypatch.setenv("VISION_MODEL_BACKEND", "mock")
    from vision_worker.app import create_app

    return TestClient(create_app())




class _EchoSummarizer(Summarizer):
    def __init__(self):
        super().__init__(base_url="http://unused", model_name="m", enabled=True)

    def _summarize_llm(self, changes):
        return self._format_changes(changes)


def _insert_change_at(db, created_at_iso: str, overview: str, change: str) -> None:
    with db._conn() as conn:
        cur = conn.execute(
            "INSERT INTO frames(captured_at, phash, full_path, thumb_path, width, height)"
            " VALUES(?, ?, ?, ?, ?, ?)",
            (created_at_iso, "h", "/tmp/app-test.jpg", None, 64, 64),
        )
        conn.execute(
            "INSERT INTO observations(frame_id, is_text, ocr_full, overview, change_from_prev,"
            " model, latency_ms, low_confidence, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (cur.lastrowid, 0, "", overview, change, "test", 0, 0, created_at_iso),
        )


def _join_threads(threads):
    for thread in threads:
        thread.join(timeout=3.0)
        assert not thread.is_alive()


def test_healthz_reports_mock_backend(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    body = client.get("/healthz").json()
    assert body["ok"] is True
    assert body["model_backend"] == "mock"


def test_ingest_then_latest_and_frame(tmp_path, monkeypatch, make_frame):
    client = _client(tmp_path, monkeypatch)

    resp = client.post(
        "/ingest",
        files={"image": ("f.jpg", make_frame(0x0F0F), "image/jpeg")},
    )
    assert resp.status_code == 200
    assert resp.json()["changed"] is True

    latest = client.get("/latest").json()
    frame_id = latest["frame_id"]
    assert frame_id >= 1

    image = client.get(f"/frame/{frame_id}")
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/jpeg"
    assert len(image.content) > 0


def test_unchanged_second_ingest_reports_no_change(tmp_path, monkeypatch, make_frame):
    client = _client(tmp_path, monkeypatch)
    frame = make_frame(0x1234)
    client.post("/ingest", files={"image": ("f.jpg", frame, "image/jpeg")})
    second = client.post("/ingest", files={"image": ("f.jpg", frame, "image/jpeg")})
    assert second.json()["changed"] is False


def test_situation_empty_before_any_observation(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    body = client.get("/situation").json()
    assert body["current"] is None
    assert body["recent"] == []
    assert body["summaries"] == []
    assert body["last_narration"] is None
    assert "safety" in body["disclaimer"].lower()


def test_situation_reports_current_after_ingest(tmp_path, monkeypatch, make_frame):
    client = _client(tmp_path, monkeypatch)
    client.post("/ingest", files={"image": ("f.jpg", make_frame(0x0F0F), "image/jpeg")})
    body = client.get("/situation").json()
    assert body["current"] is not None
    assert body["current"]["overview"]  # non-empty
    # Ingested via /ingest, not the perception loop, so there is no confirmed
    # observation timestamp -> stable_seconds is null (we don't claim stability
    # we never watched) and the camera is not flagged stale.
    assert body["current"]["stable_seconds"] is None
    assert body["current"]["stale"] is False
    assert len(body["recent"]) == 1
    assert body["recent"][0]["overview"] == body["current"]["overview"]


def test_situation_text_format(tmp_path, monkeypatch, make_frame):
    client = _client(tmp_path, monkeypatch)
    client.post("/ingest", files={"image": ("f.jpg", make_frame(0x0F0F), "image/jpeg")})
    resp = client.get("/situation?format=text")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    assert "[カメラの状況" in resp.text
    # Ingested (no live loop) -> shown as the last-seen scene, not "現在".
    assert "最後に見えた光景:" in resp.text


def test_situation_text_since_returns_watermark_and_presence_line(tmp_path, monkeypatch, make_frame):
    client = _client(tmp_path, monkeypatch)
    client.post("/ingest", files={"image": ("f.jpg", make_frame(0x0F0F), "image/jpeg")})

    first = client.get("/situation", params={"format": "text"})
    watermark = first.headers.get("x-situation-watermark")
    assert watermark
    assert "[カメラの状況" in first.text

    second = client.get("/situation", params={"format": "text", "since": watermark})
    assert second.headers.get("x-situation-watermark")
    assert second.text.startswith("[カメラ ")
    assert "詳細はGET /situation" in second.text
    assert "[カメラの状況" not in second.text
    assert len(second.text.splitlines()) == 1


def test_situation_json_includes_last_narration_shape(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    before = datetime.now(UTC)
    client.app.state.last_spoken_alerts.notify("本が置かれました", "change")

    body = client.get("/situation").json()

    last = body["last_narration"]
    assert last["text"] == "本が置かれました"
    assert datetime.fromisoformat(last["at"]) >= before
    assert isinstance(last["age_seconds"], int)
    assert last["age_seconds"] >= 0


def test_situation_text_since_escalates_for_last_narration(tmp_path, monkeypatch, make_frame):
    client = _client(tmp_path, monkeypatch)
    client.post("/ingest", files={"image": ("f.jpg", make_frame(0x0F0F), "image/jpeg")})
    watermark = client.get("/situation", params={"format": "text"}).headers["x-situation-watermark"]

    client.app.state.last_spoken_alerts.notify("机に本が置かれました", "change")

    resp = client.get("/situation", params={"format": "text", "since": watermark})
    assert "[カメラの状況" in resp.text
    assert "カメラの発話: 「机に本が置かれました」" in resp.text


def test_situation_text_since_escalates_for_active_correction(tmp_path, monkeypatch, make_frame):
    client = _client(tmp_path, monkeypatch)
    client.post("/ingest", files={"image": ("f.jpg", make_frame(0x0F0F), "image/jpeg")})
    watermark = client.get("/situation", params={"format": "text"}).headers["x-situation-watermark"]

    posted = client.post("/correction", json={"text": "赤信号に見えるのは救急車の赤色灯"})
    assert posted.status_code == 200

    resp = client.get("/situation", params={"format": "text", "since": watermark})
    assert "[カメラの状況" in resp.text
    assert "[人の補足] 赤信号に見えるのは救急車の赤色灯" in resp.text


def test_look_returns_description(tmp_path, monkeypatch):
    monkeypatch.setenv("VISION_FRAME_DIR", _fixtures_dir())
    client = _client(tmp_path, monkeypatch)
    body = client.post("/look").json()
    assert "overview" in body and body["overview"]
    assert "safety" in body["disclaimer"].lower()


def test_look_stores_by_default(tmp_path, monkeypatch):
    monkeypatch.setenv("VISION_FRAME_DIR", _fixtures_dir())
    client = _client(tmp_path, monkeypatch)
    before = client.get("/metrics").json()["counts"]["observations"]
    client.post("/look")  # default store=1 -> joins the timeline
    after = client.get("/metrics").json()["counts"]["observations"]
    assert after == before + 1


def test_look_store_0_is_ephemeral(tmp_path, monkeypatch):
    monkeypatch.setenv("VISION_FRAME_DIR", _fixtures_dir())
    client = _client(tmp_path, monkeypatch)
    before = client.get("/metrics").json()["counts"]["observations"]
    body = client.post("/look?store=0").json()
    after = client.get("/metrics").json()["counts"]["observations"]
    assert body["overview"]  # still answers
    assert after == before  # but stores nothing


def test_look_503_without_camera(tmp_path, monkeypatch):
    monkeypatch.delenv("VISION_FRAME_DIR", raising=False)
    monkeypatch.delenv("VISION_CAMERA_URL", raising=False)
    client = _client(tmp_path, monkeypatch)
    assert client.post("/look").status_code == 503


def test_watch_registration_includes_disclaimer(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    resp = client.post("/watches", json={"name": "red light", "rule": "red", "kind": "keyword"})
    body = resp.json()
    assert body["active"] == 1
    assert "safety" in body["disclaimer"].lower()


def test_enum_watch_registration_returns_501_and_is_not_stored(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    resp = client.post("/watches", json={"name": "red signal", "rule": "赤", "kind": "enum"})

    assert resp.status_code == 501
    assert "keyword" in resp.json()["detail"]
    assert client.get("/watches").json()["watches"] == []
    assert len(client.app.state.watches) == 0


def test_correction_rejected_before_any_observation(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    resp = client.post("/correction", json={"text": "救急車の赤色灯"})
    assert resp.status_code == 409  # no live scene to attach to


def test_correction_roundtrip_and_scene_change_expiry(tmp_path, monkeypatch, make_frame):
    client = _client(tmp_path, monkeypatch)
    # A first frame gives a committed scene the correction can anchor to.
    client.post("/ingest", files={"image": ("f.jpg", make_frame(0x0F0F), "image/jpeg")})

    posted = client.post("/correction", json={"text": "赤信号に見えるのは救急車の赤色灯"})
    assert posted.status_code == 200
    assert posted.json()["recorded"]["text"] == "赤信号に見えるのは救急車の赤色灯"

    # The injected digest now carries the human note and one active correction.
    text = client.get("/situation?format=text").text
    assert "[人の補足] 赤信号に見えるのは救急車の赤色灯" in text
    assert len(client.get("/corrections").json()["active"]) == 1

    # A clearly different frame commits a scene change -> the note is retired.
    client.post("/ingest", files={"image": ("g.jpg", make_frame(0xF0F0), "image/jpeg")})
    text2 = client.get("/situation?format=text").text
    assert "[人の補足]" not in text2
    assert client.get("/corrections").json()["active"] == []


def test_correction_stamps_memory_invalidates_and_rebuilds_t1_t2(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    db = client.app.state.db
    pipeline = client.app.state.pipeline
    created = datetime(2026, 6, 22, 8, 5, tzinfo=UTC)
    _insert_change_at(db, created.isoformat(), "赤信号らしき光", "赤信号が見える")
    pipeline.last_change_at = created
    pipeline.last_visual_hash = 0

    db.upsert_summary(1, "2026-06-22T08:00:00+00:00", "2026-06-22T08:10:00+00:00", "stale-t1", 1)
    db.upsert_summary(2, "2026-06-22T08:00:00+00:00", "2026-06-22T09:00:00+00:00", "stale-t2", 1)
    db.upsert_summary(3, "2026-06-22T06:00:00+00:00", "2026-06-22T12:00:00+00:00", "stale-t3", 1)
    db.upsert_summary(4, "2026-06-22T00:00:00+00:00", "2026-06-23T00:00:00+00:00", "stale-t4", 1)
    db.upsert_summary(1, "2026-06-22T08:10:00+00:00", "2026-06-22T08:20:00+00:00", "keep", 1)

    posted = client.post("/correction", json={"text": "赤く見えるものは救急車の赤色灯"})
    assert posted.status_code == 200
    assert posted.json()["memory"]["invalidated_summaries"] == 4
    assert db.latest()["human_note"] == "赤く見えるものは救急車の赤色灯"
    assert db.get_summary(1, "2026-06-22T08:00:00+00:00") is None
    assert db.get_summary(2, "2026-06-22T08:00:00+00:00") is None
    assert db.get_summary(3, "2026-06-22T06:00:00+00:00") is None
    assert db.get_summary(4, "2026-06-22T00:00:00+00:00") is None
    assert db.get_summary(1, "2026-06-22T08:10:00+00:00")["text"] == "keep"

    summarizer = _EchoSummarizer()
    _join_threads(consolidate_closed_bands(db, summarizer, datetime(2026, 6, 22, 8, 25, tzinfo=UTC)))
    t1 = db.get_summary(1, "2026-06-22T08:00:00+00:00")
    assert t1 is not None
    assert "救急車の赤色灯" in t1["text"]

    _join_threads(consolidate_closed_bands(db, summarizer, datetime(2026, 6, 22, 9, 5, tzinfo=UTC)))
    t2 = db.get_summary(2, "2026-06-22T08:00:00+00:00")
    assert t2 is not None
    assert "救急車の赤色灯" in t2["text"]


def test_correction_metrics_count_retirement_causes(tmp_path, monkeypatch, make_frame):
    client = _client(tmp_path, monkeypatch)

    client.post("/ingest", files={"image": ("a.jpg", make_frame(0x0F0F), "image/jpeg")})
    client.post("/correction", json={"text": "change"})
    client.post("/ingest", files={"image": ("b.jpg", make_frame(0xF0F0), "image/jpeg")})
    client.get("/corrections")

    client.post("/correction", json={"text": "drift"})
    client.app.state.pipeline.last_visual_hash ^= (1 << 16) - 1
    client.get("/corrections")

    client.post("/correction", json={"text": "ttl", "ttl_s": 0.001})
    time.sleep(0.01)
    client.get("/corrections")

    metrics = client.get("/metrics").json()["corrections"]
    assert metrics == {
        "retired_by_change": 1,
        "retired_by_drift": 1,
        "retired_by_ttl": 1,
    }


def test_correction_delete_clears(tmp_path, monkeypatch, make_frame):
    client = _client(tmp_path, monkeypatch)
    client.post("/ingest", files={"image": ("f.jpg", make_frame(0x0F0F), "image/jpeg")})
    client.post("/correction", json={"text": "x"})
    assert client.delete("/corrections").json()["cleared"] >= 1
    assert client.get("/corrections").json()["active"] == []


def _fixtures_dir() -> str:
    return os.path.join(os.path.dirname(__file__), "fixtures", "frames")


def test_capture_returns_jpeg(tmp_path, monkeypatch):
    monkeypatch.setenv("VISION_FRAME_DIR", _fixtures_dir())
    client = _client(tmp_path, monkeypatch)
    resp = client.post("/capture")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"
    assert len(resp.content) > 0


def test_capture_503_without_camera(tmp_path, monkeypatch):
    monkeypatch.delenv("VISION_FRAME_DIR", raising=False)
    monkeypatch.delenv("VISION_CAMERA_URL", raising=False)
    client = _client(tmp_path, monkeypatch)
    assert client.post("/capture").status_code == 503


def test_perception_status_available_with_mock_backend(tmp_path, monkeypatch):
    monkeypatch.setenv("VISION_FRAME_DIR", _fixtures_dir())
    client = _client(tmp_path, monkeypatch)
    body = client.get("/perception/status").json()
    assert body["camera_configured"] is True
    assert body["locked"] is False
    assert body["capability"] == "available"  # mock backend needs no GPU


def test_perception_start_stop_with_mock_backend(tmp_path, monkeypatch):
    monkeypatch.setenv("VISION_FRAME_DIR", _fixtures_dir())
    client = _client(tmp_path, monkeypatch)
    assert client.post("/perception/start").json()["started"] is True
    client.post("/perception/stop")
    assert client.get("/perception/status").json()["running"] is False


def test_perception_locked_refuses(tmp_path, monkeypatch):
    monkeypatch.setenv("VISION_FRAME_DIR", _fixtures_dir())
    monkeypatch.setenv("VISION_PERCEPTION_LOCK", "1")
    client = _client(tmp_path, monkeypatch)
    started = client.post("/perception/start").json()
    assert started["started"] is False
    assert started["reason"] == "locked"
    assert client.get("/perception/status").json()["capability"] == "locked"


def test_situation_context_hook_roundtrips_watermark(tmp_path):
    repo = Path(__file__).resolve().parents[2]
    script = repo / "scripts" / "situation-context-hook.sh"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    log_path = tmp_path / "curl-args.log"
    fake_curl = fake_bin / "curl"
    fake_curl.write_text(
        "#!/usr/bin/env bash\n"
        "headers=''\n"
        "body=''\n"
        "while [ $# -gt 0 ]; do\n"
        "  case \"$1\" in\n"
        "    -D) headers=\"$2\"; shift 2 ;;\n"
        "    -o) body=\"$2\"; shift 2 ;;\n"
        "    --data-urlencode) printf '%s\\n' \"$2\" >> \"$FAKE_CURL_LOG\"; shift 2 ;;\n"
        "    *) shift ;;\n"
        "  esac\n"
        "done\n"
        "printf 'HTTP/1.1 200 OK\\r\\nX-Situation-Watermark: 2026-06-21T12:00:00+00:00\\r\\n\\r\\n' > \"$headers\"\n"
        "printf '[カメラ 12:00] 机（詳細はGET /situation）\\n' > \"$body\"\n"
    )
    fake_curl.chmod(0o755)
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "FAKE_CURL_LOG": str(log_path),
            "MH_SITUATION_INJECT": "1",
            "VISION_BASE_URL": "http://vision-worker",
            "XDG_RUNTIME_DIR": str(tmp_path / "runtime"),
            "CLAUDE_SESSION_ID": "session-1",
        }
    )

    first = subprocess.run(["bash", str(script)], env=env, text=True, capture_output=True, check=True)
    second = subprocess.run(["bash", str(script)], env=env, text=True, capture_output=True, check=True)

    assert first.stdout == "[カメラ 12:00] 机（詳細はGET /situation）\n"
    assert second.stdout == first.stdout
    log = log_path.read_text()
    assert log.count("format=text") == 2
    assert "since=2026-06-21T12:00:00+00:00" in log
