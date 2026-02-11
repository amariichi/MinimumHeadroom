from __future__ import annotations

from dataclasses import dataclass
from typing import List

ASCII_MAX_CHARS = 220
NON_ASCII_MAX_CHARS = 120
BOUNDARY_CHARS = set('。！？!?.,、;；:\n')
ASCII_SOFT_BREAK_CHARS = set(' \t,.;:!?)]}')


@dataclass(frozen=True)
class TextChunk:
  text: str
  lang: str
  speed: float
  is_phonemes: bool = False


def is_ascii_printable(char: str) -> bool:
  code = ord(char)
  return 0x20 <= code <= 0x7E


def split_text_chunks(text: str) -> List[TextChunk]:
  if not text:
    return []

  segments = _split_script_runs(text)
  chunks: List[TextChunk] = []

  for segment_text, ascii_flag in segments:
    for part in _split_segment(segment_text, ascii_flag):
      chunks.append(_build_chunk(part, ascii_flag))

  if not chunks:
    normalized = text.strip()
    if normalized:
      chunks.append(_build_chunk(normalized, _all_ascii(normalized)))

  return chunks


def _all_ascii(text: str) -> bool:
  return all(is_ascii_printable(char) for char in text)


def _split_script_runs(text: str) -> List[tuple[str, bool]]:
  segments: List[tuple[str, bool]] = []
  current: List[str] = []
  current_ascii: bool | None = None

  for char in text:
    ascii_flag = is_ascii_printable(char)
    if current_ascii is None:
      current_ascii = ascii_flag

    if ascii_flag != current_ascii:
      segment = ''.join(current).strip()
      if segment:
        segments.append((segment, current_ascii))
      current = [char]
      current_ascii = ascii_flag
      continue

    current.append(char)

  if current:
    segment = ''.join(current).strip()
    if segment:
      segments.append((segment, bool(current_ascii)))

  return segments


def _split_segment(text: str, ascii_flag: bool) -> List[str]:
  normalized = text.strip()
  if not normalized:
    return []

  max_chars = ASCII_MAX_CHARS if ascii_flag else NON_ASCII_MAX_CHARS
  result: List[str] = []
  buffer: List[str] = []

  for char in normalized:
    buffer.append(char)

    if char in BOUNDARY_CHARS:
      _append_with_limit(result, ''.join(buffer), max_chars, ascii_flag)
      buffer = []
      continue

    if len(buffer) >= max_chars:
      _append_with_limit(result, ''.join(buffer), max_chars, ascii_flag)
      buffer = []

  if buffer:
    _append_with_limit(result, ''.join(buffer), max_chars, ascii_flag)

  return result


def _append_with_limit(result: List[str], value: str, max_chars: int, ascii_flag: bool) -> None:
  remaining = value.strip()
  if not remaining:
    return

  while len(remaining) > max_chars:
    cut = _best_cut_index(remaining, max_chars, ascii_flag)
    if cut <= 0:
      cut = max_chars

    head = remaining[:cut].strip()
    if head:
      result.append(head)
    remaining = remaining[cut:].strip()

  if remaining:
    result.append(remaining)


def _best_cut_index(text: str, max_chars: int, ascii_flag: bool) -> int:
  floor = max(1, max_chars // 2)
  search_end = min(len(text), max_chars)

  if ascii_flag:
    for index in range(search_end - 1, floor - 1, -1):
      if text[index] in ASCII_SOFT_BREAK_CHARS:
        return index + 1
  else:
    for index in range(search_end - 1, floor - 1, -1):
      if text[index] in BOUNDARY_CHARS:
        return index + 1

  return search_end


def _build_chunk(text: str, ascii_flag: bool) -> TextChunk:
  if ascii_flag:
    return TextChunk(text=text, lang='en-us', speed=1.0, is_phonemes=False)
  return TextChunk(text=text, lang='j', speed=1.2, is_phonemes=True)
