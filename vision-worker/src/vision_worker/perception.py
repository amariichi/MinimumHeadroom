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
from datetime import datetime, timezone
from typing import Callable


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


def next_interval_s(
    committed: bool,
    burst_left: int,
    *,
    active_s: float,
    idle_s: float,
    burst_frames: int,
) -> tuple[float, int]:
    """Adaptive cadence: poll slowly when the scene is static, fast after a change.

    Pure so it is trivially unit-testable. A committed observation (i.e. a real,
    non-jitter scene change) re-arms a burst of `burst_frames` fast polls; once the
    burst drains the loop falls back to the slow idle cadence. Fewer fetches while
    nothing happens directly means less /snapshot traffic over the mobile uplink.

    Returns (wait_seconds, new_burst_left).
    """
    if committed:
        burst_left = burst_frames
    if burst_left > 0:
        return active_s, burst_left - 1
    return idle_s, 0


class PerceptionLoop:
    def __init__(
        self,
        pipeline,
        capture_source,
        interval_ms: int,
        lock: threading.Lock,
        *,
        idle_interval_ms: int | None = None,
        burst_frames: int = 0,
        idle_callback: Callable[[], None] | None = None,
    ) -> None:
        self._pipeline = pipeline
        self._capture = capture_source
        self._active_interval = max(0.0, interval_ms / 1000.0)
        # idle defaults to the active interval, i.e. a constant cadence, unless an
        # explicit (slower) idle interval is given.
        idle_ms = interval_ms if idle_interval_ms is None else idle_interval_ms
        self._idle_interval = max(0.0, idle_ms / 1000.0)
        self._burst_frames = max(0, burst_frames)
        # Start responsive: spend the first frames at the active cadence.
        self._burst_left = self._burst_frames
        self._lock = lock  # shared with /ingest so pipeline state stays single-writer
        self._idle_callback = idle_callback
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.frames = 0
        self.last_error: str | None = None
        # When the loop last looked at the scene (any successful capture+process,
        # whether or not it committed a change). GET /situation uses this as the
        # "confirmed_at" proof-of-liveness: while the loop runs it advances each
        # iteration, so a still scene's stable_seconds keeps growing on re-read.
        self.last_observed_at: datetime | None = None

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
            committed = False
            try:
                frame = self._capture.capture() if self._capture else None
                if frame:
                    with self._lock:
                        committed = self._pipeline.process_frame(frame) is not None
                    self.frames += 1
                    self.last_observed_at = datetime.now(timezone.utc)
            except Exception as exc:  # noqa: BLE001 - keep looping through transient errors
                self.last_error = str(exc)
            wait_s, self._burst_left = next_interval_s(
                committed,
                self._burst_left,
                active_s=self._active_interval,
                idle_s=self._idle_interval,
                burst_frames=self._burst_frames,
            )
            if (
                self._idle_callback is not None
                and not committed
                and wait_s == self._idle_interval
            ):
                try:
                    self._idle_callback()
                except Exception as exc:  # noqa: BLE001 - keep perception alive
                    self.last_error = str(exc)
            self._stop.wait(wait_s)
