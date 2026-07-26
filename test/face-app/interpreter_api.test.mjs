import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createInterpreterApi, inspectPcm16MonoWav } from '../../face-app/dist/interpreter_api.js';
import { InterpreterAtomVolumeError } from '../../face-app/dist/interpreter_atom_volume.js';
import { InterpreterPipelineError } from '../../face-app/dist/interpreter_pipeline.js';

function wav(durationMs = 500, sampleRate = 16_000, channels = 1, bits = 16) {
  const bytesPerSample = bits / 8;
  const dataBytes = Math.floor((sampleRate * durationMs) / 1000) * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function request({
  method = 'GET',
  url = '/',
  headers = {},
  body = Buffer.alloc(0),
  remoteAddress = null
} = {}) {
  const stream = new Readable({
    read() {
      this.push(body);
      this.push(null);
    }
  });
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  if (remoteAddress) {
    stream.socket = { remoteAddress };
  }
  return stream;
}

function response() {
  let statusCode = null;
  let headers = null;
  let body = '';
  return {
    writableEnded: false,
    writeHead(code, nextHeaders) {
      statusCode = code;
      headers = nextHeaders;
    },
    end(chunk = '') {
      body += String(chunk);
      this.writableEnded = true;
    },
    result() {
      return {
        statusCode,
        headers,
        json: body ? JSON.parse(body) : null
      };
    }
  };
}

test('WAV inspection accepts only 16 kHz mono PCM16', () => {
  assert.equal(inspectPcm16MonoWav(wav()).ok, true);
  assert.equal(inspectPcm16MonoWav(wav(500, 44_100)).error, 'unsupported_wav_format');
  assert.equal(inspectPcm16MonoWav(Buffer.from('bad')).error, 'invalid_wav');
});

test('turn API validates headers, content type, format, and duration', async () => {
  const api = createInterpreterApi({
    pipeline: {
      processTurn: async () => ({ ok: true }),
      resetSession: () => ({ ok: true })
    }
  });
  const missing = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/turn',
    headers: { 'content-type': 'audio/wav' },
    body: wav()
  }), missing);
  assert.equal(missing.result().statusCode, 400);

  const unsupported = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/turn',
    headers: {
      'content-type': 'audio/webm',
      'x-interpreter-session-id': 'one',
      'x-interpreter-turn-id': 'one'
    },
    body: wav()
  }), unsupported);
  assert.equal(unsupported.result().statusCode, 415);

  const short = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/turn',
    headers: {
      'content-type': 'audio/wav',
      'x-interpreter-session-id': 'one',
      'x-interpreter-turn-id': 'one'
    },
    body: wav(100)
  }), short);
  assert.equal(short.result().json.error, 'audio_too_short');
});

test('turn API forwards validated audio and maps pipeline errors', async () => {
  const captured = [];
  const api = createInterpreterApi({
    pipeline: {
      async processTurn(input) {
        captured.push(input);
        return { ok: true, turnId: input.turnId };
      },
      resetSession: () => ({ ok: true })
    }
  });
  const ok = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/turn',
    headers: {
      'content-type': 'audio/wav',
      'x-interpreter-session-id': 'session-one',
      'x-interpreter-turn-id': 'turn-one'
    },
    body: wav()
  }), ok);
  assert.equal(ok.result().statusCode, 200);
  assert.equal(captured[0].inputSource, 'browser');
  assert.equal(captured[0].sessionId, 'session-one');

  const busyApi = createInterpreterApi({
    pipeline: {
      async processTurn() {
        throw new InterpreterPipelineError('turn_in_progress', 409);
      },
      resetSession: () => ({ ok: true })
    },
    log: { warn() {} }
  });
  const busy = response();
  await busyApi.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/turn',
    headers: {
      'content-type': 'audio/wav',
      'x-interpreter-session-id': 'session-one',
      'x-interpreter-turn-id': 'turn-two'
    },
    body: wav()
  }), busy);
  assert.equal(busy.result().statusCode, 409);
  assert.equal(busy.result().json.error, 'turn_in_progress');
});

