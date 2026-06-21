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
    '"changed" (true if the scene content changed in any clearly visible way '
    "versus the previous state given below — a person or hand appearing, moving, "
    "or leaving; an object added, removed, moved, or swapped; a different view or "
    "camera angle. Set it false ONLY when the view is essentially identical with "
    "no such change (differing just by lighting, sensor noise, or tiny framing "
    "jitter), and for the first frame), "
    '"change_from_prev" (one short sentence describing what changed versus the '
    "previous state given below; if nothing meaningful changed, say so). "
    "Keep the two consistent: if \"changed\" is true, \"change_from_prev\" must "
    "name the specific change and must NOT say that nothing changed; if "
    '"changed" is false, "change_from_prev" should say nothing meaningful changed.'
)


#: Phrases that signal a "nothing changed" sentence (English + Japanese). Used
#: to reconcile a model that contradicts itself by setting changed=true while
#: describing no change.
_NO_CHANGE_PHRASES = (
    # English
    "no change",
    "no significant change",
    "no meaningful change",
    "no notable change",
    "no visible change",
    "nothing changed",
    "nothing has changed",
    "remains unchanged",
    "first frame",
    "first observation",
    # Japanese
    "変化はありません",
    "変化はない",
    "変化は無い",
    "変化なし",
    "変化はなし",
    "変化は見られません",
    "変化が見られません",
    "変わりありません",
    "変わっていません",
    "最初のフレーム",
)

#: Words that mean a change *was* described. If a sentence carries one of these
#: it is a real change with a qualifier ("手が動いたが大きな変化はない"), not a
#: pure no-change statement, so it must NOT be suppressed.
_CHANGE_INDICATORS = (
    # Japanese
    "追加", "現れ", "出現", "登場", "移動", "動い", "動き", "置か", "置き換",
    "入れ替", "消え", "なくな", "変わっ", "変わり", "増え", "減っ", "新しい",
    "現われ", "映り込",
    # English
    "appear", "added", "removed", "moved", "placed", "replaced", "swapped",
    "new ", "disappear", "entered", "left the", "now shows", "changed to",
)


def looks_like_no_change(text: str) -> bool:
    """True only when `text` is essentially a *pure* 'nothing changed' statement.

    A sentence that describes a change but tacks on a "no big change" caveat
    (e.g. "手が動いたが大きな変化はない") carries a change indicator and is kept,
    so genuine movement is never silently suppressed.
    """
    low = (text or "").strip().lower()
    if not any(phrase in low for phrase in _NO_CHANGE_PHRASES):
        return False
    if any(ind in low for ind in _CHANGE_INDICATORS):
        return False
    return True


def compose_instruction(output_lang: str = "en") -> str:
    """The base instruction plus an optional natural-language directive.

    `overview` and `change_from_prev` are what gets spoken aloud in ambient mode,
    so they should be in the user's language; `ocr_full` stays verbatim-as-seen.
    Any value other than a known language code leaves the default (English).
    """
    lang = (output_lang or "").strip().lower()
    if lang in {"ja", "jp", "japanese", "ja-jp"}:
        return (
            INSTRUCTION + " Write \"overview\" and \"change_from_prev\" in natural, "
            "concise Japanese; keep \"ocr_full\" verbatim as seen."
        )
    return INSTRUCTION

#: JSON schema used for vLLM guided decoding when VISION_GUIDED_DECODING=1.
RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "is_text": {"type": "boolean"},
        "ocr_full": {"type": "string"},
        "overview": {"type": "string"},
        "changed": {"type": "boolean"},
        "change_from_prev": {"type": "string"},
    },
    "required": ["is_text", "ocr_full", "overview", "changed", "change_from_prev"],
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
            changed = False
        else:
            old = prev.ocr_full if is_text else prev.overview
            new = ocr_full if is_text else overview
            changed = old != new
            change = "content changed" if changed else "no significant change"

        return Observation(
            is_text=is_text,
            ocr_full=ocr_full,
            overview=overview,
            changed=changed,
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
        output_lang: str = "en",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model_name = model_name
        self.name = model_name
        self.guided = guided
        self.timeout = timeout
        self.instruction = compose_instruction(output_lang)

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
                    {"type": "text", "text": f"{self.instruction}\n\n{prev_text}"},
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
        # The first frame has nothing to diff against, so it is never a "change"
        # (it is the baseline). Otherwise trust the model's verdict; a parse
        # failure (empty data) means low_confidence and is not treated as a
        # change, so it is neither stored as a change point nor spoken.
        change_text = str(data.get("change_from_prev", ""))
        changed = bool(data.get("changed", False)) if prev is not None else False
        # Reconcile a self-contradicting model: if it flagged a change but the
        # sentence plainly says nothing changed, trust the negation. This keeps
        # the "no change" line out of both the rolling memory and the voice.
        if changed and looks_like_no_change(change_text):
            changed = False
        return Observation(
            is_text=bool(data.get("is_text", False)),
            ocr_full=str(data.get("ocr_full", "")),
            overview=str(data.get("overview", "")),
            changed=changed,
            change_from_prev=change_text,
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
            output_lang=settings.output_lang,
        )
    return MockModelClient()
