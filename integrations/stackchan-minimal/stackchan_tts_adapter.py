#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.parse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class TtsRequest:
  text: str
  voice: str | None = None


def parse_content_type(header: str | None) -> str:
  if not header:
    return 'application/octet-stream'
  return header.split(';', 1)[0].strip().lower()


def first_value(values: dict[str, list[str]], key: str) -> str | None:
  items = values.get(key)
  if not items:
    return None
  return items[0]


def extract_text_from_payload(payload: Any) -> str | None:
  if isinstance(payload, dict):
    for key in ('text', 'input', 'sentence', 'query', 'message'):
      value = payload.get(key)
      if isinstance(value, str) and value.strip():
        return value
    if isinstance(payload.get('audio_query'), dict):
      return extract_text_from_payload(payload['audio_query'])
  return None


def parse_tts_request(body: bytes, content_type: str | None, query: dict[str, list[str]]) -> TtsRequest:
  text = first_value(query, 'text') or first_value(query, 'input') or first_value(query, 'sentence')
  voice = first_value(query, 'voice') or first_value(query, 'speaker') or first_value(query, 'character')
  media_type = parse_content_type(content_type)

  if text:
    return TtsRequest(text=text.strip(), voice=voice)

  if media_type == 'application/json':
    payload = json.loads(body.decode('utf-8') if body else '{}')
    text = extract_text_from_payload(payload)
    if isinstance(payload, dict):
      voice = voice or string_or_none(payload.get('voice')) or string_or_none(payload.get('speaker'))
    if text:
      return TtsRequest(text=text.strip(), voice=voice)

  if media_type == 'application/x-www-form-urlencoded':
    values = urllib.parse.parse_qs(body.decode('utf-8'), keep_blank_values=True)
    text = first_value(values, 'text') or first_value(values, 'input') or first_value(values, 'sentence')
    voice = voice or first_value(values, 'voice') or first_value(values, 'speaker')
    if text:
      return TtsRequest(text=text.strip(), voice=voice)

  raw = body.decode('utf-8', errors='ignore').strip()
  if raw:
    return TtsRequest(text=raw, voice=voice)

  raise ValueError('TTS request does not include text')


def string_or_none(value: Any) -> str | None:
  if isinstance(value, str) and value.strip():
    return value.strip()
  if isinstance(value, int):
    return str(value)
  return None


class KokoroSynthesizer:
  def __init__(self, repo_root: Path, default_voice: str) -> None:
    self.repo_root = repo_root
    self.default_voice = default_voice
    self._engine = None

  def _load(self) -> Any:
    if self._engine is not None:
      return self._engine

    tts_src = self.repo_root / 'tts-worker' / 'src'
    if str(tts_src) not in sys.path:
      sys.path.insert(0, str(tts_src))

    os.environ.setdefault('MH_KOKORO_MODEL', str(self.repo_root / 'assets' / 'kokoro' / 'kokoro-v1.0.onnx'))
    os.environ.setdefault('MH_KOKORO_VOICES', str(self.repo_root / 'assets' / 'kokoro' / 'voices-v1.0.bin'))

    from tts_worker.kokoro_engine import KokoroEngine, resolve_model_paths

    self._engine = KokoroEngine(model_paths=resolve_model_paths(), voice=self.default_voice)
    return self._engine

  def synthesize_wav(self, request: TtsRequest) -> bytes:
    engine = self._load()
    audio, sample_rate = engine.synthesize_text(request.text, voice_override=self.voice_override(request.voice))
    from tts_worker.playback import encode_wav_base64

    return base64.b64decode(encode_wav_base64(audio, sample_rate))

  def voice_override(self, requested: str | None) -> str | None:
    if not requested:
      return None
    requested = requested.strip()
    # StackChan may pass numeric VOICEVOX speaker ids or character ids such as ja-02.
    # Keep the Kokoro default unless the caller explicitly passes a Kokoro voice name.
    if requested.isdigit() or requested.startswith('ja-') or requested.startswith('en-'):
      return None
    return requested