test('config, health, session state, reset, and unrelated routes have stable contracts', async () => {
  const resets = [];
  const api = createInterpreterApi({
    pipeline: {
      processTurn: async () => ({ ok: true }),
      getSessionSnapshot(sessionId) {
        return {
          state: {
            anchorLanguage: sessionId === 'atom:one' ? 'ja' : null,
            partnerLanguage: sessionId === 'atom:one' ? 'es' : null,
            revision: sessionId === 'atom:one' ? 2 : 0
          },
          latestTurn: sessionId === 'atom:one'
            ? {
                turnId: 'turn-latest',
                transcript: 'こんにちは',
                sourceLanguage: 'ja',
                targetLanguage: 'es',
                translation: 'Hola'
              }
            : null
        };
      },
      resetSession(sessionId, turnId) {
        resets.push({ sessionId, turnId });
        return { ok: true, reset: true };
      }
    },
    getConfig: () => ({ preset: 'fixture', audioEndpoint: 'browser' }),
    getHealth: () => ({ ok: true, service: 'interpreter' })
  });
  const config = response();
  await api.handleHttpRequest(request({ url: '/api/interpreter/config' }), config);
  assert.equal(config.result().json.preset, 'fixture');

  const health = response();
  await api.handleHttpRequest(request({ url: '/healthz' }), health);
  assert.equal(health.result().statusCode, 200);

  const session = response();
  await api.handleHttpRequest(request({
    url: '/api/interpreter/session',
    headers: { 'x-interpreter-session-id': 'atom:one' }
  }), session);
  assert.deepEqual(session.result().json, {
    ok: true,
    sessionId: 'atom:one',
    state: {
      anchorLanguage: 'ja',
      partnerLanguage: 'es',
      revision: 2
    },
    latestTurn: {
      turnId: 'turn-latest',
      transcript: 'こんにちは',
      sourceLanguage: 'ja',
      targetLanguage: 'es',
      translation: 'Hola'
    }
  });

  const missingSession = response();
  await api.handleHttpRequest(request({
    url: '/api/interpreter/session'
  }), missingSession);
  assert.equal(missingSession.result().statusCode, 400);
  assert.equal(missingSession.result().json.error, 'session_id_required');

  const reset = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/session/reset',
    headers: {
      'x-interpreter-session-id': 'one',
      'x-interpreter-turn-id': 'reset-one'
    }
  }), reset);
  assert.deepEqual(resets, [{ sessionId: 'one', turnId: 'reset-one' }]);

  const other = response();
  assert.equal(await api.handleHttpRequest(request({ url: '/api/other' }), other), false);
});

test('manual pair API validates its bounded JSON contract and forwards identity headers', async () => {
  const calls = [];
  const api = createInterpreterApi({
    pipeline: {
      processTurn: async () => ({ ok: true }),
      async setSessionPair(input) {
        calls.push(input);
        return {
          ok: true,
          manual: true,
          state: {
            anchorLanguage: input.anchorLanguage,
            partnerLanguage: input.partnerLanguage,
            revision: 1
          }
        };
      },
      resetSession: () => ({ ok: true })
    }
  });
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'x-interpreter-session-id': 'atom:one',
    'x-interpreter-turn-id': 'pair-one'
  };

  const ok = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/session/pair',
    headers,
    body: Buffer.from('{"anchorLanguage":"ja","partnerLanguage":"es"}')
  }), ok);
  assert.equal(ok.result().statusCode, 200);
  assert.deepEqual(calls, [{
    sessionId: 'atom:one',
    turnId: 'pair-one',
    anchorLanguage: 'ja',
    partnerLanguage: 'es',
    inputSource: 'browser'
  }]);

  const wrongMethod = response();
  await api.handleHttpRequest(request({
    method: 'GET',
    url: '/api/interpreter/session/pair',
    headers
  }), wrongMethod);
  assert.equal(wrongMethod.result().statusCode, 405);

  const wrongType = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/session/pair',
    headers: { ...headers, 'content-type': 'text/plain' },
    body: Buffer.from('{}')
  }), wrongType);
  assert.equal(wrongType.result().statusCode, 415);

  const missingHeader = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/session/pair',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"anchorLanguage":"ja","partnerLanguage":"es"}')
  }), missingHeader);
  assert.equal(missingHeader.result().json.error, 'session_id_required');

  const extraField = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/session/pair',
    headers,
    body: Buffer.from(
      '{"anchorLanguage":"ja","partnerLanguage":"es","provider":"gemma4"}'
    )
  }), extraField);
  assert.equal(extraField.result().json.error, 'invalid_pair_request');

  const tooLarge = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/session/pair',
    headers,
    body: Buffer.from(JSON.stringify({
      anchorLanguage: 'j'.repeat(1_100),
      partnerLanguage: 'es'
    }))
  }), tooLarge);
  assert.equal(tooLarge.result().statusCode, 413);
});

