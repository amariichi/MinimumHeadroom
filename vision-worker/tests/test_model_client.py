from __future__ import annotations

from vision_worker.model_client import (
    DiffusionGemmaClient,
    INSTRUCTION,
    RESPONSE_SCHEMA,
    MockModelClient,
    compose_correction_advisory,
    compose_instruction,
    looks_like_no_change,
)
from vision_worker.records import PrevState


class _Response:
    def raise_for_status(self):
        return None

    def json(self):
        return {
            "choices": [
                {
                    "message": {
                        "content": (
                            '{"is_text": false, "ocr_full": "", "overview": "机の上の赤い物", '
                            '"changed": false, "change_from_prev": "変化はありません"}'
                        )
                    }
                }
            ]
        }


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


def test_instruction_is_world_oriented_and_suppresses_ego_motion():
    # The camera is hand-movable: memories must describe the world, and
    # camera-only differences (motion/focus/blur/lighting) must not count as
    # a change nor be described as one.
    assert "WORLD" in INSTRUCTION
    assert "Never describe the camera" in INSTRUCTION
    assert "only by camera motion" in INSTRUCTION
    assert "NEVER describe camera movement" in INSTRUCTION
    assert "describe the new subject, not the movement" in INSTRUCTION
    # The old frame-diff framing treated a mere angle change as a change.
    assert "different view or camera angle" not in INSTRUCTION


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


def test_diffusiongemma_debug_prompt_logs_outbound_text(monkeypatch, capsys, make_scene):
    seen = {}

    def fake_post(url, json, timeout):
        seen["url"] = url
        seen["prompt"] = json["messages"][0]["content"][0]["text"]
        seen["timeout"] = timeout
        return _Response()

    import httpx

    monkeypatch.setattr(httpx, "post", fake_post)
    client = DiffusionGemmaClient(
        "http://model/v1",
        "test-model",
        output_lang="ja",
        debug_prompt=True,
    )
    client.observe(
        make_scene(3),
        PrevState(ocr_full="", overview="赤信号のような赤い光"),
        correction="赤く見えるものは信号ではなく救急車の赤色灯",
    )

    err = capsys.readouterr().err
    assert seen["url"] == "http://model/v1/chat/completions"
    assert "Previous overview: 赤信号のような赤い光" in seen["prompt"]
    assert "Human note (may be stale): 赤く見えるものは信号ではなく救急車の赤色灯" in seen["prompt"]
    assert "VISION_DEBUG_PROMPT request text" in err
    assert "Human note (may be stale): 赤く見えるものは信号ではなく救急車の赤色灯" in err


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


def test_instruction_and_schema_request_salient_objects():
    assert '"salient_objects"' in INSTRUCTION
    assert "Exclude people" in INSTRUCTION
    assert "salient_objects" in RESPONSE_SCHEMA["properties"]
    # Deliberately NOT required: models that omit it degrade to no entities.
    assert "salient_objects" not in RESPONSE_SCHEMA["required"]


def test_parse_salient_objects_bounds_and_cleans():
    from vision_worker.model_client import parse_salient_objects

    assert parse_salient_objects(None) == []
    assert parse_salient_objects("not a list") == []
    assert parse_salient_objects([1, "", "  "]) == []
    assert parse_salient_objects([" マグカップ "]) == ["マグカップ"]
    assert parse_salient_objects(["x" * 200]) == ["x" * 64]
    assert parse_salient_objects([f"o{i}" for i in range(9)]) == [
        "o0", "o1", "o2", "o3", "o4"
    ]


def test_mock_client_emits_salient_objects_for_scene_frames(make_scene, make_frame):
    mock = MockModelClient()
    scene = mock.observe(make_scene(1), None)
    assert scene.is_text is False
    assert len(scene.salient_objects) == 1
    assert scene.salient_objects[0].startswith("mock-object-")
    # Text frames carry no entities: OCR text is already stored verbatim.
    text = mock.observe(make_frame(0xF0F0), None)
    assert text.is_text is True
    assert text.salient_objects == []


def test_salient_objects_exclude_people_and_room_fixtures():
    from vision_worker.model_client import looks_like_entity_noise, parse_salient_objects

    # Live diffusiongemma returned 男性 despite the instruction; the parse
    # layer must enforce the people ban, and fixed room features make useless
    # 見覚え callbacks.
    assert parse_salient_objects(["男性", "机", "棚", "Amazonの箱"]) == ["Amazonの箱"]
    assert parse_salient_objects(["女性の顔", "デスク", "イチゴ柄のマグカップ"]) == [
        "イチゴ柄のマグカップ"
    ]
    assert parse_salient_objects(["person", "desk", "red mug"]) == ["red mug"]
    # 人 alone is a person, but 人形 (doll) is an object and must survive.
    assert looks_like_entity_noise("人")
    assert not looks_like_entity_noise("人形")
    # Longer distinctive names that merely include a fixture word survive too.
    assert not looks_like_entity_noise("イチゴ柄のマグカップが載った机")
