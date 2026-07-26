from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import re
from typing import Any, Optional, Tuple

import numpy as np

from .engine import EngineMetadata


SUPPORTED_SUPERTONIC_LANGUAGES = frozenset(
  {
    'ar', 'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de',
    'el', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'lv', 'lt', 'pl', 'pt',
    'ro', 'ru', 'sk', 'sl', 'es', 'sv', 'tr', 'uk', 'vi',
  }
)
SUPERTONIC_MODEL_REVISION = '724fb5abbf5502583fb520898d45929e62f02c0b'
_JAPANESE_SCRIPT_RE = re.compile(r'[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]')
_KOREAN_SCRIPT_RE = re.compile(r'[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]')
_ARABIC_SCRIPT_RE = re.compile(r'[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]')
_GREEK_SCRIPT_RE = re.compile(r'[\u0370-\u03ff\u1f00-\u1fff]')
_DEVANAGARI_SCRIPT_RE = re.compile(r'[\u0900-\u097f]')
_CYRILLIC_SCRIPT_RE = re.compile(r'[\u0400-\u052f]')


@dataclass(frozen=True)
class SupertonicConfig:
  voice: str
  total_steps: int
  speed: float
  intra_op_threads: int
  inter_op_threads: int
  cache_dir: Path
  model_revision: str
  language: str = 'auto'


def normalize_supertonic_language(value: str | None) -> str:
  normalized = value.strip().lower().split('-', 1)[0] if isinstance(value, str) else ''
  if normalized not in SUPPORTED_SUPERTONIC_LANGUAGES:
    raise ValueError(f'unsupported Supertonic language: {normalized or "missing"}')
  return normalized


def normalize_supertonic_language_policy(value: str | None) -> str:
  normalized = value.strip().lower() if isinstance(value, str) else ''
  if normalized in {'', 'auto', 'und'}:
    return 'auto'
  return normalize_supertonic_language(normalized)


def resolve_supertonic_language(
  text: str,
  language_override: str | None,
  configured_language: str = 'auto',
) -> str:
  if isinstance(language_override, str) and language_override.strip():
    return normalize_supertonic_language(language_override)

  policy = normalize_supertonic_language_policy(configured_language)
  source = text if isinstance(text, str) else ''
  if _JAPANESE_SCRIPT_RE.search(source):
    return 'ja'
  if _KOREAN_SCRIPT_RE.search(source):
    return 'ko'
  if _ARABIC_SCRIPT_RE.search(source):
    return 'ar'
  if _GREEK_SCRIPT_RE.search(source):
    return 'el'
  if _DEVANAGARI_SCRIPT_RE.search(source):
    return 'hi'
  if _CYRILLIC_SCRIPT_RE.search(source):
    return 'ru'
  if policy != 'auto':
    return policy
  return 'en'


def _thread_count(
  primary_name: str,
  compatibility_name: str,
  default: int,
) -> int:
  raw = os.getenv(primary_name) or os.getenv(compatibility_name)
  if raw is None or raw.strip() == '':
    return default
  try:
    value = int(raw)
  except ValueError as error:
    raise RuntimeError(f'{primary_name} must be an integer') from error
  if value < 1 or value > 64:
    raise RuntimeError(f'{primary_name} must be between 1 and 64')
  return value


def load_supertonic_config() -> SupertonicConfig:
  voice = (os.getenv('MH_SUPERTONIC_VOICE') or 'M1').strip()
  if voice not in {f'{prefix}{index}' for prefix in ('M', 'F') for index in range(1, 6)}:
    raise RuntimeError('MH_SUPERTONIC_VOICE must be one of M1-M5 or F1-F5')
  try:
    total_steps = int(os.getenv('MH_SUPERTONIC_STEPS') or '8')
  except ValueError as error:
    raise RuntimeError('MH_SUPERTONIC_STEPS must be an integer') from error
  if total_steps < 5 or total_steps > 12:
    raise RuntimeError('MH_SUPERTONIC_STEPS must be between 5 and 12')
  try:
    speed = float(os.getenv('MH_SUPERTONIC_SPEED') or '1.05')
  except ValueError as error:
    raise RuntimeError('MH_SUPERTONIC_SPEED must be a number') from error
  if speed < 0.7 or speed > 2.0:
    raise RuntimeError('MH_SUPERTONIC_SPEED must be between 0.7 and 2.0')
  # ONNX Runtime auto-detection can see more host CPUs than the process
  # affinity/cgroup actually permits. On this host that caused severe
  # oversubscription (a short utterance exceeded five minutes). Keep a
  # bounded default while retaining explicit overrides.
  default_intra_threads = min(os.cpu_count() or 1, 10)
  intra_op_threads = _thread_count(
    'MH_SUPERTONIC_INTRA_OP_THREADS',
    'SUPERTONIC_INTRA_OP_THREADS',
    default_intra_threads,
  )
  inter_op_threads = _thread_count(
    'MH_SUPERTONIC_INTER_OP_THREADS',
    'SUPERTONIC_INTER_OP_THREADS',
    1,
  )
  cache_dir = Path(
    os.getenv('SUPERTONIC_CACHE_DIR')
    or (Path.home() / '.cache' / 'supertonic3')
  ).expanduser()
  revision = (
    os.getenv('SUPERTONIC_MODEL_REVISION')
    or SUPERTONIC_MODEL_REVISION
  ).strip()
  language = normalize_supertonic_language_policy(
    os.getenv('MH_SUPERTONIC_LANGUAGE')
  )
  return SupertonicConfig(
    voice=voice,
    total_steps=total_steps,
    speed=speed,
    intra_op_threads=intra_op_threads,
    inter_op_threads=inter_op_threads,
    cache_dir=cache_dir,
    model_revision=revision,
    language=language,
  )


