from __future__ import annotations

from array import array
from contextlib import nullcontext
from io import BytesIO
from types import SimpleNamespace
import unittest
import wave

from interpreter_asr_worker.runtime import (
    NemotronAsrRuntime,
    decode_pcm16_mono_wav,
    parse_tagged_transcript,
    unwrap_single_decoded_transcript,
)


def fixture_wav(sample_count: int = 16_000) -> bytes:
    payload = array("h", (1000 if index % 2 == 0 else -1000 for index in range(sample_count)))
    output = BytesIO()
    with wave.open(output, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(16_000)
        writer.writeframes(payload.tobytes())
    return output.getvalue()


class FakeInputs(dict):
    def to(self, _device: str, dtype=None):
        self["moved_dtype"] = dtype
        return self


class FakeProcessor:
    def __init__(self) -> None:
        self.language = None
        self.skip_special_tokens = None
        self.decoded_sequences = None

    def __call__(self, samples, *, sampling_rate, language, return_tensors):
        self.language = language
        self.sample_rate = sampling_rate
        self.return_tensors = return_tensors
        self.sample_count = len(samples)
        return FakeInputs(input_features="fixture")

    def decode(self, sequences, *, skip_special_tokens):
        self.decoded_sequences = sequences
        self.skip_special_tokens = skip_special_tokens
        return ["<pad> Hola, mundo. <es-ES>"]


class FakeModel:
    dtype = "float32"

    def generate(self, **inputs):
        self.inputs = inputs
        return SimpleNamespace(sequences=["token-1", "token-2"])


class FakeTorch:
    @staticmethod
    def inference_mode():
        return nullcontext()


class RuntimeTests(unittest.TestCase):
    def test_parse_tagged_transcript_keeps_locale_and_removes_special_tokens(self) -> None:
        self.assertEqual(
            parse_tagged_transcript("<pad> Bonjour. <fr-FR>"),
            ("Bonjour.", "fr", "fr-FR"),
        )
        self.assertEqual(
            parse_tagged_transcript(
                "<pad> Buenos días. <es-ES> ¿Dónde está la estación? <es-ES>"
            ),
            ("Buenos días. ¿Dónde está la estación?", "es", "es-ES"),
        )
        with self.assertRaisesRegex(ValueError, "language_tag_missing"):
            parse_tagged_transcript("No tag")

    def test_wav_decoder_requires_pcm16_mono_16khz(self) -> None:
        audio = decode_pcm16_mono_wav(fixture_wav())
        self.assertEqual(audio.sample_rate, 16_000)
        self.assertEqual(audio.duration_ms, 1000)
        self.assertEqual(len(audio.samples), 16_000)
        self.assertEqual(audio.samples.dtype.name, "float32")

    def test_decode_unwrap_requires_exactly_one_string(self) -> None:
        self.assertEqual(unwrap_single_decoded_transcript(["Hola"]), "Hola")
        with self.assertRaisesRegex(ValueError, "unexpected_decode_batch"):
            unwrap_single_decoded_transcript(["Hola", "Bonjour"])
        with self.assertRaisesRegex(ValueError, "invalid_decoded_transcript"):
            unwrap_single_decoded_transcript([123])

    def test_runtime_uses_auto_language_and_keeps_tag_for_decode(self) -> None:
        processor = FakeProcessor()
        model = FakeModel()
        ticks = iter([10.0, 10.25])
        runtime = NemotronAsrRuntime(
            processor=processor,
            model=model,
            torch_module=FakeTorch(),
            clock=lambda: next(ticks),
        )
        result = runtime.transcribe_wav(fixture_wav())
        self.assertEqual(processor.language, "auto")
        self.assertEqual(processor.decoded_sequences, ["token-1", "token-2"])
        self.assertFalse(processor.skip_special_tokens)
        self.assertEqual(result["text"], "Hola, mundo.")
        self.assertEqual(result["language"], "es")
        self.assertEqual(result["locale"], "es-ES")
        self.assertEqual(result["confidence"], None)
        self.assertEqual(result["languageEvidence"]["speechMs"], 1000)
        self.assertEqual(result["durationMs"], 250)


if __name__ == "__main__":
    unittest.main()
