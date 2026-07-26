from __future__ import annotations

import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT_DIR / 'tts-worker' / 'src'
if str(SRC_DIR) not in sys.path:
  sys.path.insert(0, str(SRC_DIR))

if 'numpy' not in sys.modules:
  try:
    import numpy  # noqa: F401
  except ImportError:
    sys.modules['numpy'] = types.ModuleType('numpy')

from tts_worker.__main__ import resolve_kokoro_voice
from tts_worker.qwen3_engine import (
  Qwen3Config,
  Qwen3TtsEngine,
  load_qwen3_config,
  normalize_qwen3_generation_mode,
  qwen3_generation_kwargs,
  resolve_qwen3_model_source,
)
from tts_worker.qwen3_text import normalize_language


class Qwen3EngineConfigTests(unittest.TestCase):
  def test_default_speed_is_one_point_zero(self) -> None:
    with patch.dict(os.environ, {}, clear=True):
      config = load_qwen3_config()
    self.assertEqual(config.speed, 1.0)
    self.assertEqual(
      config.model_revision,
      '85e237c12c027371202489a0ec509ded67b5e4b5',
    )
    self.assertEqual(config.generation_mode, 'faithful')

  def test_explicit_speed_override_is_preserved(self) -> None:
    with patch.dict(os.environ, {'MH_QWEN_TTS_SPEED': '1.10'}, clear=True):
      config = load_qwen3_config()
    self.assertEqual(config.speed, 1.1)

  def test_multilingual_tags_and_auto_are_normalized_for_qwen(self) -> None:
    self.assertEqual(normalize_language('fr-FR'), 'French')
    self.assertEqual(normalize_language('ko'), 'Korean')
    self.assertEqual(normalize_language('Auto'), 'Auto')

  def test_auto_language_can_be_configured(self) -> None:
    with patch.dict(os.environ, {'MH_QWEN_TTS_LANGUAGE': 'Auto'}, clear=True):
      config = load_qwen3_config()
    self.assertEqual(config.language, 'Auto')

  def test_generation_mode_aliases_are_normalized(self) -> None:
    self.assertEqual(normalize_qwen3_generation_mode('deterministic'), 'faithful')
    self.assertEqual(normalize_qwen3_generation_mode('upstream'), 'natural')

  def test_invalid_generation_mode_is_rejected(self) -> None:
    with self.assertRaisesRegex(RuntimeError, 'expected faithful or natural'):
      normalize_qwen3_generation_mode('creative')

  def test_faithful_mode_disables_both_sampling_stages(self) -> None:
    self.assertEqual(
      qwen3_generation_kwargs('faithful'),
      {
        'do_sample': False,
        'subtalker_dosample': False,
      },
    )

  def test_natural_mode_preserves_upstream_generation_defaults(self) -> None:
    self.assertEqual(qwen3_generation_kwargs('natural'), {})

  def test_pinned_huggingface_snapshot_resolves_to_local_directory(self) -> None:
    with tempfile.TemporaryDirectory() as cache_root:
      revision = 'test-revision'
      snapshot = (
        Path(cache_root)
        / 'hub'
        / 'models--Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice'
        / 'snapshots'
        / revision
      )
      snapshot.mkdir(parents=True)
      resolved = resolve_qwen3_model_source(
        'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
        revision,
        env={'HF_HOME': cache_root},
      )
    self.assertEqual(resolved, str(snapshot))

  def test_missing_snapshot_fails_without_falling_back_to_hub(self) -> None:
    with tempfile.TemporaryDirectory() as cache_root:
      with self.assertRaisesRegex(RuntimeError, 'missing pinned Qwen3-TTS snapshot'):
        resolve_qwen3_model_source(
          'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
          'missing-revision',
          env={'HF_HOME': cache_root},
        )

  def test_explicit_local_model_path_wins(self) -> None:
    with tempfile.TemporaryDirectory() as model_path:
      resolved = resolve_qwen3_model_source(
        'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
        'unused-revision',
        env={'MH_QWEN_TTS_MODEL_PATH': model_path},
      )
    self.assertEqual(resolved, model_path)

  def test_qwen_engine_preloads_before_reporting_ready(self) -> None:
    config = Qwen3Config(
      model_id='Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
      model_revision='revision',
      speaker='Serena',
      language='English',
      ascii_mode='preserve',
      style='neutral',
      generation_mode='faithful',
      device_map='auto',
      dtype_name='bfloat16',
      gain=1.5,
      speed=1.0,
    )
    with (
      patch.object(Qwen3TtsEngine, '_verify_runtime_imports') as verify,
      patch.object(Qwen3TtsEngine, '_ensure_model', return_value=object()) as preload,
    ):
      Qwen3TtsEngine(config=config)
    verify.assert_called_once_with()
    preload.assert_called_once_with()

  def test_synthesis_forwards_faithful_generation_policy(self) -> None:
    class FakeModel:
      def __init__(self) -> None:
        self.calls = []

      def generate_custom_voice(self, **kwargs):
        self.calls.append(kwargs)
        return [[0.0, 0.25, -0.25]], 24_000

    config = Qwen3Config(
      model_id='model',
      model_revision='revision',
      speaker='Serena',
      language='English',
      ascii_mode='preserve',
      style='neutral',
      generation_mode='faithful',
      device_map='auto',
      dtype_name='bfloat16',
      gain=1.0,
      speed=1.0,
    )
    engine = Qwen3TtsEngine.__new__(Qwen3TtsEngine)
    engine.config = config
    engine._model = FakeModel()
    engine._model_cls = None
    engine._torch = None
    engine._librosa = None

    _audio, sample_rate = engine.synthesize_text(
      'Me gustaría comer birria.',
      language_override='es',
    )

    self.assertEqual(sample_rate, 24_000)
    self.assertEqual(engine._model.calls[0]['language'], 'Spanish')
    self.assertFalse(engine._model.calls[0]['do_sample'])
    self.assertFalse(engine._model.calls[0]['subtalker_dosample'])


