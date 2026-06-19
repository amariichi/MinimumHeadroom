from __future__ import annotations

from vision_worker.gate import ChangeGate


def test_first_frame_is_changed(make_frame):
    gate = ChangeGate()
    assert gate.is_changed(make_frame(0x0F0F)) is True


def test_identical_frames_are_not_changed(make_frame):
    gate = ChangeGate()
    frame = make_frame(0x0F0F)
    assert gate.is_changed(frame) is True
    assert gate.is_changed(frame) is False
    assert gate.is_changed(frame) is False


def test_different_frames_are_changed(make_frame):
    gate = ChangeGate()
    assert gate.is_changed(make_frame(0x000F)) is True  # top row black
    assert gate.is_changed(make_frame(0xF000)) is True  # bottom row black


def test_scene_is_steady_after_repeats(make_frame):
    gate = ChangeGate(steady_frames=2)
    frame = make_frame(0x1234)
    gate.is_changed(frame)
    assert gate.scene_is_steady() is False
    gate.is_changed(frame)
    gate.is_changed(frame)
    assert gate.scene_is_steady() is True
