from __future__ import annotations

import asyncio
from pathlib import Path
import threading
import unittest
from unittest.mock import AsyncMock, patch

import numpy as np

from tts_worker.__main__ import (
  encode_engine_wav_base64,
  synthesize_engine_text,
)
from tts_worker.engine import EngineMetadata
from tts_worker.supertonic_engine import (
  SUPERTONIC_MODEL_REVISION,
  SupertonicConfig,
  SupertonicEngine,
)


class RecordingSupertonicTts:
  sample_rate = 44_100

  def __init__(self) -> None:
    self.synthesis_thread = None

  def get_voice_style(self, *, voice_name):
    return f'style:{voice_name}'

  def synthesize(self, **_kwargs):
    self.synthesis_thread = threading.get_ident()
    return np.asarray([[0.0, 0.25]], dtype=np.float32), np.asarray([0.1])


class RecordingBackgroundEngine:
  def __init__(self) -> None:
    self.synthesis_thread = None

  @property
  def metadata(self) -> EngineMetadata:
    return EngineMetadata(
      voice='test',
      engine='background-test',
      model_path='-',
      voices_path='-',
    )

  def prepare_text(self, text, *, language_override=None):
    return text

  def synthesize_text(
    self,
    text,
    *,
    voice_override=None,
    language_override=None,
  ):
    self.synthesis_thread = threading.get_ident()
    return np.asarray([0.0, 0.25], dtype=np.float32), 24_000


class WorkerSynthesisPolicyTests(unittest.TestCase):
  def test_supertonic_synthesis_stays_on_event_loop_thread(self) -> None:
    tts = RecordingSupertonicTts()
    engine = SupertonicEngine(
      config=SupertonicConfig(
        voice='M1',
        total_steps=8,
        speed=1.05,
        intra_op_threads=10,
        inter_op_threads=1,
        cache_dir=Path('/fixture/supertonic3'),
        model_revision=SUPERTONIC_MODEL_REVISION,
      ),
      tts_instance=tts,
    )
    event_loop_thread = threading.get_ident()
    asyncio.run(
      synthesize_engine_text(
        engine,
        'Hola.',
        speaker=None,
        language='es',
      )
    )
    self.assertEqual(tts.synthesis_thread, event_loop_thread)

  def test_other_engines_keep_background_thread_synthesis(self) -> None:
    engine = RecordingBackgroundEngine()
    expected = (np.asarray([0.0], dtype=np.float32), 24_000)
    with patch(
      'tts_worker.__main__.asyncio.to_thread',
      new=AsyncMock(return_value=expected),
    ) as to_thread:
      result = asyncio.run(
        synthesize_engine_text(
          engine,
          'Hello.',
          speaker=None,
          language='en',
        )
      )
    self.assertEqual(result[1], 24_000)
    to_thread.assert_awaited_once()

  def test_supertonic_wav_encoding_avoids_background_thread(self) -> None:
    engine = SupertonicEngine(
      config=SupertonicConfig(
        voice='M1',
        total_steps=8,
        speed=1.05,
        intra_op_threads=10,
        inter_op_threads=1,
        cache_dir=Path('/fixture/supertonic3'),
        model_revision=SUPERTONIC_MODEL_REVISION,
      ),
      tts_instance=RecordingSupertonicTts(),
    )
    with patch(
      'tts_worker.__main__.asyncio.to_thread',
      new=AsyncMock(side_effect=AssertionError('must not use to_thread')),
    ):
      encoded = asyncio.run(
        encode_engine_wav_base64(
          engine,
          np.asarray([0.0, 0.25], dtype=np.float32),
          44_100,
        )
      )
    self.assertIsInstance(encoded, str)
    self.assertGreater(len(encoded), 40)


if __name__ == '__main__':
  unittest.main()
