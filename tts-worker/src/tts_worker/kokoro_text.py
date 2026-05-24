from __future__ import annotations

import re

# Misaki's pyopenjtalk-backed Japanese G2P maps the JA full-stop 「。」
# (and its fullwidth ASCII twin 「．」) to an audible phoneme rather than
# silence, so Kokoro renders chunk endings as a short "ye"-like sound.
# Chunk boundaries already separate sentences, so dropping these
# characters before phonemization removes the artifact without losing
# meaningful prosody. Other JA punctuation (「、」「！」「？」「・」) is
# left in place because it either drives prosodic pausing or has not
# been observed to produce an artifact.
_SILENT_PUNCT_RE = re.compile(r'[。．]+')


def strip_japanese_silent_punctuation(text: str) -> str:
  return _SILENT_PUNCT_RE.sub('', text)