class KokoroVoiceConfigTests(unittest.TestCase):
  def test_default_kokoro_voice_is_jf_alpha(self) -> None:
    with patch.dict(os.environ, {}, clear=True):
      self.assertEqual(resolve_kokoro_voice(), "jf_alpha")

  def test_mh_lang_english_defaults_kokoro_voice_to_af_heart(self) -> None:
    self.assertEqual(resolve_kokoro_voice({"MH_LANG": "EN"}), "af_heart")

  def test_non_english_mh_lang_defaults_kokoro_voice_to_jf_alpha(self) -> None:
    self.assertEqual(resolve_kokoro_voice({"MH_LANG": "fr"}), "jf_alpha")

  def test_explicit_kokoro_voice_override_is_preserved(self) -> None:
    with patch.dict(os.environ, {"MH_KOKORO_VOICE": "jf_alpha", "MH_LANG": "en"}, clear=True):
      self.assertEqual(resolve_kokoro_voice(), "jf_alpha")

  def test_explicit_kokoro_voice_mapping_override_is_preserved(self) -> None:
    with patch.dict(os.environ, {"MH_KOKORO_VOICE": "af_heart"}, clear=True):
      self.assertEqual(resolve_kokoro_voice(), "af_heart")

  def test_blank_kokoro_voice_uses_default(self) -> None:
    with patch.dict(os.environ, {"MH_KOKORO_VOICE": "   "}, clear=True):
      self.assertEqual(resolve_kokoro_voice(), "jf_alpha")

  def test_blank_kokoro_voice_uses_mh_lang_default(self) -> None:
    with patch.dict(os.environ, {"MH_KOKORO_VOICE": "   ", "MH_LANG": "en"}, clear=True):
      self.assertEqual(resolve_kokoro_voice(), "af_heart")


if __name__ == "__main__":
  unittest.main()
