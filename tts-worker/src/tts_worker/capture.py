"""Capture-on-anomaly diagnostics for synthesized TTS audio.

The TTS path very occasionally emits an utterance that sounds like a
noise-filled walkie-talkie (broadband hiss with a faint voice underneath),
then recovers on the next utterance. The waveform is a structurally valid
WAV, so downstream WAV validation does not reject it; the corruption lives in
the synthesized PCM itself. Because the failure is intermittent and not
reproducible on demand, this module lets the worker keep a forensic sample
whenever the freshly synthesized audio looks noise-like.

Design constraints:
- Capture only. It must never alter what gets played or sent to the browser.
- It must never break TTS: every public entry point swallows its own errors.
- Off by default (writes nothing) so the public build is unsurprising; a
  single env flag turns it on for a debugging session.
- Transcript text and request identifiers require separate opt-in flags even
  when waveform capture itself is enabled.
"""

from __future__ import annotations

import json
import os
import sys
import time
import wave
from pathlib import Path
from typing import Any, Optional

import numpy as np


CAPTURE_FILENAME_PREFIX = 'tts-anomaly'


def _env_flag(name: str, default: bool = False) -> bool:
  raw = os.environ.get(name)
  if raw is None:
    return default
  return raw.strip().lower() in ('1', 'true', 'yes', 'on')


def _env_float(name: str, default: float) -> float:
  raw = os.environ.get(name)
  if raw is None or raw.strip() == '':
    return default
  try:
    return float(raw)
  except ValueError:
    return default


def _env_int(name: str, default: int) -> int:
  raw = os.environ.get(name)
  if raw is None or raw.strip() == '':
    return default
  try:
    return int(raw)
  except ValueError:
    return default


def _default_capture_dir() -> Path:
  return Path.home() / '.cache' / 'minimum-headroom' / 'tts-captures'


def audio_anomaly_metrics(audio: Any, sample_rate: int) -> dict[str, float]:
  """Compute cheap noise-likeness metrics over a synthesized waveform.

  Returns a JSON-serializable dict. Never raises for ordinary inputs; an
  empty or all-non-finite buffer yields zeroed metrics.
  """

  arr = np.asarray(audio, dtype=np.float32).reshape(-1)
  count = int(arr.shape[0])
  rate = int(sample_rate) if sample_rate else 0
  metrics: dict[str, float] = {
    'sample_count': float(count),
    'sample_rate': float(rate),
    'duration_s': (count / float(rate)) if rate else 0.0,
    'rms': 0.0,
    'peak': 0.0,
    'zcr': 0.0,
    'nonfinite': 0.0,
    'clip_fraction': 0.0,
  }

  if count == 0:
    return metrics

  finite_mask = np.isfinite(arr)
  nonfinite = int(count - int(np.count_nonzero(finite_mask)))
  metrics['nonfinite'] = float(nonfinite)

  finite = arr[finite_mask]
  if finite.size == 0:
    return metrics

  metrics['rms'] = float(np.sqrt(np.mean(np.square(finite, dtype=np.float64))))
  metrics['peak'] = float(np.max(np.abs(finite)))

  if finite.size > 1:
    signs = np.signbit(finite)
    crossings = int(np.count_nonzero(signs[1:] != signs[:-1]))
    metrics['zcr'] = float(crossings) / float(finite.size - 1)

  metrics['clip_fraction'] = float(np.count_nonzero(np.abs(finite) >= 0.999)) / float(finite.size)
  return metrics


def classify_anomaly(
  metrics: dict[str, float],
  *,
  rms_floor: float,
  zcr_threshold: float,
  clip_fraction: float,
) -> Optional[str]:
  """Return a short reason string if the metrics look noise-like, else None.

  Three independent triggers:
  - ``nonfinite``: any NaN/inf sample is unconditionally suspect.
  - ``broadband_noise``: enough energy AND a high zero-crossing rate. Voiced
    speech sits well below ~0.35 ZCR; broadband hiss approaches 0.5.
  - ``clipping``: a large fraction of near-full-scale samples, the signature
    of folded/wrapped PCM.
  """

  if metrics.get('nonfinite', 0.0) > 0.0:
    return 'nonfinite'

  rms = metrics.get('rms', 0.0)
  zcr = metrics.get('zcr', 0.0)
  if rms >= rms_floor and zcr >= zcr_threshold:
    return 'broadband_noise'

  if metrics.get('clip_fraction', 0.0) >= clip_fraction:
    return 'clipping'

  return None


def _to_int16_pcm_bytes(audio: np.ndarray) -> bytes:
  clipped = np.clip(np.asarray(audio, dtype=np.float32), -1.0, 1.0)
  return (clipped * 32767.0).astype(np.int16).tobytes()


