"""Offline multilingual ASR worker used by the interpreter stack."""

from .runtime import (
    DEFAULT_MODEL_ID,
    DEFAULT_MODEL_REVISION,
    NemotronAsrRuntime,
    parse_tagged_transcript,
)

__all__ = [
    "DEFAULT_MODEL_ID",
    "DEFAULT_MODEL_REVISION",
    "NemotronAsrRuntime",
    "parse_tagged_transcript",
]