class SupertonicEngine:
  def __init__(
    self,
    *,
    config: Optional[SupertonicConfig] = None,
    tts_instance: Any | None = None,
  ) -> None:
    self.config = config or load_supertonic_config()
    os.environ['SUPERTONIC_CACHE_DIR'] = str(self.config.cache_dir)
    os.environ['SUPERTONIC_MODEL_REVISION'] = self.config.model_revision
    if tts_instance is None:
      try:
        tts_instance = self._load_offline_tts()
      except Exception:
        raise
    self._tts = tts_instance
    self._styles: dict[str, Any] = {}
    self._style(self.config.voice)

  @property
  def metadata(self) -> EngineMetadata:
    return EngineMetadata(
      voice=self.config.voice,
      engine='supertonic-3-onnx',
      model_path=str(self.config.cache_dir),
      voices_path=(
        f'voice:{self.config.voice};revision:{self.config.model_revision};'
        f'language:{self.config.language};'
        f'intra_threads:{self.config.intra_op_threads};'
        f'inter_threads:{self.config.inter_op_threads}'
      ),
    )

  def prepare_text(self, text: str, *, language_override: str | None = None) -> str:
    resolve_supertonic_language(
      text,
      language_override,
      self.config.language,
    )
    return text

  def synthesize_text(
    self,
    text: str,
    *,
    voice_override: str | None = None,
    language_override: str | None = None,
  ) -> Tuple[np.ndarray, int]:
    language = resolve_supertonic_language(
      text,
      language_override,
      self.config.language,
    )
    voice = (
      voice_override.strip()
      if isinstance(voice_override, str) and voice_override.strip()
      else self.config.voice
    )
    style = self._style(voice)
    wav, _duration = self._tts.synthesize(
      text=text,
      lang=language,
      voice_style=style,
      total_steps=self.config.total_steps,
      speed=self.config.speed,
      verbose=False,
    )
    audio = np.asarray(wav, dtype=np.float32).squeeze()
    if audio.ndim == 0:
      audio = np.asarray([float(audio)], dtype=np.float32)
    elif audio.ndim > 1:
      audio = np.mean(audio, axis=0).astype(np.float32, copy=False)
    sample_rate = int(getattr(self._tts, 'sample_rate', 44_100))
    return audio.astype(np.float32, copy=False), sample_rate

  def _load_offline_tts(self) -> Any:
    try:
      from supertonic import TTS
    except Exception as error:  # pragma: no cover - runtime environment
      raise RuntimeError(f'failed to import supertonic: {error}') from error
    try:
      return TTS(
        model='supertonic-3',
        auto_download=False,
        intra_op_num_threads=self.config.intra_op_threads,
        inter_op_num_threads=self.config.inter_op_threads,
      )
    except Exception as error:  # pragma: no cover - runtime environment
      raise RuntimeError(
        'failed to load offline Supertonic assets; '
        'run ./scripts/setup-supertonic.sh first: '
        f'{error}'
      ) from error

  def _style(self, voice: str) -> Any:
    if voice not in {f'{prefix}{index}' for prefix in ('M', 'F') for index in range(1, 6)}:
      raise ValueError(f'unsupported Supertonic voice: {voice}')
    if voice not in self._styles:
      self._styles[voice] = self._tts.get_voice_style(voice_name=voice)
    return self._styles[voice]
