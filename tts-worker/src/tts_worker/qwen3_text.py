from __future__ import annotations

import re


QWEN3_ASCII_MODES = {'preserve', 'fullwidth', 'kana_alias'}
QWEN3_STYLES = {'neutral', 'soft', 'narration'}
QWEN3_LANGUAGES = {'Japanese', 'English'}
_ASCII_TOKEN_RE = re.compile(r'(?<![A-Za-z0-9])([A-Za-z0-9][A-Za-z0-9./:+_-]{1,7})(?![A-Za-z0-9])')
_LEADING_WHITESPACE_RE = re.compile(r'^(\s*)')
_MIXED_BOUNDARY_TOKEN_RE = r'([A-Za-z0-9][A-Za-z0-9./:+_-]{0,31})'
_KANJI_SCRIPT_CLASS = r'㐀-䶿一-龯々〆ヵヶ豈-﫿'
_ASCII_DIRECT_TO_KANJI_RE = re.compile(rf'{_MIXED_BOUNDARY_TOKEN_RE}(?=[{_KANJI_SCRIPT_CLASS}])')
_ASCII_CLAUSE_BREAK_TO_KANJI_RE = re.compile(rf'{_MIXED_BOUNDARY_TOKEN_RE}\s*[,;:]\s*(?=[{_KANJI_SCRIPT_CLASS}])')
_ASCII_SENTENCE_BREAK_TO_KANJI_RE = re.compile(rf'{_MIXED_BOUNDARY_TOKEN_RE}\s*[.!?]\s*(?=[{_KANJI_SCRIPT_CLASS}])')
_SEMVER_SPEECH_RE = re.compile(r'(?<![A-Za-z0-9])[vV](\d+(?:\.\d+){1,2})(?![A-Za-z0-9])')
_KANA_ALIASES = {
  'AI': 'エーアイ',
  'API': 'エーピーアイ',
  'HTTP': 'エイチティーティーピー',
  'HTTPS': 'エイチティーティーピーエス',
  'URL': 'ユーアールエル',
}
_EXACT_SPEECH_ALIASES = {
  'CI/CD': 'シーアイ・シーディー',
  'GitHub': 'ギットハブ',
  'github': 'ギットハブ',
  'nodejs': 'ノードジェイエス',
  'Node.js': 'ノードジェイエス',
  'node.js': 'ノードジェイエス',
  'readme': 'リードミー',
  'request': 'リクエスト',
}
_EXACT_ENGLISH_PHRASE_SPEECH_ALIASES = {
  'pull request': 'プルリクエスト',
}
_EXACT_JAPANESE_SPEECH_ALIASES = {
  '承認申請': 'しょうにんしんせい',
  '次は': 'つぎは',
  '次に': 'つぎに',
}
_LATIN_LETTER_KANA = {
  'A': 'エー',
  'B': 'ビー',
  'C': 'シー',
  'D': 'ディー',
  'E': 'イー',
  'F': 'エフ',
  'G': 'ジー',
  'H': 'エイチ',
  'I': 'アイ',
  'J': 'ジェイ',
  'K': 'ケイ',
  'L': 'エル',
  'M': 'エム',
  'N': 'エヌ',
  'O': 'オー',
  'P': 'ピー',
  'Q': 'キュー',
  'R': 'アール',
  'S': 'エス',
  'T': 'ティー',
  'U': 'ユー',
  'V': 'ブイ',
  'W': 'ダブリュー',
  'X': 'エックス',
  'Y': 'ワイ',
  'Z': 'ゼット',
}


def normalize_ascii_mode(raw: str | None) -> str:
  if raw is None:
    return 'preserve'
  normalized = raw.strip().lower()
  if normalized in QWEN3_ASCII_MODES:
    return normalized
  raise ValueError(f'unsupported MH_QWEN_JA_ASCII_MODE: {raw} (expected preserve|fullwidth|kana_alias)')


def normalize_style(raw: str | None) -> str:
  if raw is None:
    return 'neutral'
  normalized = raw.strip().lower()
  if normalized in QWEN3_STYLES:
    return normalized
  raise ValueError(f'unsupported MH_QWEN_TTS_STYLE: {raw} (expected neutral|soft|narration)')


def normalize_language(raw: str | None) -> str:
  if raw is None:
    return 'Japanese'
  normalized = raw.strip().lower()
  if normalized in {'ja', 'japanese'}:
    return 'Japanese'
  if normalized in {'en', 'english'}:
    return 'English'
  raise ValueError(f'unsupported MH_QWEN_TTS_LANGUAGE: {raw} (expected Japanese|English)')


def prepare_qwen3_text(text: str, *, ascii_mode: str, language: str) -> str:
  normalized_language = normalize_language(language)
  text = _apply_japanese_leadin_filler(text, language=normalized_language)
  if normalized_language != 'Japanese':
    text = _stabilize_english_mixed_script_boundaries(text)
    text = _apply_exact_japanese_speech_aliases(text)
    text = _apply_exact_english_phrase_speech_aliases(text)
    text = _apply_semver_speech_aliases(text)
    return _apply_english_speech_aliases(text)

  mode = normalize_ascii_mode(ascii_mode)
  if mode == 'preserve':
    return text

  def replace(match: re.Match[str]) -> str:
    token = match.group(1)
    if mode == 'kana_alias':
      alias = _render_kana_alias(token)
      if alias:
        return alias
    if not _is_rewritable_ascii_token(token):
      return token
    if mode == 'fullwidth':
      return _to_fullwidth(token)
    return token

  return _ASCII_TOKEN_RE.sub(replace, text)


