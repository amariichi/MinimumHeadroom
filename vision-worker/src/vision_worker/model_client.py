"""Vision model clients.

The pipeline depends only on the `VisionModelClient` protocol, so the model is
swappable. `MockModelClient` is deterministic and GPU-free (used for tests and
for building the pipeline while the GPU is busy). `DiffusionGemmaClient` calls
an OpenAI-compatible vLLM endpoint serving `nvidia/diffusiongemma-26B-A4B-it-NVFP4`
(wired up and exercised in milestone M2; it is functional but untested until a
GPU is available).
"""

from __future__ import annotations

import json
import re
import time
from typing import Protocol

from .config import Settings
from .imaging import average_hash, text_likeness
from .records import Observation, PrevState

#: Instruction given to the real model. One call returns one JSON object.
INSTRUCTION = (
    "You are a camera perception engine. Look at the image and reply with ONE "
    "JSON object and nothing else, with exactly these keys: "
    '"is_text" (true if the frame is mostly text/a document, else false), '
    '"ocr_full" (if is_text, the full verbatim text of everything legible, '
    "preserving line breaks; otherwise an empty string), "
    '"overview" (one short sentence describing the whole frame), '
    '"change_from_prev" (one short sentence describing what changed versus the '
    "previous state given below; if nothing meaningful changed, say so)."
)

#: JSON schema used for vLLM guided decoding when VISION_GUIDED_DECODING=1.
RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "is_text": {"type": "boolean"},
        "ocr_full": {"type": "string"},
        "overview": {"type": "string"},
        "change_from_prev": {"type": "string"},
    },
    "required": ["is_text", "ocr_full", "overview", "change_from_prev"],
}


class VisionModelClient(Protocol):
    name: str

    def observe(self, frame_jpeg: bytes, prev: PrevState | None) -> Observation:
        ...


class MockModelClient:
    """Deterministic, GPU-free stand-in for the real vision model.

    It derives a stable fake OCR string from the frame's perceptual hash, so
    identical frames yield identical text (and dedup collapses them) while
    different frames yield different text (and register as changes). The
    text/scene split uses the cheap `text_likeness` heuristic.
    """

    name = "mock"

    def observe(self, frame_jpeg: bytes, prev: PrevState | None) -> Observation:
        started = time.time()
        digest = format(average_hash(frame_jpeg, 8), "016x")
        is_text = text_likeness(frame_jpeg) > 0.6
        ocr_full = f"MOCK-OCR[{digest}]" if is_text else ""
        overview = ("text document " if is_text else "scene ") + digest[:6]

        if prev is None:
            change = "first observation"
        else:
            old = prev.ocr_full if is_text else prev.overview
            new = ocr_full if is_text else overview
            change = "no significant change" if old == new else "content changed"

        return Observation(
            is_text=is_text,
            ocr_full=ocr_full,
            overview=overview,
            change_from_prev=change,
            low_confidence=False,
            latency_ms=int((time.time() - started) * 1000),
            model=self.name,
        )


def _extract_json(content: str) -> dict:
    content = content.strip()
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass
    match = re.search(r"\{.*\}", content, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    return {}


class DiffusionGemmaClient:
    """Client for an OpenAI-compatible vLLM endpoint (milestone M2)."""

    def __init__(
        self,
        base_url: str,
        model_name: str,
        guided: bool = False,
        timeout: float = 60.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model_name = model_name
        self.name = model_name
        self.guided = guided
        self.timeout = timeout

    def observe(self, frame_jpeg: bytes, prev: PrevState | None) -> Observation:
        import base64

        import httpx

        b64 = base64.b64encode(frame_jpeg).decode("ascii")
        if prev is None:
            prev_text = "Previous state: none (this is the first frame)."
        else:
            prev_text = (
                f"Previous overview: {prev.overview}\n"
                f"Previous text: {prev.ocr_full}"
            )
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"{INSTRUCTION}\n\n{prev_text}"},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                    },
                ],
            }
        ]
        payload: dict = {
            "model": self.model_name,
            "messages": messages,
            "max_tokens": 1024,
            "temperature": 0,
        }
        if self.guided:
            payload["guided_json"] = RESPONSE_SCHEMA

        started = time.time()
        response = httpx.post(
            f"{self.base_url}/chat/completions", json=payload, timeout=self.timeout
        )
        response.raise_for_status()
        content = response.json()["choices"][0]["message"]["content"]
        data = _extract_json(content)
        return Observation(
            is_text=bool(data.get("is_text", False)),
            ocr_full=str(data.get("ocr_full", "")),
            overview=str(data.get("overview", "")),
            change_from_prev=str(data.get("change_from_prev", "")),
            low_confidence=bool(data.get("low_confidence", False)) or not data,
            latency_ms=int((time.time() - started) * 1000),
            model=self.model_name,
        )


def build_model_client(settings: Settings) -> VisionModelClient:
    if settings.model_backend == "diffusiongemma":
        return DiffusionGemmaClient(
            base_url=settings.model_url,
            model_name=settings.model_name,
            guided=settings.guided_decoding,
        )
    return MockModelClient()
