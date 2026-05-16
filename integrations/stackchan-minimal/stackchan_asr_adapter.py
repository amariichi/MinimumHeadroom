#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


@dataclass(frozen=True)
class AudioRequest:
  audio: bytes
  mime_type: str
  language: str
  filename: str | None = None


def normalize_language(value: str | None, fallback: str = 'ja') -> str:
  normalized = (value or '').strip().lower().replace('_', '-')
  if normalized.startswith('en'):
    return 'en'
  if normalized.startswith('ja'):
    return 'ja'
  return fallback


def parse_content_type(header: str | None) -> tuple[str, dict[str, str]]:
  if not header:
    return 'application/octet-stream', {}
  parts = [part.strip() for part in header.split(';')]
  media_type = parts[0].lower() if parts and parts[0] else 'application/octet-stream'
  params: dict[str, str] = {}
  for part in parts[1:]:
    if '=' not in part:
      continue
    key, value = part.split('=', 1)
    params[key.strip().lower()] = value.strip().strip('"')
  return media_type, params


def guess_mime_type(filename: str | None, fallback: str) -> str:
  if fallback and fallback != 'application/octet-stream':
    return fallback
  if filename:
    guessed, _ = mimetypes.guess_type(filename)
    if guessed:
      return guessed
  return 'application/octet-stream'


def parse_audio_request(
  body: bytes,
  content_type: str | None,
  query: dict[str, list[str]],
  default_language: str,
) -> AudioRequest:
  media_type, _ = parse_content_type(content_type)
  language = normalize_language(first_value(query, 'language') or first_value(query, 'lang'), default_language)

  if media_type.startswith('multipart/form-data'):
    return parse_multipart_request(body, content_type or media_type, language)

  if media_type == 'application/json':
    payload = json.loads(body.decode('utf-8'))
    if not isinstance(payload, dict):
      raise ValueError('JSON body must be an object')
    raw_audio = payload.get('audioBase64') or payload.get('audio_base64') or payload.get('audio')
    if not isinstance(raw_audio, str) or not raw_audio.strip():
      raise ValueError('JSON body must include audioBase64')
    language = normalize_language(str(payload.get('language') or payload.get('lang') or ''), language)
    mime_type = str(payload.get('mimeType') or payload.get('mime_type') or 'application/octet-stream')
    return AudioRequest(audio=base64.b64decode(raw_audio), mime_type=mime_type, language=language)

  if media_type == 'application/x-www-form-urlencoded':
    values = urllib.parse.parse_qs(body.decode('utf-8'), keep_blank_values=True)
    raw_audio = first_value(values, 'audioBase64') or first_value(values, 'audio_base64') or first_value(values, 'audio')
    if not raw_audio:
      raise ValueError('form body must include audioBase64')
    language = normalize_language(first_value(values, 'language') or first_value(values, 'lang'), language)
    mime_type = first_value(values, 'mimeType') or first_value(values, 'mime_type') or 'application/octet-stream'
    return AudioRequest(audio=base64.b64decode(raw_audio), mime_type=mime_type, language=language)

  if not body:
    raise ValueError('request body is empty')
  return AudioRequest(audio=body, mime_type=media_type, language=language)


def parse_multipart_request(body: bytes, content_type: str, language: str) -> AudioRequest:
  header = f'Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n'.encode('utf-8')
  message = BytesParser(policy=default).parsebytes(header + body)
  audio: bytes | None = None
  mime_type = 'application/octet-stream'
  filename: str | None = None

  for part in message.iter_parts():
    name = part.get_param('name', header='content-disposition')
    if name in {'language', 'lang'}:
      value = part.get_payload(decode=True).decode('utf-8', errors='ignore')
      language = normalize_language(value, language)
      continue
    if name in {'file', 'audio', 'audio_file', 'upload'} or audio is None:
      payload = part.get_payload(decode=True)
      if payload:
        audio = payload
        filename = part.get_filename()
        mime_type = guess_mime_type(filename, part.get_content_type())

  if audio is None:
    raise ValueError('multipart body does not include audio')
  return AudioRequest(audio=audio, mime_type=mime_type, language=language, filename=filename)


def first_value(values: dict[str, list[str]], key: str) -> str | None:
  items = values.get(key)
  if not items:
    return None
  return items[0]


def forward_to_asr(audio_request: AudioRequest, asr_base_url: str, timeout: float) -> dict[str, Any]:
  base = asr_base_url.rstrip('/')
  endpoint = f'{base}/v1/asr/{audio_request.language}'
  payload = {
    'audioBase64': base64.b64encode(audio_request.audio).decode('ascii'),
    'mimeType': audio_request.mime_type,
  }
  request = urllib.request.Request(
    endpoint,
    data=json.dumps(payload).encode('utf-8'),
    headers={'content-type': 'application/json'},
    method='POST',
  )
  with urllib.request.urlopen(request, timeout=timeout) as response:
    raw = response.read()
  parsed = json.loads(raw.decode('utf-8'))
  if not isinstance(parsed, dict):
    raise ValueError('ASR worker returned non-object JSON')
  return parsed


