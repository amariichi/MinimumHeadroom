"""Temporal voting: reconcile several observations of one steady scene.

A fast model makes occasional per-frame mistakes. When the gate reports a scene
steady, the pipeline runs the model on a few frames of that same scene and calls
`reconcile` to pick a consensus, turning the model's speed into accuracy. The
representative is the "medoid": the candidate most similar to the others (by the
field that matters for its type — OCR text for documents, the overview for
scenes). Disagreement raises `low_confidence` so a querying agent knows to
re-read the stored frame.
"""

from __future__ import annotations

from . import dedup
from .records import Observation


def reconcile(observations: list[Observation]) -> tuple[Observation, int]:
    """Return (merged observation, index of the representative candidate).

    The index lets the caller store the actual frame that best represents the
    reconciled result.
    """
    n = len(observations)
    if n == 0:
        raise ValueError("reconcile requires at least one observation")
    if n == 1:
        return observations[0], 0

    text_votes = sum(1 for o in observations if o.is_text)
    is_text = text_votes * 2 >= n
    matching = [i for i, o in enumerate(observations) if o.is_text == is_text]

    def field(o: Observation) -> str:
        return o.ocr_full if is_text else o.overview

    best_idx = matching[0]
    best_score = -1.0
    for i in matching:
        score = 0.0
        for j in matching:
            if i == j:
                continue
            score += dedup.ratio(dedup.normalize(field(observations[i])), dedup.normalize(field(observations[j])))
        if score > best_score:
            best_score, best_idx = score, i

    rep = observations[best_idx]
    agreement = best_score / (len(matching) - 1) if len(matching) > 1 else 1.0
    low_conf = (
        len(matching) < n  # the type vote was not unanimous
        or agreement < 0.8  # the representative disagrees with the others
        or any(o.low_confidence for o in observations)
    )

    merged = Observation(
        is_text=is_text,
        ocr_full=rep.ocr_full if is_text else "",
        overview=rep.overview,
        change_from_prev=rep.change_from_prev,
        low_confidence=low_conf,
        latency_ms=sum(o.latency_ms for o in observations),
        model=rep.model,
    )
    return merged, best_idx
