from __future__ import annotations

import contextlib
import io
import os
import sys
from dataclasses import dataclass
from typing import Any, Optional, Tuple

import numpy as np

from .engine import EngineMetadata
from .qwen3_text import build_qwen3_instruction, normalize_ascii_mode, normalize_language, normalize_style, prepare_qwen3_text


@dataclass(frozen=True)
class Qwen3Config:
  model_id: str
  speaker: str
  language: str
  ascii_mode: str
  style: str
  device_map: str
  dtype_name: str
  gain: float
  speed: float


def load_qwen3_config() -> Qwen3Config:
  model_id = _env_or_default('MH_QWEN_TTS_MODEL', 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice')
  speaker = _env_or_default('MH_QWEN_TTS_SPEAKER', 'Serena')
  language = normalize_language(_env_or_default('MH_QWEN_TTS_LANGUAGE', 'English'))
  ascii_mode = normalize_ascii_mode(os.getenv('MH_QWEN_JA_ASCII_MODE'))
  style = normalize_style(os.getenv('MH_QWEN_TTS_STYLE'))
  device_map = _env_or_default('MH_QWEN_TTS_DEVICE_MAP', 'auto')
  dtype_name = _env_or_default('MH_QWEN_TTS_DTYPE', 'bfloat16')
  gain = _parse_gain(_env_or_default('MH_QWEN_TTS_GAIN', '1.50'))
  speed = _parse_speed(_env_or_default('MH_QWEN_TTS_SPEED', '1.0'))
  return Qwen3Config(
    model_id=model_id,
    speaker=speaker,
    language=language,
    ascii_mode=ascii_mode,
    style=style,
    device_map=device_map,
    dtype_name=dtype_name,
    gain=gain,
    speed=speed,
  )


class Qwen3TtsEngine:
  def __init__(self, *, config: Optional[Qwen3Config] = None) -> None:
    self.config = config or load_qwen3_config()
    self._model = None
    self._model_cls = None
    self._torch = None
    self._librosa = None
    self._verify_runtime_imports()

  @property
  def metadata(self) -> EngineMetadata:
    return EngineMetadata(
      voice=self.config.speaker,
      engine='qwen3-tts-0.6b-customvoice',
      model_path=self.config.model_id,
      voices_path=(
        f'speaker:{self.config.speaker};language:{self.config.language};'
        f'style:{self.config.style};ascii:{self.config.ascii_mode};'
        f'gain:{self.config.gain:g};speed:{self.config.speed:g}'
      ),
    )

  def prepare_text(self, text: str) -> str:
    return prepare_qwen3_text(text, ascii_mode=self.config.ascii_mode, language=self.config.language)

  def synthesize_text(self, text: str, *, voice_override: str | None = None) -> Tuple[np.ndarray, int]:
    model = self._ensure_model()
    instruction = build_qwen3_instruction(self.config.style, language=self.config.language)
    speaker = voice_override.strip() if isinstance(voice_override, str) and voice_override.strip() != '' else self.config.speaker
    wavs, sample_rate = model.generate_custom_voice(
      text=text,
      language=self.config.language,
      speaker=speaker,
      instruct=instruction,
    )
    audio = _normalize_qwen_audio(wavs)
    audio = self._apply_qwen_speed(audio)
    audio = _apply_qwen_gain(audio, gain=self.config.gain)
    return audio, int(sample_rate)

  def _ensure_model(self) -> Any:
    if self._model is not None:
      return self._model

    torch = self._torch
    model_cls = self._model_cls
    if torch is None or model_cls is None:
      raise RuntimeError('qwen3 runtime imports were not initialized')

    dtype = getattr(torch, self.config.dtype_name, None)
    if dtype is None:
      raise RuntimeError(
        f'unsupported MH_QWEN_TTS_DTYPE: {self.config.dtype_name} (expected a torch dtype such as bfloat16 or float16)'
      )

    try:
      self._model = model_cls.from_pretrained(
        self.config.model_id,
        device_map=self.config.device_map,
        dtype=dtype,
      )
    except Exception as error:  # pragma: no cover - depends on runtime env
      raise RuntimeError(f'failed to load qwen3 model {self.config.model_id}: {error}') from error
    return self._model

  def _verify_runtime_imports(self) -> None:
    if self._torch is not None and self._model_cls is not None:
      return

    try:
      import torch
    except Exception as error:  # pragma: no cover - depends on runtime env
      raise RuntimeError(f'failed to import torch for qwen3 tts: {error}') from error

    capture = io.StringIO()
    try:
      with contextlib.redirect_stdout(capture):
        from qwen_tts import Qwen3TTSModel  # type: ignore
    except Exception as error:  # pragma: no cover - depends on runtime env
      raise RuntimeError(f'failed to import qwen_tts: {error}') from error

    echoed = capture.getvalue().strip()
    if echoed:
      print(echoed, file=sys.stderr)

    self._torch = torch
    self._model_cls = Qwen3TTSModel

  def _apply_qwen_speed(self, audio: np.ndarray) -> np.ndarray:
    if audio.size == 0 or abs(self.config.speed - 1.0) < 1e-6:
      return audio.astype(np.float32, copy=False)
    librosa = self._ensure_librosa()
    stretched = librosa.effects.time_stretch(audio.astype(np.float32, copy=False), rate=float(self.config.speed))
    return np.asarray(stretched, dtype=np.float32)

  def _ensure_librosa(self):
    if self._librosa is not None:
      return self._librosa
    try:
      import librosa  # type: ignore
    except Exception as error:  # pragma: no cover - depends on runtime env
      raise RuntimeError(f'failed to import librosa for qwen3 speed control: {error}') from error
    self._librosa = librosa
    return self._librosa


def _env_or_default(name: str, fallback: str) -> str:
  value = os.getenv(name)
  if value is None:
    return fallback
  trimmed = value.strip()
  if trimmed == '':
    return fallback
  return trimmed


def _parse_gain(raw: str) -> float:
  try:
    gain = float(raw)
  except ValueError as error:
    raise RuntimeError(f'unsupported MH_QWEN_TTS_GAIN: {raw} (expected a float such as 1.0 or 1.15)') from error
  if gain <= 0.0 or gain > 3.0:
    raise RuntimeError(f'unsupported MH_QWEN_TTS_GAIN: {raw} (expected a value between 0 and 3.0)')
  return gain


def _parse_speed(raw: str) -> float:
  try:
    speed = float(raw)
  except ValueError as error:
    raise RuntimeError(f'unsupported MH_QWEN_TTS_SPEED: {raw} (expected a float such as 1.0 or 1.1)') from error
  if speed <= 0.5 or speed > 2.0:
    raise RuntimeError(f'unsupported MH_QWEN_TTS_SPEED: {raw} (expected a value between 0.5 and 2.0)')
  return speed


def _normalize_qwen_audio(wavs: Any) -> np.ndarray:
  if isinstance(wavs, np.ndarray):
    return _as_float_audio(wavs)

  if isinstance(wavs, (list, tuple)):
    if not wavs:
      return np.zeros(1, dtype=np.float32)
    first = wavs[0]
    if isinstance(first, np.ndarray):
      return _as_float_audio(first)
    if hasattr(first, 'detach'):
      detached = first.detach()
      if hasattr(detached, 'cpu'):
        detached = detached.cpu()
      if hasattr(detached, 'numpy'):
        return _as_float_audio(detached.numpy())
    return _as_float_audio(np.asarray(first, dtype=np.float32))

  if hasattr(wavs, 'detach'):
    detached = wavs.detach()
    if hasattr(detached, 'cpu'):
      detached = detached.cpu()
    if hasattr(detached, 'numpy'):
      return _as_float_audio(detached.numpy())

  return _as_float_audio(np.asarray(wavs, dtype=np.float32))


def _apply_qwen_gain(audio: np.ndarray, *, gain: float) -> np.ndarray:
  rendered = audio.astype(np.float32, copy=False)
  if gain == 1.0 or rendered.size == 0:
    return rendered
  boosted = rendered * np.float32(gain)
  peak = float(np.max(np.abs(boosted)))
  if peak <= 1.0:
    return boosted
  # Preserve a little headroom instead of hard clipping when the gain pushes peaks over unity.
  return boosted * np.float32(0.98 / peak)


def _as_float_audio(audio: np.ndarray) -> np.ndarray:
  if audio.ndim == 0:
    return np.asarray([float(audio)], dtype=np.float32)
  if audio.ndim == 1:
    return audio.astype(np.float32, copy=False)
  return np.mean(audio, axis=-1).astype(np.float32, copy=False)