test('manual pair API maps pipeline validation and concurrency errors', async () => {
  const api = createInterpreterApi({
    pipeline: {
      processTurn: async () => ({ ok: true }),
      async setSessionPair(input) {
        if (input.anchorLanguage === input.partnerLanguage) {
          throw new InterpreterPipelineError('pair_languages_must_differ', 422);
        }
        throw new InterpreterPipelineError('turn_in_progress', 409);
      },
      resetSession: () => ({ ok: true })
    },
    log: { warn() {} }
  });
  const send = async (anchorLanguage, partnerLanguage) => {
    const target = response();
    await api.handleHttpRequest(request({
      method: 'POST',
      url: '/api/interpreter/session/pair',
      headers: {
        'content-type': 'application/json',
        'x-interpreter-session-id': 'one',
        'x-interpreter-turn-id': `pair-${anchorLanguage}-${partnerLanguage}`
      },
      body: Buffer.from(JSON.stringify({ anchorLanguage, partnerLanguage }))
    }), target);
    return target.result();
  };

  assert.equal((await send('es', 'es')).json.error, 'pair_languages_must_differ');
  assert.equal((await send('ja', 'es')).json.error, 'turn_in_progress');
});

test('Atom PTT compatibility transcribes once and dispatches the prepared turn immediately', async () => {
  const asrResult = {
    transcript: '안녕하세요',
    sourceLanguage: 'ko',
    confidence: 0.91,
    providerContext: { token: 'gemma-audio-context' }
  };
  const transcriptions = [];
  const turns = [];
  let finishTurn;
  const api = createInterpreterApi({
    pipeline: {
      processTurn: async () => ({ ok: true }),
      async transcribeAudio(input) {
        transcriptions.push(input);
        return asrResult;
      },
      processRecognizedTurn(input) {
        turns.push(input);
        return new Promise((resolve) => {
          finishTurn = resolve;
        });
      },
      resetSession: () => ({ ok: true })
    },
    createTurnId: () => 'ptt-turn-one',
    atomSessionId: (deviceId) => `atom:${deviceId}`
  });
  const remoteAddress = '::ffff:192.0.2.25';
  const asrResponse = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/operator/asr?lang=ja',
    headers: { 'content-type': 'audio/wav' },
    body: wav(700),
    remoteAddress
  }), asrResponse);
  assert.deepEqual(asrResponse.result().json, {
    ok: true,
    text: '안녕하세요',
    language: 'ko',
    confidence: 0.91,
    route: 'interpreter_ptt'
  });
  assert.equal(transcriptions.length, 1);
  assert.equal(transcriptions[0].speechMs, 700);

  const payload = {
    v: 1,
    type: 'operator_response',
    session_id: 'face-one',
    request_id: null,
    response_kind: 'text',
    value: '안녕하세요',
    source: 'atom'
  };
  const submitResponse = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/operator/response',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload)),
    remoteAddress
  }), submitResponse);
  assert.deepEqual(submitResponse.result(), {
    statusCode: 202,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    },
    json: {
      ok: true,
      session_id: 'atom:face-one',
      turn_id: 'ptt-turn-one'
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(turns, [{
    asrResult,
    sessionId: 'atom:face-one',
    turnId: 'ptt-turn-one',
    inputSource: 'atom'
  }]);

  const duplicate = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/operator/response',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload)),
    remoteAddress
  }), duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(duplicate.result().statusCode, 202);
  assert.equal(transcriptions.length, 1);
  assert.equal(turns.length, 1);
  finishTurn({ ok: true });
});

