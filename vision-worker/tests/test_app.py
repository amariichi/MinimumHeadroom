from __future__ import annotations

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


def test_watch_registration_includes_disclaimer(tmp_path, monkeypatch):
    client = _client(tmp_path, monkeypatch)
    resp = client.post("/watches", json={"name": "red light", "rule": "red", "kind": "keyword"})
    body = resp.json()
    assert body["active"] == 1
    assert "safety" in body["disclaimer"].lower()
