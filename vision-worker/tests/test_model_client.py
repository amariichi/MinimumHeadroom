from __future__ import annotations

from vision_worker.model_client import (
    INSTRUCTION,
    RESPONSE_SCHEMA,
    MockModelClient,
    compose_correction_advisory,
    compose_instruction,
    looks_like_no_change,
)
from vision_worker.records import PrevState


def test_default_is_english_base_instruction():
    assert compose_instruction() == INSTRUCTION
    assert compose_instruction("en") == INSTRUCTION


def test_japanese_appends_language_directive_but_keeps_base():
    out = compose_instruction("ja")
    assert out.startswith(INSTRUCTION)
    assert "Japanese" in out
    # ocr_full must stay verbatim, not translated.
    assert "ocr_full" in out


def test_unknown_language_falls_back_to_english():
    assert compose_instruction("kana-please") == INSTRUCTION


def test_instruction_and_schema_request_changed_verdict():
    assert '"changed"' in INSTRUCTION
    assert "changed" in RESPONSE_SCHEMA["properties"]
    assert "changed" in RESPONSE_SCHEMA["required"]


def test_looks_like_no_change_detects_en_and_ja():
    assert looks_like_no_change("前の状態から変化はありません。")
    assert looks_like_no_change("最初のフレームです。")
    assert looks_like_no_change("No significant change.")
    assert looks_like_no_change("Nothing changed in the scene.")
    # Real changes must not be flagged.
    assert not looks_like_no_change("デスクに本とスマートフォンが追加された。")
    assert not looks_like_no_change("A book appeared on the desk.")
    assert not looks_like_no_change("")
    # A described change with a "no big change" caveat is a CHANGE, not suppressed.
    assert not looks_like_no_change("手が動いたが大きな変化はない。")
    assert not looks_like_no_change("本が追加されたが配置に変化はない。")
    assert not looks_like_no_change("A hand moved but no significant change.")


def test_correction_advisory_empty_when_none_or_blank():
    assert compose_correction_advisory(None) == ""
    assert compose_correction_advisory("   ") == ""


def test_correction_advisory_includes_text_and_over_anchor_guardrails():
    out = compose_correction_advisory("赤信号に見えるのは救急車の赤色灯")
    assert "赤信号に見えるのは救急車の赤色灯" in out
    assert "may be stale" in out
    # Must keep the model reporting reality, so the note cannot, by itself,
    # make it report "no change" forever.
    assert "do not let this" in out
    assert "suppress a genuine change" in out
    # It is a separate appended block, not a replacement of prior state.
    assert out.startswith("\n\n")


def test_mock_first_frame_is_not_a_change(make_frame):
    obs = MockModelClient().observe(make_frame(0x0F0F), None)
    assert obs.changed is False


def test_mock_marks_changed_when_scene_differs(make_frame):
    mock = MockModelClient()
    first = mock.observe(make_frame(0x000F), None)
    prev = PrevState(ocr_full=first.ocr_full, overview=first.overview)
    same = mock.observe(make_frame(0x000F), prev)
    diff = mock.observe(make_frame(0xF000), prev)
    assert same.changed is False
    assert diff.changed is True
