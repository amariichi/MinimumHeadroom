from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT_DIR / 'tts-worker' / 'src'
if str(SRC_DIR) not in sys.path:
  sys.path.insert(0, str(SRC_DIR))

from tts_worker.shared_text import normalize_shared_tts_text


class SharedTextPreparationTests(unittest.TestCase):
  def test_rewrites_japanese_decimal_separator_into_spoken_ten(self) -> None:
    rendered = normalize_shared_tts_text('外の温度計は一・八度です。')
    self.assertEqual(rendered, '外の温度計は一点八度です。')

  def test_keeps_dotted_version_number_without_v_prefix_unchanged(self) -> None:
    rendered = normalize_shared_tts_text('現在のバージョンは1.2.3です。')
    self.assertEqual(rendered, '現在のバージョンは1.2.3です。')

  def test_rewrites_v_prefixed_semver_into_spoken_japanese(self) -> None:
    rendered = normalize_shared_tts_text('v1.1 と v1.7.0 を公開しました。')
    self.assertEqual(rendered, 'バージョン1点1 と バージョン1点7点0 を公開しました。')

  def test_prefixes_unknown_leading_ascii_token_with_hai(self) -> None:
    rendered = normalize_shared_tts_text('execplanを作成しました。')
    self.assertEqual(rendered, 'はい、execplanを作成しました。')

  def test_keeps_known_leading_ascii_token_without_extra_hai(self) -> None:
    rendered = normalize_shared_tts_text('GitHub承認申請をお願いします。')
    self.assertEqual(rendered, 'GitHub承認申請をお願いします。')

  def test_prefixes_leading_numeric_japanese_token_with_hai(self) -> None:
    rendered = normalize_shared_tts_text('23日までに完了します。')
    self.assertEqual(rendered, 'はい、23日までに完了します。')

  def test_does_not_prefix_plain_semver_like_sentence_start(self) -> None:
    rendered = normalize_shared_tts_text('1.2.3です。')
    self.assertEqual(rendered, '1.2.3です。')

  def test_normalizes_smart_apostrophe_and_hyphenated_ascii(self) -> None:
    rendered = normalize_shared_tts_text('That’s a 9-to-5 role.')
    self.assertEqual(rendered, "That's a 9 to 5 role.")

  def test_normalizes_smart_quotes_ellipsis_and_nbsp(self) -> None:
    rendered = normalize_shared_tts_text('He said, “Hello”… A\u00A0B\u202FC')
    self.assertEqual(rendered, 'He said, "Hello" A B C')

  def test_normalizes_latin_diacritics(self) -> None:
    rendered = normalize_shared_tts_text('café naïve rôle')
    self.assertEqual(rendered, 'cafe naive role')

  def test_keeps_japanese_intact_while_normalizing_latin_diacritics(self) -> None:
    rendered = normalize_shared_tts_text('日本語が café')
    self.assertEqual(rendered, '日本語が cafe')

  def test_keeps_full_width_symbols_untouched(self) -> None:
    rendered = normalize_shared_tts_text('ＡＢＣ！')
    self.assertEqual(rendered, 'ＡＢＣ！')

  def test_normalizes_punctuation_and_diacritics_without_language_hint(self) -> None:
    rendered = normalize_shared_tts_text('That’s fine… café')
    self.assertEqual(rendered, "That's fine cafe")

  def test_keeps_japanese_punctuation_inside_regular_text(self) -> None:
    rendered = normalize_shared_tts_text('こんにちは。ありがとう、助かる・本当に')
    self.assertEqual(rendered, 'こんにちは。ありがとう、助かる・本当に')

  def test_drops_punctuation_only_utterance_after_shared_preparation(self) -> None:
    rendered = normalize_shared_tts_text('。、、・・。。。')
    self.assertEqual(rendered, '')


if __name__ == '__main__':
  unittest.main()