def whisper_response(asr_response: dict[str, Any]) -> dict[str, Any]:
  text = str(asr_response.get('text') or '').strip()
  language = str(asr_response.get('language') or 'unknown')
  return {
    'text': text,
    'language': language,
    'segments': [],
    'minimum_headroom': asr_response,
  }


class StackChanAsrHandler(BaseHTTPRequestHandler):
  server_version = 'StackChanAsrAdapter/0.1'

  def do_GET(self) -> None:
    parsed = urllib.parse.urlparse(self.path)
    if parsed.path in {'/health', '/'}:
      self.write_json(200, {'ok': True, 'service': 'stackchan-asr-adapter'})
      return
    self.write_json(404, {'ok': False, 'error': 'not_found'})

  def do_POST(self) -> None:
    parsed = urllib.parse.urlparse(self.path)
    if parsed.path not in {'/inference', '/v1/audio/transcriptions', '/transcribe', '/asr'}:
      self.write_json(404, {'ok': False, 'error': 'not_found'})
      return

    length = int(self.headers.get('content-length') or '0')
    body = self.rfile.read(length)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    try:
      audio_request = parse_audio_request(body, self.headers.get('content-type'), query, self.server.default_language)
      upstream = forward_to_asr(audio_request, self.server.asr_base_url, self.server.upstream_timeout)
      self.write_json(200, whisper_response(upstream))
    except urllib.error.HTTPError as error:
      detail = error.read().decode('utf-8', errors='replace')
      self.write_json(502, {'ok': False, 'error': 'asr_upstream_error', 'status': error.code, 'detail': detail[:500]})
    except Exception as error:
      self.write_json(400, {'ok': False, 'error': 'asr_adapter_error', 'detail': str(error)})

  def log_message(self, fmt: str, *args: Any) -> None:
    sys.stderr.write('[stackchan-asr] ' + fmt % args + '\n')

  def write_json(self, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    self.send_response(status)
    self.send_header('content-type', 'application/json; charset=utf-8')
    self.send_header('cache-control', 'no-store')
    self.send_header('content-length', str(len(body)))
    self.end_headers()
    self.wfile.write(body)


class StackChanAsrServer(ThreadingHTTPServer):
  def __init__(self, address: tuple[str, int], asr_base_url: str, default_language: str, upstream_timeout: float) -> None:
    super().__init__(address, StackChanAsrHandler)
    self.asr_base_url = asr_base_url
    self.default_language = default_language
    self.upstream_timeout = upstream_timeout


def run_self_test() -> None:
  boundary = 'test-boundary'
  body = (
    f'--{boundary}\r\n'
    'Content-Disposition: form-data; name="language"\r\n\r\n'
    'ja\r\n'
    f'--{boundary}\r\n'
    'Content-Disposition: form-data; name="file"; filename="sample.webm"\r\n'
    'Content-Type: audio/webm\r\n\r\n'
  ).encode('utf-8') + b'0123456789abcdef' + f'\r\n--{boundary}--\r\n'.encode('utf-8')
  parsed = parse_audio_request(body, f'multipart/form-data; boundary={boundary}', {}, 'ja')
  assert parsed.language == 'ja'
  assert parsed.mime_type == 'audio/webm'
  assert parsed.audio == b'0123456789abcdef'
  print('ok')


def main(argv: list[str] | None = None) -> int:
  parser = argparse.ArgumentParser(description='StackChan Minimal whisper.cpp-compatible ASR adapter for minimum-headroom Parakeet ASR')
  parser.add_argument('--host', default='0.0.0.0')
  parser.add_argument('--port', type=int, default=8081)
  parser.add_argument('--asr-base-url', default='http://127.0.0.1:8091')
  parser.add_argument('--language', default='ja')
  parser.add_argument('--upstream-timeout', type=float, default=30.0)
  parser.add_argument('--self-test', action='store_true')
  args = parser.parse_args(argv)

  if args.self_test:
    run_self_test()
    return 0

  server = StackChanAsrServer(
    (args.host, args.port),
    asr_base_url=args.asr_base_url,
    default_language=normalize_language(args.language),
    upstream_timeout=args.upstream_timeout,
  )
  print(f'[stackchan-asr] listening on http://{args.host}:{args.port}, upstream={args.asr_base_url}', flush=True)
  try:
    server.serve_forever()
  except KeyboardInterrupt:
    return 130
  finally:
    server.server_close()
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
