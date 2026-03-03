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


if __name__ == '__main__':
  unittest.main()
