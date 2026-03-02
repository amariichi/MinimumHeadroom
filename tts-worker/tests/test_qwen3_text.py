from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT_DIR / 'tts-worker' / 'src'
if str(SRC_DIR) not in sys.path:
  sys.path.insert(0, str(SRC_DIR))

from tts_worker.qwen3_text import prepare_qwen3_text


class Qwen3TextPreparationTests(unittest.TestCase):
  def test_english_profile_adds_hai_for_kanji_start(self) -> None:
    rendered = prepare_qwen3_text(
      '本日は状態を確認します。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'はい、本日は状態を確認します。')

  def test_english_profile_leaves_non_kanji_start_alone(self) -> None:
    rendered = prepare_qwen3_text(
      'Hello. This is a test.',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'Hello. This is a test.')

  def test_existing_hiragana_start_is_not_prefixed_twice(self) -> None:
    rendered = prepare_qwen3_text(
      'はい、本日は状態を確認します。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'はい、本日は状態を確認します。')

  def test_japanese_ascii_rewrite_still_works_without_leadin(self) -> None:
    rendered = prepare_qwen3_text(
      '本日は AI と HTTPS を確認します。',
      ascii_mode='kana_alias',
      language='Japanese',
    )
    self.assertEqual(rendered, '本日は エーアイ と エイチティーティーピーエス を確認します。')


if __name__ == '__main__':
  unittest.main()
