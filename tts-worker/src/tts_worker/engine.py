from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Tuple, runtime_checkable

import numpy as np


@dataclass(frozen=True)
class EngineMetadata:
  voice: str
  engine: str
  model_path: str
  voices_path: str


@runtime_checkable
class TtsEngine(Protocol):
  @property
  def metadata(self) -> EngineMetadata:
    ...

  def synthesize_text(self, text: str, *, voice_override: str | None = None) -> Tuple[np.ndarray, int]:
    ...
