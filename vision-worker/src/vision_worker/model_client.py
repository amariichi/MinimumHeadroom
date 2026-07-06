"""Vision model clients.

The pipeline depends only on the `VisionModelClient` protocol, so the model is
swappable. `MockModelClient` is deterministic and GPU-free (used for tests and
for building the pipeline while the GPU is busy). `DiffusionGemmaClient` calls
an OpenAI-compatible vLLM endpoint serving `nvidia/diffusiongemma-26B-A4B-it-NVFP4`
(functional but untested until a GPU is available).
"""

from __future__ import annotations

import json
import re
import sys
import time
from typing import Protocol

from .config import Settings
from .imaging import average_hash, text_likeness
from .records import Observation, PrevState

#: Instruction given to the real model. One call returns one JSON object.
#: Deliberately world-oriented: the camera is hand-movable, so a frame-diff
#: framing would make almost every stored memory be about the camera itself
#: (pan/shake/focus/exposure — "ego-motion"). Those records are useless as
#: conversational memory, so the model is told to describe people, activity,
#: and objects, and to treat ego-motion-only differences as "no change".
INSTRUCTION = (
    "You are the eyes of a desk companion device. Look at the image and reply "
    "with ONE JSON object and nothing else, with exactly these keys: "
    '"is_text" (true if the frame is mostly text/a document, else false), '
    '"ocr_full" (if is_text, the full verbatim text of everything legible, '
    "preserving line breaks; otherwise an empty string), "
    '"overview" (one short sentence about the WORLD in view: who is present, '
    "what they appear to be doing, and the notable objects or place. Never "
    "describe the camera, image quality, focus, blur, framing, or lighting), "
    '"changed" (true if the WORLD content changed versus the previous state '
    "given below — a person or hand appeared, moved, or left; an object was "
    "added, removed, moved, or swapped; the view now shows a genuinely "
    "different place or subject. Set it false when the frames differ only by "
    "camera motion, focus, blur, exposure, lighting, sensor noise, or framing "
    "jitter over the same content, and for the first frame), "
    '"change_from_prev" (one short sentence naming the specific world change, '
    "phrased as what is newly visible, what left, or what the person started "
    "doing. NEVER describe camera movement, focus, blur, or lighting as the "
    "change. If the camera clearly moved to show a different subject, describe "
    "the new subject, not the movement. If nothing meaningful changed, say so), "
    '"salient_objects" (array of up to 5 short noun phrases, in the same '
    "language as overview, naming distinctive objects or visible text in view "
    "— things a person might refer back to later. Exclude people. Use [] when "
    "nothing stands out). "
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


def compose_correction_advisory(correction: str | None) -> str:
    """A separate, over-anchor-resistant advisory for an active human correction.

    Returns "" when there is none. The block is appended AFTER the previous-state
    text (never merged into it, so `prev.overview` is untouched) and explicitly
    tells the model to keep reporting what it actually sees and not to suppress a
    genuine change — so feeding the note back to the captioner cannot, on its own,
    make it report "no change" forever. The scene-bound expiry in corrections.py
    remains the independent guard if the model over-trusts the note. Opt-in via
    VISION_CORRECTION_TO_MODEL (off by default).
    """
    text = (correction or "").strip()
    if not text:
        return ""
    return (
        "\n\nHuman note (may be stale): " + text + " "
        "Report exactly what you SEE now and whether it changed; do not let this "
        "note suppress a genuine change or describe something that is no longer visible."
    )


#: JSON schema used for vLLM guided decoding when VISION_GUIDED_DECODING=1.
RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "is_text": {"type": "boolean"},
        "ocr_full": {"type": "string"},
        "overview": {"type": "string"},
        "changed": {"type": "boolean"},
        "change_from_prev": {"type": "string"},
        # Not in "required": models that omit it degrade to an empty entity list.
        "salient_objects": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["is_text", "ocr_full", "overview", "changed", "change_from_prev"],
}


#: Bounds for the entity feed: enough named things per frame to be useful,
#: short enough that a runaway model cannot flood the entities table.
_SALIENT_OBJECTS_MAX = 5
_SALIENT_NAME_MAX_CHARS = 64


def parse_salient_objects(value) -> list[str]:
    """Coerce a model-provided salient_objects value into a bounded list[str]."""
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        text = item.strip()
        if not text:
            continue
        out.append(text[:_SALIENT_NAME_MAX_CHARS])
        if len(out) >= _SALIENT_OBJECTS_MAX:
            break
    return out


class VisionModelClient(Protocol):
    name: str

    def observe(
        self, frame_jpeg: bytes, prev: PrevState | None, correction: str | None = None
    ) -> Observation:
        ...


class MockModelClient:
    """Deterministic, GPU-free stand-in for the real vision model.

    It derives a stable fake OCR string from the frame's perceptual hash, so
    identical frames yield identical text (and dedup collapses them) while
    different frames yield different text (and register as changes). The
    text/scene split uses the cheap `text_likeness` heuristic.
    """

    name = "mock"

    def observe(
        self, frame_jpeg: bytes, prev: PrevState | None, correction: str | None = None
    ) -> Observation:
        # The mock ignores corrections; the advisory only shapes the real VLM.
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
            salient_objects=[] if is_text else [f"mock-object-{digest[:4]}"],
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
    """Client for an OpenAI-compatible vLLM endpoint."""

    def __init__(
        self,
        base_url: str,
        model_name: str,
        guided: bool = False,
        timeout: float = 60.0,
        output_lang: str = "en",
        debug_prompt: bool = False,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model_name = model_name
        self.name = model_name
        self.guided = guided
        self.timeout = timeout
        self.instruction = compose_instruction(output_lang)
        self.debug_prompt = debug_prompt

    def observe(
        self, frame_jpeg: bytes, prev: PrevState | None, correction: str | None = None
    ) -> Observation:
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
        advisory = compose_correction_advisory(correction)
        prompt_text = f"{self.instruction}\n\n{prev_text}{advisory}"
        if self.debug_prompt:
            print("[vision-worker] VISION_DEBUG_PROMPT request text:", file=sys.stderr)
            print(prompt_text, file=sys.stderr, flush=True)
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt_text},
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
            salient_objects=parse_salient_objects(data.get("salient_objects")),
        )


def build_model_client(settings: Settings) -> VisionModelClient:
    if settings.model_backend == "diffusiongemma":
        return DiffusionGemmaClient(
            base_url=settings.model_url,
            model_name=settings.model_name,
            guided=settings.guided_decoding,
            output_lang=settings.output_lang,
            debug_prompt=settings.debug_prompt,
        )
    return MockModelClient()
