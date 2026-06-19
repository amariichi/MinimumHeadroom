from __future__ import annotations

from vision_worker.alerts import (
    NullAlertSink,
    RecordingAlertSink,
    build_alert_sink,
    make_alert_text,
)
from vision_worker.records import Observation
from vision_worker.watches import Watch, WatchRegistry, keyword_matches


def _obs(overview="", ocr="", change="", is_text=True) -> Observation:
    return Observation(is_text=is_text, ocr_full=ocr, overview=overview, change_from_prev=change)


def test_keyword_matches_searches_all_text_fields():
    assert keyword_matches("red", _obs(overview="a red traffic light"))
    assert keyword_matches("problem 12", _obs(ocr="Problem 12 solve for x"))
    assert keyword_matches("turned", _obs(change="page turned"))
    assert not keyword_matches("zebra", _obs(overview="a house in a field"))


def test_registry_fires_keyword_but_not_enum():
    reg = WatchRegistry()
    reg.add(Watch("red light", "red", "keyword"))
    reg.add(Watch("signal", "red", "enum"))  # needs a model call; not fired here
    fired = reg.evaluate(_obs(overview="the red light is on"))
    assert [w.name for w in fired] == ["red light"]
    assert len(reg) == 2


def test_make_alert_text_mentions_watch():
    assert "red light" in make_alert_text(Watch("red light", "red"), _obs(overview="red light"))


def test_recording_sink_captures():
    sink = RecordingAlertSink()
    sink.notify("hello", "w1")
    assert sink.events == [("w1", "hello")]


def test_build_alert_sink_defaults_to_null(monkeypatch):
    monkeypatch.delenv("VISION_ALERT_ENABLED", raising=False)
    monkeypatch.delenv("VISION_ALERT_WEBHOOK", raising=False)
    from vision_worker.config import load_settings

    assert isinstance(build_alert_sink(load_settings()), NullAlertSink)
