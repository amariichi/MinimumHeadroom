from __future__ import annotations

import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT_DIR / 'tts-worker' / 'src'
if str(SRC_DIR) not in sys.path:
  sys.path.insert(0, str(SRC_DIR))

if 'numpy' not in sys.modules:
  sys.modules['numpy'] = types.ModuleType('numpy')

from tts_worker.__main__ import resolve_kokoro_voice
from tts_worker.qwen3_engine import load_qwen3_config


class Qwen3EngineConfigTests(unittest.TestCase):
  def test_default_speed_is_one_point_zero(self) -> None:
    with patch.dict(os.environ, {}, clear=True):
      config = load_qwen3_config()
    self.assertEqual(config.speed, 1.0)

  def test_explicit_speed_override_is_preserved(self) -> None:
    with patch.dict(os.environ, {'MH_QWEN_TTS_SPEED': '1.10'}, clear=True):
      config = load_qwen3_config()
    self.assertEqual(config.speed, 1.1)


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
