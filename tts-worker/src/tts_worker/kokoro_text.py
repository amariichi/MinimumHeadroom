from __future__ import annotations

import re

# Misaki's pyopenjtalk-backed Japanese G2P maps several Japanese punctuation
# marks to audible filler-like phonemes. Replace them with spaces before
# Japanese phonemization.
# face-app still keeps the original text for display and logs.
_SILENT_PUNCT_RE = re.compile(r'[。．、，！？!?・･…]+')


def strip_japanese_silent_punctuation(text: str) -> str:
  cleaned = _SILENT_PUNCT_RE.sub(' ', text)
  cleaned = re.sub(r'\s+', ' ', cleaned).strip()
  if cleaned and not any(ch.isalnum() for ch in cleaned):
    return ''
  return cleaned
