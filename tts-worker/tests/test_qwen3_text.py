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

  def test_english_profile_rewrites_uppercase_acronyms_for_speech(self) -> None:
    rendered = prepare_qwen3_text(
      'PRを出してCIが通ったらSSHで確認します。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'ピーアールを出してシーアイが通ったらエスエスエイチで確認します。')

  def test_english_profile_rewrites_mixed_form_tokens_for_speech(self) -> None:
    rendered = prepare_qwen3_text(
      'CI/CDのあとでNode.jsとGitHubを確認します。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'シーアイ・シーディーのあとでノードジェイエスとギットハブを確認します。')

  def test_english_profile_rewrites_pull_request_phrase_for_speech(self) -> None:
    rendered = prepare_qwen3_text(
      'GitHubでpull requestを見ます。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'ギットハブでプルリクエストを見ます。')

  def test_english_profile_rewrites_request_token_for_speech(self) -> None:
    rendered = prepare_qwen3_text(
      'requestの発音を確認します。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'リクエストの発音を確認します。')

  def test_english_profile_rewrites_readme_token_for_speech(self) -> None:
    rendered = prepare_qwen3_text(
      'README と Readme を確認します。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'リードミー と リードミー を確認します。')

  def test_english_profile_keeps_lowercase_shell_words_literal(self) -> None:
    rendered = prepare_qwen3_text(
      'ssh で ci を確認します。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'ssh で ci を確認します。')

  def test_english_profile_rewrites_selected_japanese_terms_for_speech(self) -> None:
    rendered = prepare_qwen3_text(
      '承認申請をお願いします。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'はい、しょうにんしんせいをお願いします。')

  def test_english_profile_rewrites_next_sentence_marker_for_speech(self) -> None:
    rendered = prepare_qwen3_text(
      '一倍速の明瞭化は確認できました。次は機械側の比較で詰めます。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'はい、一倍速の明瞭化は確認できました。つぎは機械側の比較で詰めます。')

  def test_english_profile_inserts_pause_between_ascii_token_and_japanese_text(self) -> None:
    rendered = prepare_qwen3_text(
      'github承認申請をお願いします。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'ギットハブ、しょうにんしんせいをお願いします。')

  def test_english_profile_converts_ascii_sentence_break_before_japanese_text(self) -> None:
    rendered = prepare_qwen3_text(
      'GitHub.承認申請をお願いします。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'ギットハブ。しょうにんしんせいをお願いします。')

  def test_english_profile_inserts_pause_for_mixed_form_token_before_kanji(self) -> None:
    rendered = prepare_qwen3_text(
      'Node.js承認申請をお願いします。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'ノードジェイエス、しょうにんしんせいをお願いします。')

  def test_english_profile_converts_ascii_clause_break_before_kanji(self) -> None:
    rendered = prepare_qwen3_text(
      'CI/CD:承認申請をお願いします。',
      ascii_mode='preserve',
      language='English',
    )
    self.assertEqual(rendered, 'シーアイ・シーディー、しょうにんしんせいをお願いします。')

  def test_japanese_ascii_rewrite_still_works_without_leadin(self) -> None:
    rendered = prepare_qwen3_text(
      '本日は AI と HTTPS を確認します。',
      ascii_mode='kana_alias',
      language='Japanese',
    )
    self.assertEqual(rendered, '本日は エーアイ と エイチティーティーピーエス を確認します。')

  def test_japanese_kana_alias_uses_generic_spelling_for_unknown_uppercase_acronyms(self) -> None:
    rendered = prepare_qwen3_text(
      'PR と CI を確認します。',
      ascii_mode='kana_alias',
      language='Japanese',
    )
    self.assertEqual(rendered, 'ピーアール と シーアイ を確認します。')

  def test_japanese_kana_alias_rewrites_mixed_form_tokens(self) -> None:
    rendered = prepare_qwen3_text(
      'Node.js と CI/CD を確認します。',
      ascii_mode='kana_alias',
      language='Japanese',
    )
    self.assertEqual(rendered, 'ノードジェイエス と シーアイ・シーディー を確認します。')


if __name__ == '__main__':
  unittest.main()
