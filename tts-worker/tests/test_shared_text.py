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

  def test_converts_halfwidth_digits_to_fullwidth_in_dotted_version(self) -> None:
    # JA-routed text steers Kokoro/misaki toward Japanese G2P by
    # fullwidth-ifying halfwidth digits, even for dotted-version forms.
    rendered = normalize_shared_tts_text('現在のバージョンは1.2.3です。')
    self.assertEqual(rendered, '現在のバージョンは１.２.３です。')

  def test_rewrites_v_prefixed_semver_into_spoken_japanese(self) -> None:
    rendered = normalize_shared_tts_text('v1.1 と v1.7.0 を公開しました。')
    self.assertEqual(rendered, 'バージョン１点１ と バージョン１点７点０ を公開しました。')

  def test_does_not_prefix_unknown_leading_ascii_token_with_hai(self) -> None:
    # The leading "はい、" filler is a Qwen3-only countermeasure and no
    # longer fires from the shared normalizer; Kokoro keeps the original.
    rendered = normalize_shared_tts_text('execplanを作成しました。')
    self.assertEqual(rendered, 'execplanを作成しました。')

  def test_keeps_known_leading_ascii_token_unchanged(self) -> None:
    rendered = normalize_shared_tts_text('GitHub承認申請をお願いします。')
    self.assertEqual(rendered, 'GitHub承認申請をお願いします。')

  def test_does_not_prefix_leading_numeric_japanese_token_with_hai(self) -> None:
    # Filler moved to Qwen3 path; shared normalizer only fullwidth-ifies
    # the halfwidth digits so misaki reads them as Japanese.
    rendered = normalize_shared_tts_text('23日までに完了します。')
    self.assertEqual(rendered, '２３日までに完了します。')

  def test_converts_halfwidth_digits_in_japanese_date_phrase(self) -> None:
    # Primary motivating case: "5月23日" used to read as
    # "ファイブ月 トゥエンティ・スリー日" because misaki applied English
    # G2P to halfwidth digits in Japanese text.
    rendered = normalize_shared_tts_text('今日は5月23日です。')
    self.assertEqual(rendered, '今日は５月２３日です。')

  def test_leaves_digits_in_pure_english_sentence_alone(self) -> None:
    # English-routed text must keep halfwidth digits intact so the
    # English G2P still reads them as English numerals.
    rendered = normalize_shared_tts_text('The build runs at 5:30 on port 8080.')
    self.assertEqual(rendered, 'The build runs at 5:30 on port 8080.')

  def test_keeps_plain_dotted_form_unchanged_without_japanese(self) -> None:
    # No Japanese script in the input ⇒ English normalizer path ⇒ digits
    # untouched (mirrors the behavior LLMs need when speaking English).
    rendered = normalize_shared_tts_text('1.2.3.')
    self.assertEqual(rendered, '1.2.3.')

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
