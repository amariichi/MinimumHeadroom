from __future__ import annotations

from dataclasses import dataclass
from typing import List


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

  chunks: List[TextChunk] = []
  current = []
  current_ascii = None

  for char in text:
    ascii_flag = is_ascii_printable(char)
    if current_ascii is None:
      current_ascii = ascii_flag

    if ascii_flag != current_ascii:
      chunk_text = ''.join(current).strip()
      if chunk_text:
        chunks.append(_build_chunk(chunk_text, current_ascii))
      current = [char]
      current_ascii = ascii_flag
      continue

    current.append(char)

  if current:
    chunk_text = ''.join(current).strip()
    if chunk_text:
      chunks.append(_build_chunk(chunk_text, bool(current_ascii)))

  if not chunks:
    normalized = text.strip()
    if normalized:
      chunks.append(_build_chunk(normalized, _all_ascii(normalized)))

  return chunks


def _all_ascii(text: str) -> bool:
  return all(is_ascii_printable(char) for char in text)


def _build_chunk(text: str, ascii_flag: bool) -> TextChunk:
  if ascii_flag:
    return TextChunk(text=text, lang='en-us', speed=1.0, is_phonemes=False)
  return TextChunk(text=text, lang='j', speed=1.2, is_phonemes=True)