class AnomalyCapture:
  """Owns capture config and a per-process capture budget.

  Construct once (``from_env``) and call ``maybe_capture`` after each
  synthesis. The instance is shared across utterances so the ``max_captures``
  budget bounds total disk writes for a debugging session.
  """

  def __init__(
    self,
    *,
    enabled: bool,
    directory: Path,
    rms_floor: float,
    zcr_threshold: float,
    clip_fraction: float,
    max_captures: int,
    include_text: bool = False,
    include_context: bool = False,
  ) -> None:
    self.enabled = bool(enabled)
    self.directory = Path(directory)
    self.rms_floor = float(rms_floor)
    self.zcr_threshold = float(zcr_threshold)
    self.clip_fraction = float(clip_fraction)
    self.max_captures = int(max_captures)
    self.include_text = bool(include_text)
    self.include_context = bool(include_context)
    self.captured = 0

  @classmethod
  def from_env(cls) -> 'AnomalyCapture':
    directory_raw = os.environ.get('MH_TTS_CAPTURE_DIR', '').strip()
    directory = Path(directory_raw) if directory_raw else _default_capture_dir()
    return cls(
      enabled=_env_flag('MH_TTS_CAPTURE_ANOMALY', False),
      directory=directory,
      rms_floor=_env_float('MH_TTS_CAPTURE_RMS_FLOOR', 0.02),
      zcr_threshold=_env_float('MH_TTS_CAPTURE_ZCR_THRESHOLD', 0.35),
      clip_fraction=_env_float('MH_TTS_CAPTURE_CLIP_FRACTION', 0.2),
      max_captures=_env_int('MH_TTS_CAPTURE_MAX', 20),
      include_text=_env_flag('MH_TTS_CAPTURE_INCLUDE_TEXT', False),
      include_context=_env_flag('MH_TTS_CAPTURE_INCLUDE_CONTEXT', False),
    )

  def maybe_capture(
    self,
    *,
    text: str,
    prepared_text: str,
    audio: Any,
    sample_rate: int,
    context: Optional[dict[str, Any]] = None,
  ) -> Optional[str]:
    """Save a forensic WAV + JSON sidecar iff the audio looks noise-like.

    Returns the saved WAV path (str) on capture, else None. Wrapped so a
    capture failure can never propagate into the speak path.
    """

    if not self.enabled:
      return None

    try:
      if self.captured >= self.max_captures:
        return None

      metrics = audio_anomaly_metrics(audio, sample_rate)
      reason = classify_anomaly(
        metrics,
        rms_floor=self.rms_floor,
        zcr_threshold=self.zcr_threshold,
        clip_fraction=self.clip_fraction,
      )
      if reason is None:
        return None

      self.directory.mkdir(parents=True, exist_ok=True)

      now = time.time()
      stamp = time.strftime('%Y%m%d-%H%M%S', time.localtime(now)) + f'-{int((now % 1) * 1000):03d}'
      utterance_id = ''
      if self.include_context and context:
        utterance_id = str(context.get('utterance_id') or '')
      suffix = ('-' + utterance_id.replace('/', '_')[:8]) if utterance_id else ''
      base = f'{CAPTURE_FILENAME_PREFIX}-{stamp}{suffix}'
      wav_path = self.directory / f'{base}.wav'
      json_path = self.directory / f'{base}.json'

      pcm = _to_int16_pcm_bytes(np.asarray(audio, dtype=np.float32).reshape(-1))
      with wave.open(str(wav_path), 'wb') as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(int(sample_rate) if sample_rate else 24000)
        wav_file.writeframes(pcm)

      sidecar = {
        'reason': reason,
        'captured_at': stamp,
        'metrics': metrics,
        'thresholds': {
          'rms_floor': self.rms_floor,
          'zcr_threshold': self.zcr_threshold,
          'clip_fraction': self.clip_fraction,
        },
        'wav_file': wav_path.name,
      }
      if self.include_text:
        sidecar['text'] = text
        sidecar['prepared_text'] = prepared_text
      if self.include_context:
        sidecar['context'] = context or {}
      json_path.write_text(json.dumps(sidecar, ensure_ascii=False, indent=2), encoding='utf-8')

      self.captured += 1
      print(
        f'[tts-capture] saved anomaly ({reason}) #{self.captured} -> {wav_path} '
        f"rms={metrics['rms']:.4f} zcr={metrics['zcr']:.3f} "
        f"clip={metrics['clip_fraction']:.3f} nonfinite={int(metrics['nonfinite'])}",
        file=sys.stderr,
        flush=True,
      )
      return str(wav_path)
    except Exception as error:  # pragma: no cover - defensive; never break TTS
      try:
        print(f'[tts-capture] capture failed: {error}', file=sys.stderr, flush=True)
      except Exception:
        pass
      return None
