"""Alert delivery sinks.

When a watch fires, the spoken alert is handed to an `AlertSink`. The default is
`NullAlertSink` (no output) so the worker never speaks into a running face stack
unintentionally. `WebhookAlertSink` POSTs the alert to a configurable URL (a thin
bridge to the stack's `face_say` voice path) and is only used when
`VISION_ALERT_ENABLED=1` and `VISION_ALERT_WEBHOOK` is set. Wiring this to the
live face/voice path and the constrained-enum watches is finished alongside the
stack integration (milestone M6) and the model-backed alert path (M5).
"""

from __future__ import annotations

from typing import Protocol

from .config import Settings
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


def make_alert_text(watch: Watch, obs: Observation) -> str:
    """Short spoken phrase generated from the watch intent (keep it brief)."""
    return f"Heads up: {watch.name}."


def build_alert_sink(settings: Settings) -> AlertSink:
    if settings.alert_enabled and settings.alert_webhook:
        return WebhookAlertSink(settings.alert_webhook)
    return NullAlertSink()
