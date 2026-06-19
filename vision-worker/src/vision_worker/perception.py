"""Continuous perception loop (Mode B) and its AI-controllable start gating.

`decide_start` is a pure function (easy to unit-test) that implements the agreed
policy: a hard prohibition switch wins; otherwise a CPU-free backend can always
run; for the GPU model the loop needs the model endpoint up, and if it is not,
the decision depends on whether there is enough free VRAM to start it without
displacing another process (e.g. the Hermes local LLM). The worker never stops
another process itself — it reports, and the AI/user decide.

`PerceptionLoop` runs the capture->pipeline loop on a background thread that can
be started and stopped at runtime.
"""

from __future__ import annotations

import threading


def decide_start(
    *,
    locked: bool,
    backend: str,
    model_is_healthy: bool,
    free_vram_mb: int | None,
    needed_vram_mb: int,
) -> dict:
    """Return {"can_start": bool, "reason": str, ...} for /perception/start."""
    if locked:
        return {"can_start": False, "reason": "locked"}
    if backend != "diffusiongemma":
        # Mock or any CPU-free backend needs no GPU.
        return {"can_start": True, "reason": "ok"}
    if model_is_healthy:
        return {"can_start": True, "reason": "ok"}
    # diffusiongemma selected but its endpoint is not up yet.
    if free_vram_mb is None:
        return {"can_start": False, "reason": "needs_model_start", "free_vram_mb": None}
    if free_vram_mb >= needed_vram_mb:
        # Enough headroom to start the model without displacing anything.
        return {
            "can_start": False,
            "reason": "needs_model_start",
            "free_vram_mb": free_vram_mb,
            "needed_vram_mb": needed_vram_mb,
        }
    # Not enough VRAM: starting the model would require freeing another process.
    return {
        "can_start": False,
        "reason": "insufficient_vram",
        "free_vram_mb": free_vram_mb,
        "needed_vram_mb": needed_vram_mb,
    }


class PerceptionLoop:
    def __init__(self, pipeline, capture_source, interval_ms: int, lock: threading.Lock) -> None:
        self._pipeline = pipeline
        self._capture = capture_source
        self._interval = max(0.0, interval_ms / 1000.0)
        self._lock = lock  # shared with /ingest so pipeline state stays single-writer
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.frames = 0
        self.last_error: str | None = None

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self.is_running():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="perception-loop", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=5)
        self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                frame = self._capture.capture() if self._capture else None
                if frame:
                    with self._lock:
                        self._pipeline.process_frame(frame)
                    self.frames += 1
            except Exception as exc:  # noqa: BLE001 - keep looping through transient errors
                self.last_error = str(exc)
            self._stop.wait(self._interval)
