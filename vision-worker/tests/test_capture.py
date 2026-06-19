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
