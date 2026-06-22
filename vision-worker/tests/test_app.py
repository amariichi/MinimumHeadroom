from __future__ import annotations

import os

from fastapi.testclient import TestClient


def _client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setenv("VISION_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setenv("VISION_DB_PATH", str(tmp_path / "v.db"))
    monkeypatch.setenv("VISION_MODEL_BACKEND", "mock")
    from vision_worker.app import create_app

    return TestClient(create_app())


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
    assert "safety" in body["disclaimer"].lower()


def test_situation_reports_current_after_ingest(tmp_path, monkeypatch, make_frame):
    client = _client(tmp_path, monkeypatch)
    client.post("/ingest", files={"image": ("f.jpg", make_frame(0x0F0F), "image/jpeg")})
    body = client.get("/situation").json()
    assert body["current"] is not None
    assert body["current"]["overview"]  # non-empty
    # Not observing via the loop here, so stable_seconds may be 0+ but present.
    assert isinstance(body["current"]["stable_seconds"], int)
    assert len(body["recent"]) == 1
    assert body["recent"][0]["overview"] == body["current"]["overview"]


def test_situation_text_format(tmp_path, monkeypatch, make_frame):
    client = _client(tmp_path, monkeypatch)
    client.post("/ingest", files={"image": ("f.jpg", make_frame(0x0F0F), "image/jpeg")})
    resp = client.get("/situation?format=text")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    assert "[カメラの状況]" in resp.text
    assert "現在:" in resp.text


def test_look_returns_description(tmp_path, monkeypatch):
    monkeypatch.setenv("VISION_FRAME_DIR", _fixtures_dir())
    client = _client(tmp_path, monkeypatch)
    body = client.post("/look").json()
    assert "overview" in body and body["overview"]
    assert "safety" in body["disclaimer"].lower()


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
