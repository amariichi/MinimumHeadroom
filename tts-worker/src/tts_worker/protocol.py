from __future__ import annotations

import json
import sys
import threading
from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class ParsedCommand:
  raw: Dict[str, Any]
  op: str
  request_id: Optional[str]


class ProtocolWriter:
  def __init__(self) -> None:
    self._lock = threading.Lock()

  def send(self, payload: Dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False)
    with self._lock:
      sys.stdout.write(line)
      sys.stdout.write('\n')
      sys.stdout.flush()

  def ready(
    self,
    *,
    voice: str,
    engine: str,
    model_path: str,
    voices_path: str,
    playback_backend: Optional[str] = None,
    audio_target: Optional[str] = None,
  ) -> None:
    payload = {
      'type': 'ready',
      'voice': voice,
      'engine': engine,
      'model_path': model_path,
      'voices_path': voices_path,
    }
    if playback_backend is not None:
      payload['playback_backend'] = playback_backend
    if audio_target is not None:
      payload['audio_target'] = audio_target
    self.send(payload)

  def response(self, *, request_id: Optional[str], ok: bool, result: Optional[Dict[str, Any]] = None, error: Optional[str] = None) -> None:
    payload = {
      'type': 'response',
      'id': request_id,
      'ok': ok,
    }
    if result is not None:
      payload['result'] = result
    if error is not None:
      payload['error'] = error
    self.send(payload)

  def event(
    self,
    *,
    phase: str,
    generation: Optional[int],
    session_id: Optional[str],
    utterance_id: Optional[str],
    reason: Optional[str] = None,
    extra: Optional[Dict[str, Any]] = None,
  ) -> None:
    payload: Dict[str, Any] = {
      'type': 'event',
      'phase': phase,
      'generation': generation,
      'session_id': session_id,
      'utterance_id': utterance_id,
    }
    if reason is not None:
      payload['reason'] = reason
    if extra:
      payload.update(extra)
    self.send(payload)

  def mouth(self, *, generation: Optional[int], session_id: Optional[str], utterance_id: Optional[str], open_value: float) -> None:
    self.send(
      {
        'type': 'mouth',
        'generation': generation,
        'session_id': session_id,
        'utterance_id': utterance_id,
        'open': max(0.0, min(1.0, float(open_value))),
      }
    )

  def audio(
    self,
    *,
    generation: Optional[int],
    session_id: Optional[str],
    utterance_id: Optional[str],
    mime_type: str,
    audio_base64: str,
    sample_rate: int,
    message_id: Optional[str] = None,
    revision: Optional[int] = None,
  ) -> None:
    payload: Dict[str, Any] = {
      'type': 'audio',
      'generation': generation,
      'session_id': session_id,
      'utterance_id': utterance_id,
      'mime_type': mime_type,
      'audio_base64': audio_base64,
      'sample_rate': sample_rate,
    }
    if message_id is not None:
      payload['message_id'] = message_id
    if revision is not None:
      payload['revision'] = revision
    self.send(payload)

  def error(self, *, message: str, op: Optional[str] = None, request_id: Optional[str] = None) -> None:
    payload: Dict[str, Any] = {
      'type': 'error',
      'message': message,
      'op': op,
      'id': request_id,
    }
    self.send(payload)


def parse_command(line: str) -> ParsedCommand:
  raw = json.loads(line)
  if not isinstance(raw, dict):
    raise ValueError('command must be a JSON object')

  op = raw.get('op')
  if not isinstance(op, str) or op.strip() == '':
    raise ValueError('command op must be a non-empty string')

  request_id = raw.get('id')
  if request_id is not None and not isinstance(request_id, str):
    raise ValueError('command id must be a string when provided')

  return ParsedCommand(raw=raw, op=op.strip(), request_id=request_id)
