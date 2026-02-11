from __future__ import annotations

import asyncio
import math
import shutil
import subprocess
import time
from typing import Awaitable, Callable

import numpy as np


MouthCallback = Callable[[float], Awaitable[None] | None]
ShouldStop = Callable[[], bool]


class PlaybackEngine:
  def __init__(self) -> None:
    try:
      import sounddevice as sd  # type: ignore
    except Exception:  # pragma: no cover - runtime dependent
      sd = None

    self._sd = sd
    self._aplay_path = shutil.which('aplay')
    self._aplay_proc: subprocess.Popen | None = None

    if sd is not None:
      self.backend = 'sounddevice'
    elif self._aplay_path:
      self.backend = 'aplay'
    else:
      self.backend = 'silent'

    self.has_audio_output = self.backend in ('sounddevice', 'aplay')

  def stop(self) -> None:
    if self._sd is not None:
      try:
        self._sd.stop()
      except Exception:
        # Ignore stop failures to keep future utterances possible.
        pass

    proc = self._aplay_proc
    if proc and proc.poll() is None:
      try:
        proc.terminate()
      except Exception:
        pass

      try:
        proc.wait(timeout=0.5)
      except Exception:
        try:
          proc.kill()
        except Exception:
          pass

    self._aplay_proc = None

  async def play(
    self,
    samples: np.ndarray,
    sample_rate: int,
    on_mouth: MouthCallback,
    should_stop: ShouldStop,
  ) -> str:
    if samples.size == 0:
      await _emit_mouth(on_mouth, 0.0)
      return 'completed'

    audio = np.asarray(samples, dtype=np.float32)
    duration = max(0.0, float(audio.shape[0]) / float(sample_rate))
    aplay_feed_task: asyncio.Task[None] | None = None

    if self.backend == 'sounddevice' and self._sd is not None:
      self._sd.play(audio, sample_rate, blocking=False)
    elif self.backend == 'aplay' and self._aplay_path:
      pcm = _to_int16_pcm_bytes(audio)
      proc = subprocess.Popen(
        [self._aplay_path, '-f', 'S16_LE', '-r', str(sample_rate), '-c', '1', '-q'],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
      )
      self._aplay_proc = proc
      aplay_feed_task = asyncio.create_task(asyncio.to_thread(_feed_aplay_pcm, proc, pcm))

    started = time.monotonic()

    while True:
      if should_stop():
        self.stop()
        await _emit_mouth(on_mouth, 0.0)
        return 'interrupted'

      elapsed = time.monotonic() - started
      if elapsed >= duration:
        break

      mouth_open = _estimate_mouth_open(audio, sample_rate, elapsed)
      await _emit_mouth(on_mouth, mouth_open)
      await asyncio.sleep(0.04)

    if self.backend == 'sounddevice' and self._sd is not None:
      try:
        await asyncio.to_thread(self._sd.wait)
      except Exception:
        pass
    elif self.backend == 'aplay':
      proc = self._aplay_proc
      if aplay_feed_task is not None:
        try:
          await aplay_feed_task
        except Exception:
          pass
      if proc is not None:
        try:
          await asyncio.to_thread(proc.wait)
        except Exception:
          pass
      self._aplay_proc = None

    await _emit_mouth(on_mouth, 0.0)
    return 'completed'


def _estimate_mouth_open(samples: np.ndarray, sample_rate: int, elapsed_s: float) -> float:
  center = int(max(0.0, elapsed_s) * sample_rate)
  half_window = max(1, sample_rate // 80)
  start = max(0, center - half_window)
  end = min(samples.shape[0], center + half_window)

  if end <= start:
    return 0.0

  window = samples[start:end]
  rms = float(np.sqrt(np.mean(np.square(window, dtype=np.float32))))
  return max(0.0, min(1.0, math.pow(rms * 3.8, 0.75)))


async def _emit_mouth(callback: MouthCallback, value: float) -> None:
  result = callback(value)
  if asyncio.iscoroutine(result):
    await result


def _to_int16_pcm_bytes(audio: np.ndarray) -> bytes:
  clipped = np.clip(audio, -1.0, 1.0)
  int16_audio = (clipped * 32767.0).astype(np.int16)
  return int16_audio.tobytes()


def _feed_aplay_pcm(proc: subprocess.Popen, pcm_bytes: bytes) -> None:
  if proc.stdin is None:
    return

  try:
    proc.stdin.write(pcm_bytes)
  except Exception:
    pass
  finally:
    try:
      proc.stdin.close()
    except Exception:
      pass
