from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT_DIR / 'tts-worker' / 'src'
if str(SRC_DIR) not in sys.path:
  sys.path.insert(0, str(SRC_DIR))

from tts_worker.kokoro_text import strip_japanese_silent_punctuation


class StripJapaneseSilentPunctuationTests(unittest.TestCase):
  def test_drops_trailing_full_stop(self) -> None:
    self.assertEqual(strip_japanese_silent_punctuation('あ。'), 'あ')

  def test_drops_runs_of_full_stops(self) -> None:
    self.assertEqual(strip_japanese_silent_punctuation('あ。。。。。'), 'あ')

  def test_drops_internal_and_trailing_full_stops(self) -> None:
    self.assertEqual(
      strip_japanese_silent_punctuation('あ。い。う。'), 'あ い う'
    )

  def test_drops_fullwidth_period(self) -> None:
    self.assertEqual(strip_japanese_silent_punctuation('あ．'), 'あ')

  def test_drops_japanese_punctuation_inside_speech(self) -> None:
    self.assertEqual(
      strip_japanese_silent_punctuation('あ、い！う？え・お…'),
      'あ い う え お',
    )

  def test_drops_story_sentence_punctuation_without_dropping_words(self) -> None:
    self.assertEqual(
      strip_japanese_silent_punctuation('むかしむかしあるところに、おじいさんが？'),
      'むかしむかしあるところに おじいさんが',
    )

  def test_returns_empty_for_punctuation_only_input(self) -> None:
    self.assertEqual(strip_japanese_silent_punctuation('。。。'), '')
    self.assertEqual(strip_japanese_silent_punctuation('・？'), '')
    self.assertEqual(strip_japanese_silent_punctuation('!?…'), '')

  def test_passes_through_empty_string(self) -> None:
    self.assertEqual(strip_japanese_silent_punctuation(''), '')

  def test_passes_through_ascii_text(self) -> None:
    self.assertEqual(
      strip_japanese_silent_punctuation('Hello, world.'),
      'Hello, world.',
    )


if __name__ == '__main__':
  unittest.main()
