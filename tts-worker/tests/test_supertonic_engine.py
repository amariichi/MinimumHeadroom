from __future__ import annotations

from pathlib import Path
import os
import unittest
from unittest.mock import patch

import numpy as np

from tts_worker.supertonic_engine import (
    SUPERTONIC_MODEL_REVISION,
    SupertonicConfig,
    SupertonicEngine,
    load_supertonic_config,
    normalize_supertonic_language,
    normalize_supertonic_language_policy,
    resolve_supertonic_language,
)


class FakeTts:
  sample_rate = 44_100

  def __init__(self) -> None:
    self.calls = []

  def get_voice_style(self, *, voice_name):
    return f'style:{voice_name}'

  def synthesize(self, **kwargs):
    self.calls.append(kwargs)
    return np.asarray([[0.0, 0.25, -0.25]], dtype=np.float32), np.asarray([0.1])


class SupertonicEngineTests(unittest.TestCase):
  def setUp(self) -> None:
    self.tts = FakeTts()
    self.engine = SupertonicEngine(
      config=SupertonicConfig(
        voice='M1',
        total_steps=8,
        speed=1.05,
        intra_op_threads=10,
        inter_op_threads=1,
        cache_dir=Path('/fixture/supertonic3'),
        model_revision=SUPERTONIC_MODEL_REVISION,
      ),
      tts_instance=self.tts,
    )

  def test_supported_languages_are_explicit_and_primary_tagged(self) -> None:
    self.assertEqual(normalize_supertonic_language('es-ES'), 'es')
    self.assertEqual(normalize_supertonic_language('ja'), 'ja')
    with self.assertRaisesRegex(ValueError, 'unsupported'):
      normalize_supertonic_language('zh')

  def test_language_policy_accepts_auto_and_rejects_unsupported_tags(self) -> None:
    self.assertEqual(normalize_supertonic_language_policy(None), 'auto')
    self.assertEqual(normalize_supertonic_language_policy('und'), 'auto')
    self.assertEqual(normalize_supertonic_language_policy('es-ES'), 'es')
    with self.assertRaisesRegex(ValueError, 'unsupported'):
      normalize_supertonic_language_policy('zh')

  def test_auto_language_detection_covers_operator_scripts(self) -> None:
    self.assertEqual(resolve_supertonic_language('確認します。', None), 'ja')
    self.assertEqual(resolve_supertonic_language('Checking now.', None), 'en')
    self.assertEqual(resolve_supertonic_language('확인하겠습니다.', None), 'ko')
    self.assertEqual(resolve_supertonic_language('Проверяю.', None), 'ru')
    self.assertEqual(resolve_supertonic_language('Γεια σας.', None), 'el')
    self.assertEqual(resolve_supertonic_language('مرحبا', None), 'ar')
    self.assertEqual(resolve_supertonic_language('नमस्ते', None), 'hi')

  def test_configured_language_is_fallback_and_explicit_language_wins(self) -> None:
    self.assertEqual(
      resolve_supertonic_language('Buenos días.', None, 'es'),
      'es',
    )
    self.assertEqual(
      resolve_supertonic_language('Bonjour.', 'fr', 'es'),
      'fr',
    )
    self.assertEqual(
      resolve_supertonic_language('日本語です。', None, 'es'),
      'ja',
    )

  def test_environment_language_policy_is_loaded(self) -> None:
    with patch.dict(os.environ, {'MH_SUPERTONIC_LANGUAGE': 'es-ES'}, clear=False):
      config = load_supertonic_config()
    self.assertEqual(config.language, 'es')

  def test_synthesis_forwards_language_steps_speed_and_voice(self) -> None:
    audio, sample_rate = self.engine.synthesize_text(
      'Hola.',
      language_override='es',
      voice_override='F1',
    )
    self.assertEqual(sample_rate, 44_100)
    np.testing.assert_allclose(audio, [0.0, 0.25, -0.25])
    self.assertEqual(self.tts.calls[0]['lang'], 'es')
    self.assertEqual(self.tts.calls[0]['voice_style'], 'style:F1')
    self.assertEqual(self.tts.calls[0]['total_steps'], 8)
    self.assertEqual(self.tts.calls[0]['speed'], 1.05)

  def test_synthesis_auto_detects_japanese_without_language_override(self) -> None:
    self.engine.synthesize_text('確認します。')
    self.assertEqual(self.tts.calls[0]['lang'], 'ja')

  def test_metadata_records_offline_asset_revision(self) -> None:
    self.assertEqual(self.engine.metadata.engine, 'supertonic-3-onnx')
    self.assertIn(SUPERTONIC_MODEL_REVISION, self.engine.metadata.voices_path)
    self.assertIn('language:auto', self.engine.metadata.voices_path)
    self.assertIn('intra_threads:10', self.engine.metadata.voices_path)

if __name__ == '__main__':
  unittest.main()
