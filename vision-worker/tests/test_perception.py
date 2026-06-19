from __future__ import annotations

import threading
import time

from vision_worker.perception import PerceptionLoop, decide_start


def test_locked_refuses():
    d = decide_start(locked=True, backend="diffusiongemma", model_is_healthy=True, free_vram_mb=30000, needed_vram_mb=24000)
    assert d["can_start"] is False
    assert d["reason"] == "locked"


def test_mock_backend_needs_no_gpu():
    d = decide_start(locked=False, backend="mock", model_is_healthy=False, free_vram_mb=0, needed_vram_mb=24000)
    assert d["can_start"] is True


def test_diffusiongemma_healthy_starts():
    d = decide_start(locked=False, backend="diffusiongemma", model_is_healthy=True, free_vram_mb=1000, needed_vram_mb=24000)
    assert d["can_start"] is True


def test_model_down_with_free_vram_needs_model_start():
    d = decide_start(locked=False, backend="diffusiongemma", model_is_healthy=False, free_vram_mb=31000, needed_vram_mb=24000)
    assert d["can_start"] is False
    assert d["reason"] == "needs_model_start"


def test_model_down_insufficient_vram_needs_confirmation():
    d = decide_start(locked=False, backend="diffusiongemma", model_is_healthy=False, free_vram_mb=2000, needed_vram_mb=24000)
    assert d["can_start"] is False
    assert d["reason"] == "insufficient_vram"


class _FakePipeline:
    def __init__(self):
        self.n = 0

    def process_frame(self, frame):
        self.n += 1


class _FakeCapture:
    def capture(self):
        return b"frame-bytes"


def test_loop_start_and_stop():
    pipeline = _FakePipeline()
    loop = PerceptionLoop(pipeline, _FakeCapture(), interval_ms=10, lock=threading.Lock())
    assert loop.is_running() is False
    loop.start()
    time.sleep(0.1)
    was_running = loop.is_running()
    loop.stop()
    assert was_running is True
    assert loop.is_running() is False
    assert pipeline.n >= 1
