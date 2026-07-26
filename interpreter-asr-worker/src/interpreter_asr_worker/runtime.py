from __future__ import annotations

from contextlib import nullcontext
from dataclasses import dataclass
from io import BytesIO
import os
import re
import time
import wave
from typing import Any, Callable

import numpy as np


DEFAULT_MODEL_ID = "nvidia/nemotron-3.5-asr-streaming-0.6b"
DEFAULT_MODEL_REVISION = "f3d333391852ba876df169dcc9ba902d25b6ab0b"
LANGUAGE_TAG = re.compile(r"<([a-z]{2,3}(?:-[A-Z]{2})?)>")
NON_LANGUAGE_SPECIAL_TAG = re.compile(r"</?(?:pad|blank|s)>", re.IGNORECASE)


@dataclass(frozen=True)
class WavAudio:
    samples: np.ndarray
    sample_rate: int
    duration_ms: int


def decode_pcm16_mono_wav(data: bytes) -> WavAudio:
    try:
        with wave.open(BytesIO(data), "rb") as reader:
            channels = reader.getnchannels()
            sample_width = reader.getsampwidth()
            sample_rate = reader.getframerate()
            frames = reader.getnframes()
            compression = reader.getcomptype()
            payload = reader.readframes(frames)
    except (wave.Error, EOFError) as error:
        raise ValueError("invalid_wav") from error

    if (
        channels != 1
        or sample_width != 2
        or sample_rate != 16_000
        or compression != "NONE"
    ):
        raise ValueError("unsupported_wav_format")
    samples = np.frombuffer(payload, dtype="<i2")
    normalized = samples.astype(np.float32) / 32768.0
    duration_ms = round((frames / sample_rate) * 1000)
    return WavAudio(
        samples=normalized,
        sample_rate=sample_rate,
        duration_ms=duration_ms,
    )


def parse_tagged_transcript(value: str) -> tuple[str, str, str]:
    text = NON_LANGUAGE_SPECIAL_TAG.sub("", value).strip()
    matches = list(LANGUAGE_TAG.finditer(text))
    if not matches:
        raise ValueError("language_tag_missing")
    match = matches[-1]
    if text[match.end() :].strip():
        raise ValueError("terminal_language_tag_missing")
    locale = match.group(1)
    transcript = LANGUAGE_TAG.sub("", text[: match.start()])
    transcript = re.sub(r"\s{2,}", " ", transcript).strip()
    if not transcript:
        raise ValueError("empty_transcript")
    return transcript, locale.split("-", 1)[0].lower(), locale


def unwrap_single_decoded_transcript(value: Any) -> str:
    if isinstance(value, (list, tuple)):
        if len(value) != 1:
            raise ValueError("unexpected_decode_batch")
        value = value[0]
    if not isinstance(value, str):
        raise ValueError("invalid_decoded_transcript")
    return value


class NemotronAsrRuntime:
    def __init__(
        self,
        *,
        model_id: str = DEFAULT_MODEL_ID,
        revision: str = DEFAULT_MODEL_REVISION,
        cache_dir: str | None = None,
        device: str = "cuda",
        processor: Any | None = None,
        model: Any | None = None,
        torch_module: Any | None = None,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self.model_id = model_id
        self.revision = revision
        self.cache_dir = cache_dir
        self.device = device
        self.processor = processor
        self.model = model
        self.torch = torch_module
        self.clock = clock

    @property
    def loaded(self) -> bool:
        return self.processor is not None and self.model is not None

    def load(self) -> None:
        if self.loaded:
            return
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        from transformers import AutoModelForRNNT, AutoProcessor
        import torch

        self.torch = torch
        self.processor = AutoProcessor.from_pretrained(
            self.model_id,
            revision=self.revision,
            cache_dir=self.cache_dir,
            local_files_only=True,
        )
        self.model = AutoModelForRNNT.from_pretrained(
            self.model_id,
            revision=self.revision,
            cache_dir=self.cache_dir,
            local_files_only=True,
        )
        self.model.to(self.device)
        self.model.eval()

    def transcribe_wav(self, data: bytes) -> dict[str, Any]:
        self.load()
        audio = decode_pcm16_mono_wav(data)
        started = self.clock()
        inputs = self.processor(
            audio.samples,
            sampling_rate=audio.sample_rate,
            language="auto",
            return_tensors="pt",
        )
        model_dtype = getattr(self.model, "dtype", None)
        if hasattr(inputs, "to"):
            if model_dtype is None:
                inputs = inputs.to(self.device)
            else:
                inputs = inputs.to(self.device, dtype=model_dtype)
        inference_context = (
            self.torch.inference_mode()
            if self.torch is not None and hasattr(self.torch, "inference_mode")
            else nullcontext()
        )
        with inference_context:
            output = self.model.generate(
                **inputs,
                return_dict_in_generate=True,
            )
        sequences = output.sequences if hasattr(output, "sequences") else output
        tagged = unwrap_single_decoded_transcript(
            self.processor.decode(sequences, skip_special_tokens=False)
        )
        transcript, language, locale = parse_tagged_transcript(tagged)
        elapsed_ms = round((self.clock() - started) * 1000)
        graphemes = sum(1 for character in transcript if not character.isspace())
        return {
            "text": transcript,
            "language": language,
            "locale": locale,
            "confidence": None,
            "languageEvidence": {
                "tagObserved": True,
                "confidence": None,
                "speechMs": audio.duration_ms,
                "contentGraphemeCount": graphemes,
            },
            "durationMs": elapsed_ms,
        }

    def health(self) -> dict[str, Any]:
        return {
            "ok": self.loaded,
            "service": "nemotron-3.5-asr",
            "model": self.model_id,
            "revision": self.revision,
            "device": self.device,
            "offline": True,
        }
