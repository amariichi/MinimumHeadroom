from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np


ROOT_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT_DIR / 'tts-worker' / 'src'
if str(SRC_DIR) not in sys.path:
  sys.path.insert(0, str(SRC_DIR))

from tts_worker.capture import (
  AnomalyCapture,
  audio_anomaly_metrics,
  classify_anomaly,
)


SAMPLE_RATE = 24000
THRESHOLDS = dict(rms_floor=0.02, zcr_threshold=0.35, clip_fraction=0.2)


def _clean_tone(seconds: float = 0.5, freq: float = 160.0) -> np.ndarray:
  # A low-frequency tone is a stand-in for voiced speech: real energy but a
  # very low zero-crossing rate, which must NOT be flagged as noise.
  t = np.arange(int(SAMPLE_RATE * seconds), dtype=np.float32) / SAMPLE_RATE
  return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _broadband_noise(seconds: float = 0.5, amplitude: float = 0.4, seed: int = 7) -> np.ndarray:
  rng = np.random.default_rng(seed)
  return (amplitude * rng.standard_normal(int(SAMPLE_RATE * seconds))).astype(np.float32)


class AnomalyMetricsTests(unittest.TestCase):
  def test_clean_tone_has_low_zcr_and_real_energy(self) -> None:
    metrics = audio_anomaly_metrics(_clean_tone(), SAMPLE_RATE)
    self.assertLess(metrics['zcr'], 0.05)
    self.assertGreater(metrics['rms'], 0.0)
    self.assertEqual(metrics['nonfinite'], 0.0)

  def test_broadband_noise_has_high_zcr(self) -> None:
    metrics = audio_anomaly_metrics(_broadband_noise(), SAMPLE_RATE)
    self.assertGreater(metrics['zcr'], 0.35)
    self.assertGreater(metrics['rms'], 0.02)

  def test_empty_buffer_is_zeroed(self) -> None:
    metrics = audio_anomaly_metrics(np.zeros(0, dtype=np.float32), SAMPLE_RATE)
    self.assertEqual(metrics['sample_count'], 0.0)
    self.assertEqual(metrics['rms'], 0.0)
    self.assertEqual(metrics['zcr'], 0.0)

  def test_counts_nonfinite_samples(self) -> None:
    arr = np.array([0.1, np.nan, np.inf, -0.2], dtype=np.float32)
    metrics = audio_anomaly_metrics(arr, SAMPLE_RATE)
    self.assertEqual(metrics['nonfinite'], 2.0)


