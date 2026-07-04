from __future__ import annotations

from vision_worker import vote
from vision_worker.records import Observation


def _obs(ocr: str = "", overview: str = "", is_text: bool = True, low: bool = False) -> Observation:
    return Observation(
        is_text=is_text,
        ocr_full=ocr,
        overview=overview,
        change_from_prev="c",
        low_confidence=low,
    )


def test_single_candidate_passthrough():
    merged, idx = vote.reconcile([_obs(ocr="hello")])
    assert idx == 0
    assert merged.ocr_full == "hello"


def test_medoid_picks_the_agreeing_majority():
    cands = [
        _obs(ocr="Problem 12 solve for x"),
        _obs(ocr="Problem 12 solve for x"),
        _obs(ocr="Problrm l2 zolve fnr x"),  # garbled outlier
    ]
    merged, idx = vote.reconcile(cands)
    assert merged.is_text is True
    assert merged.ocr_full == "Problem 12 solve for x"
    assert idx in (0, 1)


def test_disagreement_sets_low_confidence():
    cands = [
        _obs(ocr="apple pie recipe with cinnamon"),
        _obs(ocr="xylophone zebra umbrella jazz"),
    ]
    merged, _ = vote.reconcile(cands)
    assert merged.low_confidence is True


def test_is_text_majority_and_scene_field():
    cands = [
        _obs(is_text=False, overview="a brown house in a field"),
        _obs(is_text=False, overview="a brown house on a green field"),
        _obs(is_text=True, ocr="random text"),  # minority
    ]
    merged, _ = vote.reconcile(cands)
    assert merged.is_text is False
    assert merged.ocr_full == ""
    assert "house" in merged.overview
    assert merged.low_confidence is True  # type vote was not unanimous
