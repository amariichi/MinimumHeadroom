from __future__ import annotations

import re
import unicodedata


KANJI_SCRIPT_CLASS = '㐀-䶿一-龯々〆ヵヶ豈-﫿'
JAPANESE_CHAR_CLASS = rf'\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FD-\u30FF{KANJI_SCRIPT_CLASS}'
JAPANESE_SCRIPT_RE = re.compile(rf'[{JAPANESE_CHAR_CLASS}]')
JAPANESE_NUMERIC_CLASS = '0-9０-９〇零一二三四五六七八九十百千万億兆'
JAPANESE_NUMERIC_CHAIN_RE = re.compile(
  rf'([{JAPANESE_NUMERIC_CLASS}]+(?:\s*[.．・･]\s*[{JAPANESE_NUMERIC_CLASS}]+)+)'
)
JAPANESE_SEMVER_RE = re.compile(r'(?<![A-Za-z0-9])[vV](\d+(?:\.\d+){1,2})(?![A-Za-z0-9])')
LEADING_DECORATION_RE = re.compile(r'^(?P<leading>\s*[「『（([{\'"“‘]*)')
LEADING_ASCII_TOKEN_RE = re.compile(r'^([A-Za-z][A-Za-z0-9./:+_-]{0,31})')
LEADING_NUMERIC_TOKEN_RE = re.compile(r'^([0-9０-９]+(?:[.．・･点][0-9０-９]+)?)(?![0-9０-９.．・･点])')
LEADING_JAPANESE_RE = re.compile(rf'^\s*[{JAPANESE_CHAR_CLASS}]')
INTER_ALNUM_DASH_RE = re.compile(r'([A-Za-z0-9])[-‐‑‒–—−]([A-Za-z0-9])')
WHITESPACE_RE = re.compile(r'\s+')
SPACES_ONLY_RE = re.compile(r'[ \t]+')
KNOWN_LEADING_ASCII_TOKENS = {
  'ai',
  'api',
  'http',
  'https',
  'url',
  'ci/cd',
  'github',
  'nodejs',
  'node.js',
  'readme',
  'request',
  'pull',
  'pr',
  'ci',
  'cd',
  'ssh',
  'cli',
  'json',
  'yaml',
  'gpu',
  'cpu',
}


def normalize_shared_tts_text(text: str) -> str:
  if JAPANESE_SCRIPT_RE.search(text):
    return normalize_japanese_tts_text(text)
  return normalize_english_tts_text(text)


def normalize_english_tts_text(text: str) -> str:
  normalized = (
    text.replace('‘', "'")
    .replace('’', "'")
    .replace('“', '"')
    .replace('”', '"')
  )
  normalized = re.sub(r'\s*…\s*', ' ', normalized)
  normalized = re.sub(r'\s*\.{3,}\s*', ' ', normalized)
  normalized = re.sub(r'[。、・]+', ' ', normalized)
  normalized = normalized.replace('\u00A0', ' ').replace('\u202F', ' ')
  normalized = _strip_latin_diacritics(normalized)
  normalized = INTER_ALNUM_DASH_RE.sub(r'\1 \2', normalized)
  return WHITESPACE_RE.sub(' ', normalized).strip()


def normalize_japanese_tts_text(text: str) -> str:
  normalized = (
    text.replace('‘', "'")
    .replace('’', "'")
    .replace('“', '"')
    .replace('”', '"')
  )
  normalized = re.sub(r'\s*…\s*', '、', normalized)
  normalized = re.sub(r'\s*\.{3,}\s*', '、', normalized)
  normalized = normalized.replace('\u00A0', ' ').replace('\u202F', ' ')
  normalized = _strip_latin_diacritics(normalized)
  normalized = replace_japanese_semver_tokens(normalized)
  normalized = replace_japanese_decimal_separators(normalized)
  normalized = apply_japanese_leading_numeric_filler(normalized)
  normalized = apply_japanese_leading_unknown_ascii_filler(normalized)
  return SPACES_ONLY_RE.sub(' ', normalized).strip()


def replace_japanese_decimal_separators(text: str) -> str:
  def replace(match: re.Match[str]) -> str:
    segment = match.group(1)
    separators = re.findall(r'[.．・･]', segment)
    if len(separators) != 1:
      return segment
    return re.sub(r'\s*[.．・･]\s*', '点', segment)

  return JAPANESE_NUMERIC_CHAIN_RE.sub(replace, text)


def replace_japanese_semver_tokens(text: str) -> str:
  def replace(match: re.Match[str]) -> str:
    version = match.group(1)
    return f"バージョン{version.replace('.', '点')}"

  return JAPANESE_SEMVER_RE.sub(replace, text)


def apply_japanese_leading_unknown_ascii_filler(text: str) -> str:
  leading_match = LEADING_DECORATION_RE.match(text)
  leading = leading_match.group('leading') if leading_match else ''
  rest = text[len(leading):]
  token_match = LEADING_ASCII_TOKEN_RE.match(rest)
  if token_match is None:
    return text

  token = token_match.group(1)
  if token.lower() in KNOWN_LEADING_ASCII_TOKENS:
    return text

  trailing = rest[len(token):]
  if not JAPANESE_SCRIPT_RE.search(trailing):
    return text

  return f'{leading}はい、{rest}'


def apply_japanese_leading_numeric_filler(text: str) -> str:
  leading_match = LEADING_DECORATION_RE.match(text)
  leading = leading_match.group('leading') if leading_match else ''
  rest = text[len(leading):]
  token_match = LEADING_NUMERIC_TOKEN_RE.match(rest)
  if token_match is None:
    return text

  trailing = rest[len(token_match.group(1)):]
  if not LEADING_JAPANESE_RE.match(trailing):
    return text

  return f'{leading}はい、{rest}'


def _strip_latin_diacritics(text: str) -> str:
  normalized = unicodedata.normalize('NFD', text)
  result: list[str] = []
  last_base_is_latin = False

  for char in normalized:
    if unicodedata.combining(char):
      if last_base_is_latin:
        continue
      result.append(char)
      continue

    result.append(char)
    try:
      last_base_is_latin = 'LATIN' in unicodedata.name(char)
    except ValueError:
      last_base_is_latin = False

  return unicodedata.normalize('NFC', ''.join(result))
