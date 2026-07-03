"""Alert delivery sinks.

When a watch fires, the spoken alert is handed to an `AlertSink`. The default is
`NullAlertSink` (no output) so the worker never speaks into a running face stack
unintentionally. `WebhookAlertSink` POSTs the alert to a configurable URL (a thin
bridge to the stack's `face_say` voice path) and is only used when
`VISION_ALERT_ENABLED=1` and `VISION_ALERT_WEBHOOK` is set. Wiring this to the
live face/voice path and the constrained-enum watches is finished alongside the
stack integration and the model-backed alert path.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Callable, Protocol

from .config import Settings
from .model_client import looks_like_no_change
from .records import Observation
from .watches import Watch


class AlertSink(Protocol):
    def notify(self, text: str, watch_name: str) -> None:
        ...


class NullAlertSink:
    def notify(self, text: str, watch_name: str) -> None:
        return None


class RecordingAlertSink:
    """Captures alerts in memory (for tests)."""

    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []

    def notify(self, text: str, watch_name: str) -> None:
        self.events.append((watch_name, text))


class LastSpokenAlertSink:
    """Records the most recent line handed to the voice sink, then forwards it."""

    def __init__(
        self,
        target: "AlertSink",
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.target = target
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self.last_spoken: tuple[str, datetime] | None = None

    def notify(self, text: str, watch_name: str) -> None:
        self.last_spoken = (text, self._clock())
        self.target.notify(text, watch_name)


class WebhookAlertSink:
    """POST {"text", "watch"} to a URL bridging to the stack's voice path."""

    def __init__(self, url: str, timeout: float = 5.0) -> None:
        self.url = url
        self.timeout = timeout

    def notify(self, text: str, watch_name: str) -> None:
        import httpx

        try:
            httpx.post(self.url, json={"text": text, "watch": watch_name}, timeout=self.timeout)
        except Exception:  # noqa: BLE001 - never let alert delivery break perception
            pass


class AsyncAlertSink:
    """Wraps a sink so `notify()` never blocks the caller (the perception loop).

    Delivery to the voice bridge is an HTTP round-trip plus kokoro synthesis
    (~1-2s); doing it inline stalls the capture->observe loop, which is what made
    ambient narration feel laggy and sporadic during bursts. Here the blocking
    send runs on a background daemon thread instead, so the loop keeps observing.

    Two delivery disciplines:
      * ambient "change" narrations are *latest-wins*: if several pile up before
        the previous one is delivered, only the freshest is spoken (you hear the
        current scene, never a stale backlog);
      * named watch alerts are queued FIFO so they are never silently dropped.
    """

    def __init__(self, target: "AlertSink") -> None:
        self._target = target
        self._cond = threading.Condition()
        self._pending_change: tuple[str, str] | None = None
        self._queue: list[tuple[str, str]] = []
        self._stop = False
        self._thread = threading.Thread(target=self._run, name="alert-sink", daemon=True)
        self._thread.start()

    def notify(self, text: str, watch_name: str) -> None:
        with self._cond:
            if watch_name == "change":
                self._pending_change = (text, watch_name)  # collapse to latest
            else:
                self._queue.append((text, watch_name))
            self._cond.notify()

    def _take(self) -> tuple[str, str] | None:
        # Caller holds the lock. Watch alerts (FIFO) take priority over the
        # collapsible ambient change slot.
        if self._queue:
            return self._queue.pop(0)
        if self._pending_change is not None:
            item, self._pending_change = self._pending_change, None
            return item
        return None

    def _run(self) -> None:
        while True:
            with self._cond:
                while not self._stop and not self._queue and self._pending_change is None:
                    self._cond.wait()
                if self._stop:
                    return
                item = self._take()
            if item is not None:
                try:
                    self._target.notify(item[0], item[1])
                except Exception:  # noqa: BLE001 - never let delivery break the worker
                    pass

    def close(self) -> None:
        with self._cond:
            self._stop = True
            self._cond.notify()
        self._thread.join(timeout=2)


def make_alert_text(watch: Watch, obs: Observation) -> str:
    """Short spoken phrase generated from the watch intent (keep it brief)."""
    return f"Heads up: {watch.name}."


def make_change_text(obs: Observation) -> str:
    """Short spoken line describing a scene change (never OCR/fine text).

    Prefers the model's one-line `change_from_prev`; falls back to the `overview`
    ("what is there now") for the first observation, when there is no prior scene
    to diff against.
    """
    change = (obs.change_from_prev or "").strip()
    if change:
        return change
    return (obs.overview or "").strip()


class ChangeNarrator:
    """Speaks a short line on each *salient* committed change (ambient mode).

    Every observation handed here already passed the change gate + dedup, so it is
    a real, non-jitter scene change. This adds the final salience guard before
    speaking: skip low-confidence reads, skip empty/too-short descriptions, and
    rate-limit so a fast-changing scene cannot turn into chatter. Disabled by
    default; flip `enabled` at runtime. Reuses the configured alert sink, so it is
    a no-op until the voice webhook is wired (VISION_ALERT_ENABLED + webhook).
    """

    def __init__(
        self,
        sink: "AlertSink",
        *,
        enabled: bool = False,
        min_interval_s: float = 4.0,
        min_chars: int = 3,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.sink = sink
        self.enabled = enabled
        self.min_interval_s = max(0.0, min_interval_s)
        self.min_chars = max(0, min_chars)
        self._clock = clock
        self._last_spoke_at: float | None = None

    def consider(self, obs: Observation) -> bool:
        """Narrate this change if it clears the salience gate. Returns True if spoken."""
        if not self.enabled:
            return False
        if getattr(obs, "low_confidence", False):
            return False
        # Only speak real changes. The model marks the first/baseline frame and
        # any "same scene" read as changed=False; those are never spoken (this is
        # what keeps ambient mode from announcing "this is the first frame" or
        # "nothing changed"). Pipeline suppression already drops most of these
        # before they reach here, but the baseline frame is committed (and thus
        # delivered to the narrator), so guard it here too.
        if not getattr(obs, "changed", True):
            return False
        text = make_change_text(obs)
        if len(text) < self.min_chars:
            return False
        # Last-ditch guard: never voice a "nothing changed" sentence, even if an
        # upstream client left changed=true (model self-contradiction).
        if looks_like_no_change(text):
            return False
        now = self._clock()
        if self._last_spoke_at is not None and now - self._last_spoke_at < self.min_interval_s:
            return False
        self._last_spoke_at = now
        self.sink.notify(text, "change")
        return True


def build_alert_sink(settings: Settings) -> AlertSink:
    if settings.alert_enabled and settings.alert_webhook:
        return WebhookAlertSink(settings.alert_webhook)
    return NullAlertSink()
