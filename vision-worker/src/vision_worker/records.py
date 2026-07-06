"""Core data records passed between the model client, pipeline, and database."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field


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
    # The model's own verdict that something *meaningful* changed versus the
    # previous state (a new/removed/moved object, a person, a different scene) —
    # not mere lighting/noise/framing jitter. This is the authoritative signal
    # the cheap perceptual gate cannot give: the gate over-fires, the model is
    # the arbiter. Drives both what gets stored as a change point and what is
    # spoken aloud. Defaults True for backward compatibility (mock/tests).
    changed: bool = True
    low_confidence: bool = False
    latency_ms: int = 0
    model: str = "unknown"
    # Distinctive objects (never people) visible in the frame, as short noun
    # phrases. They feed the entity memory: a small named-thing table that lets
    # the conversational agent call back to things seen earlier ("昨日の
    # Amazonの箱"), which pure time-bucketed summaries average away.
    salient_objects: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return asdict(self)