def build_qwen3_instruction(style: str, *, language: str) -> str:
  normalized_language = normalize_language(language)
  normalized = normalize_style(style)
  if normalized_language == 'English':
    if normalized == 'soft':
      return (
        'Speak in English with a gentle, calm, approachable voice and clear articulation. '
        'Avoid sounding gloomy, sleepy, emotionally downcast, or unstable. '
        'Keep the delivery warm, steady, and easy to understand.'
      )
    if normalized == 'narration':
      return (
        'Speak in English like a clear explanatory narration. '
        'Keep a steady pace, stable tone, and easy-to-follow delivery.'
      )
    return (
      'Speak in English with a clear, stable, natural voice. '
      'Avoid exaggerated emotion and keep the message easy to understand.'
    )

  if normalized == 'soft':
    return (
      '日本語で、やさしく穏やかな口調で、明瞭に読み上げてください。'
      '暗く沈んだ感じや眠そうな話し方は避け、落ち着いて安定したトーンを保ってください。'
    )
  if normalized == 'narration':
    return '日本語で、説明音声のように、明瞭で聞き取りやすく、一定のテンポで読み上げてください。'
  return '日本語で、明瞭で安定した口調で、感情を誇張せず自然に読み上げてください。'


def _apply_japanese_leadin_filler(text: str, *, language: str) -> str:
  if language != 'English' or text == '':
    return text

  first = _first_significant_char(text)
  if first is None or not _is_cjk_ideograph(first):
    return text

  leading_match = _LEADING_WHITESPACE_RE.match(text)
  leading = leading_match.group(1) if leading_match else ''
  return f'{leading}はい、{text[len(leading):]}'


def _apply_english_speech_aliases(text: str) -> str:
  def replace(match: re.Match[str]) -> str:
    token = match.group(1)
    alias = _render_spoken_ascii_alias(token)
    if alias:
      return alias
    return token

  return _ASCII_TOKEN_RE.sub(replace, text)


def _apply_exact_japanese_speech_aliases(text: str) -> str:
  for source, replacement in _EXACT_JAPANESE_SPEECH_ALIASES.items():
    text = text.replace(source, replacement)
  return text


def _apply_exact_english_phrase_speech_aliases(text: str) -> str:
  for source, replacement in _EXACT_ENGLISH_PHRASE_SPEECH_ALIASES.items():
    text = re.sub(rf'(?<![A-Za-z0-9]){re.escape(source)}(?![A-Za-z0-9])', replacement, text, flags=re.IGNORECASE)
  return text


def _apply_semver_speech_aliases(text: str) -> str:
  def replace(match: re.Match[str]) -> str:
    rendered = match.group(1).replace('.', '点')
    spoken = f'バージョン{rendered}'
    if text[:match.start()].strip() == '':
      return f'はい、{spoken}'
    return spoken

  return _SEMVER_SPEECH_RE.sub(replace, text)


def _stabilize_english_mixed_script_boundaries(text: str) -> str:
  text = _ASCII_CLAUSE_BREAK_TO_KANJI_RE.sub(r'\1、', text)
  text = _ASCII_SENTENCE_BREAK_TO_KANJI_RE.sub(r'\1。', text)
  return _ASCII_DIRECT_TO_KANJI_RE.sub(r'\1、', text)


def _is_rewritable_ascii_token(token: str) -> bool:
  if len(token) < 2 or len(token) > 8:
    return False
  if token.upper() != token:
    return False
  return any(char.isalnum() for char in token)


def _render_kana_alias(token: str) -> str | None:
  return _render_spoken_ascii_alias(token, allow_explicit_aliases=True)


def _render_spoken_ascii_alias(token: str, *, allow_explicit_aliases: bool = True) -> str | None:
  if allow_explicit_aliases:
    explicit = _EXACT_SPEECH_ALIASES.get(token)
    if explicit is None:
      explicit = _EXACT_SPEECH_ALIASES.get(token.lower())
    if explicit:
      return explicit
  if not token.isalpha() or len(token) < 2 or len(token) > 8:
    return None
  upper = token.upper()
  alias = _KANA_ALIASES.get(upper)
  if alias:
    return alias
  if token != upper:
    return None

  rendered: list[str] = []
  for char in upper:
    spoken = _LATIN_LETTER_KANA.get(char)
    if spoken is None:
      return None
    rendered.append(spoken)
  return ''.join(rendered)


def _first_significant_char(text: str) -> str | None:
  for char in text:
    if char.isspace():
      continue
    if char in '「『（([{"\'“‘':
      continue
    return char
  return None


def _is_cjk_ideograph(char: str) -> bool:
  code = ord(char)
  return (
    0x3400 <= code <= 0x4DBF
    or 0x4E00 <= code <= 0x9FFF
    or 0xF900 <= code <= 0xFAFF
    or 0x20000 <= code <= 0x2CEAF
  )


def _to_fullwidth(text: str) -> str:
  rendered: list[str] = []
  for char in text:
    code = ord(char)
    if char == ' ':
      rendered.append('\u3000')
      continue
    if 0x21 <= code <= 0x7E:
      rendered.append(chr(code + 0xFEE0))
      continue
    rendered.append(char)
  return ''.join(rendered)
