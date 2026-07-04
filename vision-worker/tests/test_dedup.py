from __future__ import annotations

from vision_worker import dedup


def test_identical_text_is_duplicate():
    assert dedup.is_duplicate("hello world", "hello world") is True


def test_whitespace_only_difference_is_duplicate():
    assert dedup.is_duplicate("hello   world", "hello world") is True


def test_empty_vs_empty_is_duplicate():
    assert dedup.is_duplicate("", "") is True


def test_appearing_text_is_not_duplicate():
    assert dedup.is_duplicate("", "Problem 12") is False


def test_minor_ocr_jitter_is_duplicate():
    a = "Problem 12. Solve for x in the equation below."
    b = "Problem 12. Solve for x in the equatlon below."  # one OCR slip
    assert dedup.is_duplicate(a, b) is True


def test_real_change_is_not_duplicate():
    assert dedup.is_duplicate("Problem 12", "Problem 13 is completely different here") is False