class StackChanTtsHandler(BaseHTTPRequestHandler):
  server_version = 'StackChanTtsAdapter/0.1'

  def do_GET(self) -> None:
    parsed = urllib.parse.urlparse(self.path)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if parsed.path in {'/health', '/version'}:
      self.write_json(200, {'ok': True, 'service': 'stackchan-tts-adapter', 'engine': 'kokoro-onnx'})
      return
    if parsed.path in {'/speakers', '/voices'}:
      self.write_json(200, [{'name': self.server.default_voice, 'speaker_uuid': 'kokoro', 'styles': [{'name': 'default', 'id': 0}]}])
      return
    if parsed.path in {'/tts_live.wav', '/synthesize', '/tts', '/api/tts', '/'} and first_value(query, 'text'):
      self.handle_synthesis(b'', 'text/plain', query)
      return
    self.write_json(404, {'ok': False, 'error': 'not_found'})

  def do_POST(self) -> None:
    parsed = urllib.parse.urlparse(self.path)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    length = int(self.headers.get('content-length') or '0')
    body = self.rfile.read(length)

    if parsed.path == '/audio_query':
      text = first_value(query, 'text')
      if not text:
        try:
          text = parse_tts_request(body, self.headers.get('content-type'), query).text
        except Exception:
          text = ''
      self.write_json(200, self.voicevox_audio_query(text or ''))
      return

    if parsed.path in {'/synthesis', '/synthesize', '/tts', '/api/tts', '/'}:
      self.handle_synthesis(body, self.headers.get('content-type'), query)
      return

    self.write_json(404, {'ok': False, 'error': 'not_found'})

  def handle_synthesis(self, body: bytes, content_type: str | None, query: dict[str, list[str]]) -> None:
    try:
      request = parse_tts_request(body, content_type, query)
      wav = self.server.synthesizer.synthesize_wav(request)
      self.send_response(200)
      self.send_header('content-type', 'audio/wav')
      self.send_header('cache-control', 'no-store')
      self.send_header('content-length', str(len(wav)))
      self.end_headers()
      self.wfile.write(wav)
    except Exception as error:
      self.write_json(400, {'ok': False, 'error': 'tts_adapter_error', 'detail': str(error)})

  def voicevox_audio_query(self, text: str) -> dict[str, Any]:
    return {
      'accent_phrases': [],
      'speedScale': 1.0,
      'pitchScale': 0.0,
      'intonationScale': 1.0,
      'volumeScale': 1.0,
      'prePhonemeLength': 0.1,
      'postPhonemeLength': 0.1,
      'outputSamplingRate': 24000,
      'outputStereo': False,
      'kana': '',
      'text': text,
    }

  def log_message(self, fmt: str, *args: Any) -> None:
    sys.stderr.write('[stackchan-tts] ' + fmt % args + '\n')

  def write_json(self, status: int, payload: Any) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    self.send_response(status)
    self.send_header('content-type', 'application/json; charset=utf-8')
    self.send_header('cache-control', 'no-store')
    self.send_header('content-length', str(len(body)))
    self.end_headers()
    self.wfile.write(body)


class StackChanTtsServer(ThreadingHTTPServer):
  def __init__(self, address: tuple[str, int], repo_root: Path, default_voice: str) -> None:
    super().__init__(address, StackChanTtsHandler)
    self.default_voice = default_voice
    self.synthesizer = KokoroSynthesizer(repo_root=repo_root, default_voice=default_voice)


def run_self_test() -> None:
  assert parse_tts_request(b'{"text":"hello"}', 'application/json', {}).text == 'hello'
  assert parse_tts_request(b'text=hello', 'application/x-www-form-urlencoded', {}).text == 'hello'
  assert parse_tts_request(b'hello', 'text/plain', {}).text == 'hello'
  print('ok')


def main(argv: list[str] | None = None) -> int:
  parser = argparse.ArgumentParser(description='StackChan Minimal piper/VOICEVOX-compatible TTS adapter for minimum-headroom Kokoro')
  parser.add_argument('--host', default='0.0.0.0')
  parser.add_argument('--port', type=int, default=5000)
  parser.add_argument('--voice', default='af_heart')
  parser.add_argument('--repo-root', default=str(Path(__file__).resolve().parents[2]))
  parser.add_argument('--self-test', action='store_true')
  args = parser.parse_args(argv)

  if args.self_test:
    run_self_test()
    return 0

  server = StackChanTtsServer((args.host, args.port), repo_root=Path(args.repo_root).resolve(), default_voice=args.voice)
  print(f'[stackchan-tts] listening on http://{args.host}:{args.port}, voice={args.voice}', flush=True)
  try:
    server.serve_forever()
  except KeyboardInterrupt:
    return 130
  finally:
    server.server_close()
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
