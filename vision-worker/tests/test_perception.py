from __future__ import annotations

import threading
import time

from vision_worker.perception import PerceptionLoop, decide_start, next_interval_s


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


def test_next_interval_idle_when_no_change():
    wait, burst = next_interval_s(False, 0, active_s=1.5, idle_s=5.0, burst_frames=4)
    assert wait == 5.0
    assert burst == 0


def test_next_interval_change_arms_burst():
    wait, burst = next_interval_s(True, 0, active_s=1.5, idle_s=5.0, burst_frames=4)
    assert wait == 1.5
    assert burst == 3


def test_next_interval_burst_drains_then_idles():
    burst = 2
    wait, burst = next_interval_s(False, burst, active_s=1.5, idle_s=5.0, burst_frames=4)
    assert (wait, burst) == (1.5, 1)
    wait, burst = next_interval_s(False, burst, active_s=1.5, idle_s=5.0, burst_frames=4)
    assert (wait, burst) == (1.5, 0)
    wait, burst = next_interval_s(False, burst, active_s=1.5, idle_s=5.0, burst_frames=4)
    assert (wait, burst) == (5.0, 0)


def test_next_interval_change_during_burst_rearms():
    wait, burst = next_interval_s(True, 1, active_s=1.5, idle_s=5.0, burst_frames=4)
    assert (wait, burst) == (1.5, 3)


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