test('direct Atom WebSocket PTT response uses the pending HTTP ASR result', async () => {
  const turns = [];
  const api = createInterpreterApi({
    pipeline: {
      processTurn: async () => ({ ok: true }),
      transcribeAudio: async () => ({
        transcript: 'Hola',
        sourceLanguage: 'es',
        confidence: null,
        providerContext: { source: 'audio' }
      }),
      async processRecognizedTurn(input) {
        turns.push(input);
        return { ok: true };
      },
      resetSession: () => ({ ok: true })
    },
    createTurnId: () => 'ptt-ws-one'
  });
  const remoteAddress = '198.51.100.8';
  const prepared = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/operator/asr?lang=en',
    headers: { 'content-type': 'audio/wav' },
    body: wav(),
    remoteAddress
  }), prepared);
  assert.equal(prepared.result().statusCode, 200);

  const directive = api.handlePttPayload({
    type: 'operator_response',
    session_id: 'atom-headroom-1',
    response_kind: 'text',
    value: 'Hola',
    source: 'atom'
  }, {
    isAtom: true,
    socket: { remoteAddress }
  });
  assert.equal(directive.relay, false);
  assert.equal(directive.accepted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].sessionId, 'atom:atom-headroom-1');
  assert.equal(turns[0].inputSource, 'atom');
});

test('Atom PTT compatibility rejects cross-client, mismatched, and expired transcripts', async () => {
  let nowMs = 1_000;
  const api = createInterpreterApi({
    pipeline: {
      processTurn: async () => ({ ok: true }),
      transcribeAudio: async () => ({
        transcript: 'Noise-safe phrase',
        sourceLanguage: 'en',
        confidence: null
      }),
      processRecognizedTurn: async () => ({ ok: true }),
      resetSession: () => ({ ok: true })
    },
    createTurnId: () => 'ptt-expiry-one',
    now: () => nowMs,
    pttPendingTtlMs: 1_000
  });
  const prepare = async (remoteAddress, durationMs = 500) => {
    const target = response();
    await api.handleHttpRequest(request({
      method: 'POST',
      url: '/api/operator/asr',
      headers: { 'content-type': 'audio/wav' },
      body: wav(durationMs),
      remoteAddress
    }), target);
    return target.result();
  };
  const submit = async (remoteAddress, value = 'Noise-safe phrase') => {
    const target = response();
    await api.handleHttpRequest(request({
      method: 'POST',
      url: '/api/operator/response',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        type: 'operator_response',
        session_id: 'face-one',
        value,
        source: 'atom'
      })),
      remoteAddress
    }), target);
    return target.result();
  };

  assert.equal((await prepare('203.0.113.10')).statusCode, 200);
  assert.equal((await submit('203.0.113.11')).json.error, 'ptt_transcript_missing');
  assert.equal(
    (await submit('203.0.113.10', 'Changed text')).json.error,
    'ptt_transcript_mismatch'
  );
  nowMs += 1_001;
  const expired = await submit('203.0.113.10');
  assert.equal(expired.statusCode, 410);
  assert.equal(expired.json.error, 'ptt_transcript_expired');
  assert.equal((await prepare('203.0.113.10', 100)).json.error, 'audio_too_short');
});