class ClassifyAnomalyTests(unittest.TestCase):
  def test_clean_tone_is_not_flagged(self) -> None:
    metrics = audio_anomaly_metrics(_clean_tone(), SAMPLE_RATE)
    self.assertIsNone(classify_anomaly(metrics, **THRESHOLDS))

  def test_broadband_noise_is_flagged(self) -> None:
    metrics = audio_anomaly_metrics(_broadband_noise(), SAMPLE_RATE)
    self.assertEqual(classify_anomaly(metrics, **THRESHOLDS), 'broadband_noise')

  def test_nonfinite_is_flagged(self) -> None:
    metrics = audio_anomaly_metrics(np.array([np.nan, 0.1], dtype=np.float32), SAMPLE_RATE)
    self.assertEqual(classify_anomaly(metrics, **THRESHOLDS), 'nonfinite')

  def test_full_scale_dc_is_flagged_as_clipping(self) -> None:
    # All-ones: zero crossings (so not broadband), but every sample is clipped.
    metrics = audio_anomaly_metrics(np.ones(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE)
    self.assertEqual(classify_anomaly(metrics, **THRESHOLDS), 'clipping')

  def test_quiet_noise_below_rms_floor_is_ignored(self) -> None:
    # High ZCR but negligible energy must not trip the broadband trigger.
    metrics = audio_anomaly_metrics(_broadband_noise(amplitude=0.001), SAMPLE_RATE)
    self.assertIsNone(classify_anomaly(metrics, **THRESHOLDS))


class CaptureWriteTests(unittest.TestCase):
  def _capture(self, directory: Path, **overrides) -> AnomalyCapture:
    cfg = dict(enabled=True, directory=directory, max_captures=20, **THRESHOLDS)
    cfg.update(overrides)
    return AnomalyCapture(**cfg)

  def test_disabled_writes_nothing(self) -> None:
    with tempfile.TemporaryDirectory() as d:
      cap = self._capture(Path(d), enabled=False)
      out = cap.maybe_capture(text='hi', prepared_text='hi', audio=_broadband_noise(), sample_rate=SAMPLE_RATE)
      self.assertIsNone(out)
      self.assertEqual(list(Path(d).glob('*')), [])

  def test_clean_audio_is_not_captured(self) -> None:
    with tempfile.TemporaryDirectory() as d:
      cap = self._capture(Path(d))
      out = cap.maybe_capture(text='hi', prepared_text='hi', audio=_clean_tone(), sample_rate=SAMPLE_RATE)
      self.assertIsNone(out)
      self.assertEqual(cap.captured, 0)

  def test_noisy_audio_is_captured_with_sidecar(self) -> None:
    with tempfile.TemporaryDirectory() as d:
      cap = self._capture(Path(d))
      out = cap.maybe_capture(
        text='ノイズまみれ',
        prepared_text='のいずまみれ',
        audio=_broadband_noise(),
        sample_rate=SAMPLE_RATE,
        context={'utterance_id': 'abc123def456', 'session_id': 's1'},
      )
      self.assertIsNotNone(out)
      wav_path = Path(out)
      self.assertTrue(wav_path.exists())
      self.assertGreater(wav_path.stat().st_size, 44)  # WAV header + data

      sidecar = wav_path.with_suffix('.json')
      self.assertTrue(sidecar.exists())
      data = json.loads(sidecar.read_text(encoding='utf-8'))
      self.assertEqual(data['reason'], 'broadband_noise')
      self.assertNotIn('text', data)
      self.assertNotIn('prepared_text', data)
      self.assertNotIn('context', data)
      self.assertNotIn('abc123de', wav_path.name)
      self.assertIn('rms', data['metrics'])
      self.assertEqual(cap.captured, 1)

  def test_text_and_request_context_require_separate_opt_in(self) -> None:
    with tempfile.TemporaryDirectory() as d:
      cap = self._capture(
        Path(d),
        include_text=True,
        include_context=True,
      )
      out = cap.maybe_capture(
        text='ノイズまみれ',
        prepared_text='のいずまみれ',
        audio=_broadband_noise(),
        sample_rate=SAMPLE_RATE,
        context={'utterance_id': 'abc123def456', 'session_id': 's1'},
      )
      self.assertIsNotNone(out)
      wav_path = Path(out)
      data = json.loads(wav_path.with_suffix('.json').read_text(encoding='utf-8'))
      self.assertEqual(data['text'], 'ノイズまみれ')
      self.assertEqual(data['prepared_text'], 'のいずまみれ')
      self.assertEqual(data['context']['utterance_id'], 'abc123def456')
      self.assertIn('abc123de', wav_path.name)

  def test_respects_max_captures_budget(self) -> None:
    with tempfile.TemporaryDirectory() as d:
      cap = self._capture(Path(d), max_captures=1)
      first = cap.maybe_capture(text='1', prepared_text='1', audio=_broadband_noise(seed=1), sample_rate=SAMPLE_RATE)
      second = cap.maybe_capture(text='2', prepared_text='2', audio=_broadband_noise(seed=2), sample_rate=SAMPLE_RATE)
      self.assertIsNotNone(first)
      self.assertIsNone(second)
      self.assertEqual(cap.captured, 1)


class FromEnvTests(unittest.TestCase):
  def test_default_is_disabled(self) -> None:
    saved = os.environ.pop('MH_TTS_CAPTURE_ANOMALY', None)
    try:
      self.assertFalse(AnomalyCapture.from_env().enabled)
    finally:
      if saved is not None:
        os.environ['MH_TTS_CAPTURE_ANOMALY'] = saved

  def test_capture_metadata_defaults_are_private(self) -> None:
    with patch.dict(os.environ, {'MH_TTS_CAPTURE_ANOMALY': '1'}, clear=True):
      capture = AnomalyCapture.from_env()
    self.assertTrue(capture.enabled)
    self.assertFalse(capture.include_text)
    self.assertFalse(capture.include_context)


if __name__ == '__main__':
  unittest.main()
