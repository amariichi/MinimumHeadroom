from __future__ import annotations

from vision_worker.capture import (
    DirectoryCaptureSource,
    NetworkCaptureSource,
    build_capture_source,
)


class _Settings:
    camera_url = None
    frame_dir = None


def test_directory_capture_rotates(tmp_path, make_frame):
    (tmp_path / "a.jpg").write_bytes(make_frame(0x000F))
    (tmp_path / "b.jpg").write_bytes(make_frame(0xF000))
    src = DirectoryCaptureSource(str(tmp_path))
    f1 = src.capture()
    f2 = src.capture()
    f3 = src.capture()
    assert f1 and f2
    assert f1 != f2
    assert f3 == f1  # wraps around


def test_build_capture_source_selection():
    s = _Settings()
    assert build_capture_source(s) is None
    s.frame_dir = "/tmp/frames"
    assert isinstance(build_capture_source(s), DirectoryCaptureSource)
    s.camera_url = "http://cam.local/snapshot"
    assert isinstance(build_capture_source(s), NetworkCaptureSource)  # camera_url wins


def test_network_capture_source_reresolves_after_failures(monkeypatch):
    class Response:
        def __init__(self, content: bytes, *, ok: bool = True) -> None:
            self.content = content
            self.ok = ok

        def raise_for_status(self) -> None:
            if not self.ok:
                raise RuntimeError("bad status")

    calls: list[str] = []

    def fake_get(url: str, timeout: float):
        calls.append(url)
        if url == "http://old.invalid/snapshot":
            return Response(b"", ok=False)
        return Response(b"new-frame")

    import httpx

    monkeypatch.setattr(httpx, "get", fake_get)
    src = NetworkCaptureSource(
        "http://old.invalid/snapshot",
        resolver=lambda: "http://new.invalid/snapshot",
        rediscover_after_failures=2,
        rotate_ccw=0,
    )

    try:
        src.capture()
    except RuntimeError:
        pass
    else:
        raise AssertionError("first failed capture should be surfaced")

    assert src.capture() == b"new-frame"
    assert calls == [
        "http://old.invalid/snapshot",
        "http://old.invalid/snapshot",
        "http://new.invalid/snapshot",
    ]
    assert src.url == "http://new.invalid/snapshot"
