from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import traceback
from dataclasses import dataclass
from typing import Any, Optional

from .kokoro_engine import KokoroEngine, resolve_model_paths
from .playback import PlaybackEngine, encode_wav_base64
from .protocol import ParsedCommand, ProtocolWriter, parse_command


AUDIO_TARGETS = {'local', 'browser', 'both'}


def resolve_audio_target(raw: Optional[str]) -> str:
  if raw is None:
    return 'local'
  normalized = raw.strip().lower()
  if normalized in AUDIO_TARGETS:
    return normalized
  raise ValueError(f'unsupported MH_AUDIO_TARGET: {raw} (expected local|browser|both)')


@dataclass
class SpeakRequest:
  request_id: Optional[str]
  generation: int
  session_id: str
  utterance_id: str
  text: str
  expires_at: int
  message_id: Optional[str]
  revision: Optional[int]


class WorkerRuntime:
  def __init__(self) -> None:
    self.writer = ProtocolWriter()
    self.model_paths = resolve_model_paths()
    self.engine = KokoroEngine(model_paths=self.model_paths, voice='af_heart')
    self.audio_target = resolve_audio_target(os.environ.get('MH_AUDIO_TARGET'))
    self.browser_audio_enabled = self.audio_target in ('browser', 'both')
    self.playback = PlaybackEngine(allow_local_output=self.audio_target in ('local', 'both'))

    self.latest_generation = -1
    self.current_task: Optional[asyncio.Task[None]] = None
    self.current_generation: Optional[int] = None
    self.current_session_id: Optional[str] = None
    self.current_utterance_id: Optional[str] = None
    self.shutdown_requested = False

  async def run(self) -> None:
    self.writer.ready(
      voice='af_heart',
      engine='kokoro-onnx+misaki',
      model_path=str(self.model_paths.model_path),
      voices_path=str(self.model_paths.voices_path),
      playback_backend=self.playback.backend,
      audio_target=self.audio_target,
    )

    queue: asyncio.Queue[ParsedCommand] = asyncio.Queue()
    reader_task = asyncio.create_task(self._stdin_reader(queue))

    try:
      while not self.shutdown_requested:
        command = await queue.get()
        await self._handle_command(command)
    finally:
      reader_task.cancel()
      if self.current_task and not self.current_task.done():
        self.current_task.cancel()
        self.playback.stop()
        try:
          await self.current_task
        except asyncio.CancelledError:
          pass
        except Exception:
          pass

  async def _stdin_reader(self, queue: asyncio.Queue[ParsedCommand]) -> None:
    loop = asyncio.get_running_loop()

    while True:
      line = await loop.run_in_executor(None, sys.stdin.readline)
      if line == '':
        await queue.put(ParsedCommand(raw={'op': 'shutdown'}, op='shutdown', request_id=None))
        return

      stripped = line.strip()
      if not stripped:
        continue

      try:
        command = parse_command(stripped)
      except json.JSONDecodeError as error:
        self.writer.error(message=f'invalid json command: {error.msg}')
        continue
      except Exception as error:
        self.writer.error(message=str(error))
        continue

      await queue.put(command)

  async def _handle_command(self, command: ParsedCommand) -> None:
    op = command.op

    if op == 'ping':
      self.writer.response(
        request_id=command.request_id,
        ok=True,
        result={
          'ready': True,
          'latest_generation': self.latest_generation,
        },
      )
      return

    if op == 'shutdown':
      self.shutdown_requested = True
      self.writer.response(request_id=command.request_id, ok=True, result={'shutdown': True})
      return

    if op == 'interrupt':
      reason = str(command.raw.get('reason') or 'interrupt_requested')
      await self._interrupt(reason=reason)
      self.writer.response(request_id=command.request_id, ok=True, result={'interrupted': True})
      return

    if op == 'speak':
      try:
        request = self._parse_speak_request(command)
      except Exception as error:
        self.writer.response(request_id=command.request_id, ok=False, error=str(error))
        self.writer.event(
          phase='error',
          generation=None,
          session_id=None,
          utterance_id=None,
          reason=str(error),
        )
        return

      await self._start_speak(request)
      self.writer.response(
        request_id=command.request_id,
        ok=True,
        result={'accepted': True, 'generation': request.generation},
      )
      return

    self.writer.response(request_id=command.request_id, ok=False, error=f'unknown op: {op}')

  def _parse_speak_request(self, command: ParsedCommand) -> SpeakRequest:
    raw = command.raw

    generation = raw.get('generation')
    if not isinstance(generation, int):
      raise ValueError('speak.generation must be integer')

    session_id = raw.get('session_id')
    if not isinstance(session_id, str) or session_id.strip() == '':
      raise ValueError('speak.session_id must be non-empty string')

    utterance_id = raw.get('utterance_id')
    if not isinstance(utterance_id, str) or utterance_id.strip() == '':
      raise ValueError('speak.utterance_id must be non-empty string')

    text = raw.get('text')
    if not isinstance(text, str) or text.strip() == '':
      raise ValueError('speak.text must be non-empty string')

    expires_at = raw.get('expires_at')
    if not isinstance(expires_at, int):
      ttl_ms = raw.get('ttl_ms')
      ts = raw.get('ts')
      if isinstance(ttl_ms, int) and isinstance(ts, int):
        expires_at = ts + ttl_ms
      else:
        expires_at = int(time.time() * 1000) + 4_000

    message_id_raw = raw.get('message_id')
    message_id = message_id_raw.strip() if isinstance(message_id_raw, str) and message_id_raw.strip() != '' else None

    revision_raw = raw.get('revision')
    revision: Optional[int]
    if isinstance(revision_raw, int):
      revision = revision_raw
    elif isinstance(revision_raw, float):
      revision = int(revision_raw)
    else:
      revision = None

    return SpeakRequest(
      request_id=command.request_id,
      generation=generation,
      session_id=session_id,
      utterance_id=utterance_id,
      text=text.strip(),
      expires_at=expires_at,
      message_id=message_id,
      revision=revision,
    )

  async def _start_speak(self, request: SpeakRequest) -> None:
    if request.generation < self.latest_generation:
      self.writer.event(
        phase='dropped',
        generation=request.generation,
        session_id=request.session_id,
        utterance_id=request.utterance_id,
        reason='stale_generation',
      )
      return

    self.latest_generation = request.generation

    if self.current_task and not self.current_task.done():
      self.current_task.cancel()
      self.playback.stop()
      try:
        await self.current_task
      except asyncio.CancelledError:
        pass
      except Exception:
        pass

    self.current_generation = request.generation
    self.current_session_id = request.session_id
    self.current_utterance_id = request.utterance_id
    self.current_task = asyncio.create_task(self._run_speak(request))

  async def _interrupt(self, reason: str) -> None:
    if self.current_task and not self.current_task.done():
      self.current_task.cancel()
      self.playback.stop()
      try:
        await self.current_task
      except asyncio.CancelledError:
        pass
      except Exception:
        pass

  async def _run_speak(self, request: SpeakRequest) -> None:
    generation = request.generation
    session_id = request.session_id
    utterance_id = request.utterance_id

    def is_stale() -> bool:
      return generation != self.latest_generation

    def is_expired() -> bool:
      return int(time.time() * 1000) > request.expires_at

    if is_expired():
      self.writer.event(
        phase='dropped',
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        reason='ttl_expired',
      )
      self._clear_current(generation)
      return

    self.writer.event(
      phase='synth_start',
      generation=generation,
      session_id=session_id,
      utterance_id=utterance_id,
    )

    try:
      audio, sample_rate = await asyncio.to_thread(self.engine.synthesize_text, request.text)
    except asyncio.CancelledError:
      self.playback.stop()
      self.writer.event(
        phase='play_stop',
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        reason='interrupted',
      )
      self.writer.mouth(
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        open_value=0.0,
      )
      raise
    except Exception as error:
      self.writer.event(
        phase='error',
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        reason=str(error),
      )
      self.writer.mouth(
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        open_value=0.0,
      )
      self._clear_current(generation)
      return

    if is_stale():
      self.writer.event(
        phase='dropped',
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        reason='stale_generation',
      )
      self.writer.mouth(
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        open_value=0.0,
      )
      self._clear_current(generation)
      return

    if is_expired():
      self.writer.event(
        phase='dropped',
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        reason='ttl_expired',
      )
      self.writer.mouth(
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        open_value=0.0,
      )
      self._clear_current(generation)
      return

    self.writer.event(
      phase='synth_done',
      generation=generation,
      session_id=session_id,
      utterance_id=utterance_id,
      extra={
        'sample_rate': sample_rate,
        'sample_count': int(audio.shape[0]),
      },
    )

    if self.browser_audio_enabled:
      try:
        audio_base64 = await asyncio.to_thread(encode_wav_base64, audio, sample_rate)
      except Exception as error:
        self.writer.event(
          phase='error',
          generation=generation,
          session_id=session_id,
          utterance_id=utterance_id,
          reason=f'browser_audio_encode_failed:{error}',
        )
        self.writer.mouth(
          generation=generation,
          session_id=session_id,
          utterance_id=utterance_id,
          open_value=0.0,
        )
        self._clear_current(generation)
        return

      if is_stale():
        self.writer.event(
          phase='dropped',
          generation=generation,
          session_id=session_id,
          utterance_id=utterance_id,
          reason='stale_generation',
        )
        self.writer.mouth(
          generation=generation,
          session_id=session_id,
          utterance_id=utterance_id,
          open_value=0.0,
        )
        self._clear_current(generation)
        return

      if is_expired():
        self.writer.event(
          phase='dropped',
          generation=generation,
          session_id=session_id,
          utterance_id=utterance_id,
          reason='ttl_expired',
        )
        self.writer.mouth(
          generation=generation,
          session_id=session_id,
          utterance_id=utterance_id,
          open_value=0.0,
        )
        self._clear_current(generation)
        return

      self.writer.audio(
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        mime_type='audio/wav',
        audio_base64=audio_base64,
        sample_rate=sample_rate,
        message_id=request.message_id,
        revision=request.revision,
      )

    self.writer.event(
      phase='play_start',
      generation=generation,
      session_id=session_id,
      utterance_id=utterance_id,
    )

    async def on_mouth(value: float) -> None:
      self.writer.mouth(
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        open_value=value,
      )

    try:
      reason = await self.playback.play(
        audio,
        sample_rate,
        on_mouth=on_mouth,
        should_stop=lambda: is_stale() or is_expired(),
      )
    except asyncio.CancelledError:
      self.playback.stop()
      reason = 'interrupted'
    except Exception as error:
      self.playback.stop()
      self.writer.event(
        phase='error',
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        reason=str(error),
      )
      self.writer.mouth(
        generation=generation,
        session_id=session_id,
        utterance_id=utterance_id,
        open_value=0.0,
      )
      self._clear_current(generation)
      return

    self.writer.event(
      phase='play_stop',
      generation=generation,
      session_id=session_id,
      utterance_id=utterance_id,
      reason=reason,
    )
    self.writer.mouth(
      generation=generation,
      session_id=session_id,
      utterance_id=utterance_id,
      open_value=0.0,
    )
    self._clear_current(generation)

  def _clear_current(self, generation: int) -> None:
    if self.current_generation != generation:
      return
    self.current_generation = None
    self.current_session_id = None
    self.current_utterance_id = None
    self.current_task = None


def parse_args(argv: list[str]) -> argparse.Namespace:
  parser = argparse.ArgumentParser(description='Minimum Headroom TTS worker')
  parser.add_argument('--smoke', action='store_true', help='Initialize engine and exit')
  return parser.parse_args(argv)


async def run_async(argv: list[str]) -> int:
  args = parse_args(argv)

  try:
    runtime = WorkerRuntime()
  except Exception as error:
    writer = ProtocolWriter()
    writer.error(message=f'startup failed: {error}')
    return 2

  if args.smoke:
    runtime.writer.ready(
      voice='af_heart',
      engine='kokoro-onnx+misaki',
      model_path=str(runtime.model_paths.model_path),
      voices_path=str(runtime.model_paths.voices_path),
      playback_backend=runtime.playback.backend,
      audio_target=runtime.audio_target,
    )
    return 0

  try:
    await runtime.run()
    return 0
  except Exception as error:
    writer = ProtocolWriter()
    writer.error(message=f'runtime failed: {error}')
    writer.error(message=traceback.format_exc())
    return 1


def main() -> int:
  return asyncio.run(run_async(sys.argv[1:]))


if __name__ == '__main__':
  raise SystemExit(main())
