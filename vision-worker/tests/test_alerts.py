from __future__ import annotations

import threading
from datetime import datetime, timezone

from vision_worker.alerts import (
    AsyncAlertSink,
    ChangeNarrator,
    LastSpokenAlertSink,
    RecordingAlertSink,
    make_change_text,
)
from vision_worker.records import Observation


def _obs(
    *,
    overview="a tidy desk",
    change="a mug appeared on the desk",
    low_confidence=False,
    changed=True,
):
    return Observation(
        is_text=False,
        ocr_full="",
        overview=overview,
        change_from_prev=change,
        changed=changed,
        low_confidence=low_confidence,
    )


def test_make_change_text_prefers_change_then_overview():
    assert make_change_text(_obs(change="someone walked in")) == "someone walked in"
    # First observation has no diff -> fall back to the overview ("what is there").
    assert make_change_text(_obs(change="")) == "a tidy desk"
    assert make_change_text(_obs(change="  ", overview="  ")) == ""


def test_disabled_narrator_says_nothing():
    sink = RecordingAlertSink()
    narrator = ChangeNarrator(sink, enabled=False)
    assert narrator.consider(_obs()) is False
    assert sink.events == []


def test_enabled_narrator_speaks_the_change():
    sink = RecordingAlertSink()
    narrator = ChangeNarrator(sink, enabled=True, min_interval_s=0.0)
    assert narrator.consider(_obs(change="a mug appeared")) is True
    assert sink.events == [("change", "a mug appeared")]


def test_last_spoken_sink_records_named_watch_alert_with_utc_timestamp():
    spoken_at = datetime(2026, 6, 21, 12, 0, tzinfo=timezone.utc)
    target = RecordingAlertSink()
    sink = LastSpokenAlertSink(target, clock=lambda: spoken_at)

    sink.notify("Heads up: red light.", "red light")

    assert sink.last_spoken == ("Heads up: red light.", spoken_at)
    assert target.events == [("red light", "Heads up: red light.")]


def test_narrator_records_last_spoken_only_when_it_fires():
    spoken_at = datetime(2026, 6, 21, 12, 1, tzinfo=timezone.utc)
    target = RecordingAlertSink()
    sink = LastSpokenAlertSink(target, clock=lambda: spoken_at)
    narrator = ChangeNarrator(sink, enabled=True, min_interval_s=0.0)

    assert narrator.consider(_obs(change="a book moved")) is True
    assert sink.last_spoken == ("a book moved", spoken_at)

    assert narrator.consider(_obs(change="no significant change", changed=False)) is False
    assert sink.last_spoken == ("a book moved", spoken_at)
    assert target.events == [("change", "a book moved")]


def test_low_confidence_is_not_narrated():
    sink = RecordingAlertSink()
    narrator = ChangeNarrator(sink, enabled=True, min_interval_s=0.0)
    assert narrator.consider(_obs(low_confidence=True)) is False
    assert sink.events == []


def test_no_change_observation_is_not_narrated():
    # The model's own verdict that nothing meaningful changed (including the
    # first/baseline frame) must never be spoken, even with a non-empty sentence.
    sink = RecordingAlertSink()
    narrator = ChangeNarrator(sink, enabled=True, min_interval_s=0.0)
    assert narrator.consider(_obs(change="this is the first frame", changed=False)) is False
    assert narrator.consider(_obs(change="no change from the previous frame", changed=False)) is False
    assert sink.events == []


def test_no_change_text_is_not_narrated_even_if_flagged_changed():
    # Defends against a model that contradicts itself (changed=True while the
    # sentence plainly says nothing changed). The voice must stay silent.
    sink = RecordingAlertSink()
    narrator = ChangeNarrator(sink, enabled=True, min_interval_s=0.0)
    assert narrator.consider(_obs(change="前の状態から変化はありません。", changed=True)) is False
    assert narrator.consider(_obs(change="No significant change.", changed=True)) is False
    assert sink.events == []


def test_empty_change_is_not_narrated():
    sink = RecordingAlertSink()
    narrator = ChangeNarrator(sink, enabled=True, min_interval_s=0.0)
    assert narrator.consider(_obs(change="", overview="")) is False
    assert sink.events == []


def test_rate_limit_suppresses_back_to_back_lines():
    clock = {"t": 100.0}
    sink = RecordingAlertSink()
    narrator = ChangeNarrator(sink, enabled=True, min_interval_s=4.0, clock=lambda: clock["t"])
    assert narrator.consider(_obs(change="first change")) is True
    clock["t"] += 1.0  # within the rate-limit window
    assert narrator.consider(_obs(change="second change")) is False
    clock["t"] += 4.0  # past the window
    assert narrator.consider(_obs(change="third change")) is True
    assert [t for _, t in sink.events] == ["first change", "third change"]


class _GatedSink:
    """Target sink that blocks inside notify() until the test releases each call,
    so the AsyncAlertSink's background thread can be driven deterministically."""

    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []
        self._started = threading.Semaphore(0)
        self._release = threading.Semaphore(0)

    def notify(self, text: str, watch_name: str) -> None:
        self._started.release()
        assert self._release.acquire(timeout=2), "release never came"
        self.events.append((watch_name, text))

    def wait_started(self) -> None:
        assert self._started.acquire(timeout=2), "notify never started"

    def let_go(self) -> None:
        self._release.release()


def test_async_notify_does_not_block_caller():
    g = _GatedSink()
    s = AsyncAlertSink(g)
    s.notify("x", "change")  # returns immediately even though target will block
    g.wait_started()
    g.let_go()
    s.close()
    assert g.events == [("change", "x")]


def test_async_change_is_latest_wins():
    g = _GatedSink()
    s = AsyncAlertSink(g)
    s.notify("c1", "change")
    g.wait_started()          # c1 picked up, blocked in target
    s.notify("c2", "change")  # collapses into the single change slot...
    s.notify("c3", "change")  # ...latest wins (c2 dropped)
    g.let_go()                # c1 completes
    g.wait_started()          # thread now sends the freshest (c3)
    g.let_go()
    s.close()
    assert g.events == [("change", "c1"), ("change", "c3")]


def test_async_watch_alerts_are_fifo_not_dropped():
    g = _GatedSink()
    s = AsyncAlertSink(g)
    s.notify("first", "red light")
    g.wait_started()
    s.notify("second", "red light")  # queued, never dropped
    s.notify("third", "red light")
    g.let_go(); g.wait_started()
    g.let_go(); g.wait_started()
    g.let_go()
    s.close()
    assert g.events == [
        ("red light", "first"),
        ("red light", "second"),
        ("red light", "third"),
    ]
