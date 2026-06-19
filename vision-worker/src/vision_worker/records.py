"""Core data records passed between the model client, pipeline, and database."""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass
class PrevState:
    """The previous textual state handed back to the model.

    We pass only the previous text (not the previous image) so the model
    prefills a single image per call; diffusion decoding speeds up generation,
    not image prefill, so feeding two images per frame would be wasteful.
    """

    ocr_full: str
    overview: str


@dataclass
class Observation:
    """One structured perception record for a single changed frame."""

    is_text: bool
    ocr_full: str
    overview: str
    change_from_prev: str
    low_confidence: bool = False
    latency_ms: int = 0
    model: str = "unknown"

    def as_dict(self) -> dict:
        return asdict(self)
