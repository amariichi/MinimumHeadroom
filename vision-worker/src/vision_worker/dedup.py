"""Text-level duplicate detection.

Even after the visual gate lets a frame through, OCR of the same page jitters
slightly between frames. This module decides whether new text is essentially
the same as the previous record so the rolling memory does not accumulate near
-identical entries. The approach mirrors the line-fuzzy comparison used in the
reference project ScreenshotTranslator2 (`app/diff_engine.py`), re-authored here.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher

_WHITESPACE = re.compile(r"\s+")


def normalize(text: str) -> str:
    return _WHITESPACE.sub(" ", (text or "").strip())


def ratio(a: str, b: str) -> float:
    """Similarity ratio in [0, 1] between two normalized strings."""
    return SequenceMatcher(None, a, b).ratio()


def is_duplicate(old: str, new: str, threshold: float = 0.92) -> bool:
    """True when `new` is essentially the same text as `old`.

    Empty-vs-empty counts as duplicate; appearing or disappearing text counts
    as a real change.
    """
    a = normalize(old)
    b = normalize(new)
    if a == b:
        return True
    if not a or not b:
        return False
    return ratio(a, b) >= threshold