test('Atom PTT compatibility bounds WAV uploads and rejects invalid response JSON', async () => {
  let transcriptionCalls = 0;
  const boundedApi = createInterpreterApi({
    pipeline: {
      processTurn: async () => ({ ok: true }),
      async transcribeAudio() {
        transcriptionCalls += 1;
        return { transcript: 'unused', sourceLanguage: 'en' };
      },
      processRecognizedTurn: async () => ({ ok: true }),
      resetSession: () => ({ ok: true })
    },
    maxBodyBytes: 1_024
  });
  const oversized = response();
  await boundedApi.handleHttpRequest(request({
    method: 'POST',
    url: '/api/operator/asr',
    headers: { 'content-type': 'audio/wav' },
    body: wav(),
    remoteAddress: '192.0.2.90'
  }), oversized);
  assert.equal(oversized.result().statusCode, 413);
  assert.equal(oversized.result().json.error, 'payload_too_large');
  assert.equal(transcriptionCalls, 0);

  const invalidJson = response();
  await boundedApi.handleHttpRequest(request({
    method: 'POST',
    url: '/api/operator/response',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{'),
    remoteAddress: '192.0.2.90'
  }), invalidJson);
  assert.equal(invalidJson.result().statusCode, 400);
  assert.equal(invalidJson.result().json.error, 'invalid_json');
});

test('Atom PTT compatibility accepts the next utterance after a turn failure', async () => {
  let transcript = 'First phrase';
  let nextTurn = 0;
  const turns = [];
  const warnings = [];
  const api = createInterpreterApi({
    pipeline: {
      processTurn: async () => ({ ok: true }),
      async transcribeAudio() {
        return {
          transcript,
          sourceLanguage: 'en',
          confidence: null
        };
      },
      async processRecognizedTurn(input) {
        turns.push(input);
        if (turns.length === 1) {
          throw new Error('fixture downstream failure');
        }
        return { ok: true };
      },
      resetSession: () => ({ ok: true })
    },
    createTurnId: () => `ptt-recovery-${++nextTurn}`,
    log: {
      warn(message) {
        warnings.push(message);
      }
    }
  });
  const remoteAddress = '192.0.2.91';
  const prepare = async () => {
    const target = response();
    await api.handleHttpRequest(request({
      method: 'POST',
      url: '/api/operator/asr',
      headers: { 'content-type': 'audio/wav' },
      body: wav(),
      remoteAddress
    }), target);
    return target.result();
  };
  const submit = async () => {
    const target = response();
    await api.handleHttpRequest(request({
      method: 'POST',
      url: '/api/operator/response',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        type: 'operator_response',
        session_id: 'face-one',
        value: transcript,
        source: 'atom'
      })),
      remoteAddress
    }), target);
    return target.result();
  };

  assert.equal((await prepare()).statusCode, 200);
  assert.equal((await submit()).statusCode, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(turns.length, 1);
  assert.equal(warnings.length, 1);

  transcript = 'Second phrase';
  assert.equal((await prepare()).statusCode, 200);
  assert.equal((await submit()).statusCode, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.turnId), [
    'ptt-recovery-1',
    'ptt-recovery-2'
  ]);
  assert.equal(turns[1].asrResult.transcript, 'Second phrase');
});

test('Atom volume API validates JSON and maps the device controller result', async () => {
  const calls = [];
  const api = createInterpreterApi({
    pipeline: {
      processTurn: async () => ({ ok: true }),
      resetSession: () => ({ ok: true })
    },
    async setAtomVolume(input) {
      calls.push(input);
      if (input.volume === 200) {
        throw new InterpreterAtomVolumeError('atom_volume_timeout', 504);
      }
      return {
        ok: true,
        deviceId: input.deviceId,
        speakerVolume: input.volume,
        persistent: false
      };
    },
    log: { warn() {} }
  });

  const wrongType = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/atom/volume',
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('{}')
  }), wrongType);
  assert.equal(wrongType.result().statusCode, 415);

  const invalid = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/atom/volume',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"volume":201}')
  }), invalid);
  assert.equal(invalid.result().json.error, 'invalid_atom_volume');

  const ok = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/atom/volume',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from('{"deviceId":"atom-one","volume":160}')
  }), ok);
  assert.deepEqual(calls[0], { deviceId: 'atom-one', volume: 160 });
  assert.deepEqual(ok.result().json, {
    ok: true,
    deviceId: 'atom-one',
    speakerVolume: 160,
    persistent: false
  });

  const timeout = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/interpreter/atom/volume',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{"volume":200}')
  }), timeout);
  assert.equal(timeout.result().statusCode, 504);
  assert.equal(timeout.result().json.error, 'atom_volume_timeout');
});
