import assert from 'node:assert/strict';
import test from 'node:test';

import { createInterpreterPipeline } from '../../face-app/dist/interpreter_pipeline.js';
import { createAtomEndpointRegistry } from '../../face-app/dist/interpreter_audio_route.js';
import {
  createGemma4InterpreterProviders
} from '../../face-app/dist/interpreter_gemma4_provider.js';

function openAiResponse(value) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [{ message: { content: JSON.stringify(value) } }]
      });
    }
  };
}

function providers(overrides = {}) {
  const calls = [];
  const ttsPayloads = [];
  return {
    calls,
    ttsPayloads,
    asr: overrides.asr ?? {
      async transcribe() {
        calls.push('asr');
        return {
          text: 'Hola',
          language: 'es',
          languageEvidence: {
            tagObserved: true,
            speechMs: 900,
            contentGraphemeCount: 4
          }
        };
      }
    },
    intent: overrides.intent ?? {
      async analyze(input) {
        calls.push('intent');
        return {
          contentText: input.transcript,
          requestedTargetLanguage: null,
          commandOnly: false
        };
      }
    },
    translation: overrides.translation ?? {
      async translate(input) {
        calls.push('translation');
        return { translation: input.targetLanguage === 'en' ? 'Hello' : 'Hola' };
      }
    },
    tts: overrides.tts ?? {
      async enqueue(payload) {
        calls.push('tts');
        ttsPayloads.push(payload);
        return { accepted: true, generation: 4 };
      }
    }
  };
}

test('pipeline calls providers in order and translates first Spanish to English', async () => {
  const fixture = providers();
  const events = [];
  const pipeline = createInterpreterPipeline({
    ...fixture,
    broadcast: (payload) => events.push(payload)
  });
  const result = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'one',
    turnId: 'turn-1',
    inputSource: 'browser'
  });
  assert.deepEqual(fixture.calls, ['asr', 'intent', 'translation', 'tts']);
  assert.equal(result.sourceLanguage, 'es');
  assert.equal(result.targetLanguage, 'en');
  assert.equal(result.translation, 'Hello');
  assert.equal(result.state.anchorLanguage, 'es');
  assert.equal(result.state.partnerLanguage, 'en');
  assert.equal(result.state.revision, 1);
  assert.equal(result.audioEndpoint, 'browser');
  assert.equal(result.pairAnnouncement.status, 'skipped');
  assert.equal(result.pairAnnouncement.reason, 'initial_implicit_pair');
  assert.deepEqual(
    fixture.ttsPayloads.map(({ purpose, queueMode, language }) => ({
      purpose,
      queueMode,
      language
    })),
    [
      {
        purpose: 'translation',
        queueMode: 'replace',
        language: 'en'
      }
    ]
  );
  assert.equal(events.some((event) => event.type === 'interpreter_translation'), true);
  assert.equal(
    events.at(-1)?.type,
    'interpreter_turn_completed'
  );
  assert.equal(
    events.findIndex((event) => event.type === 'interpreter_translation')
      < events.findIndex((event) => event.type === 'interpreter_turn_completed'),
    true
  );
  assert.deepEqual(pipeline.getSessionSnapshot('one').latestTurn, {
    turnId: 'turn-1',
    transcript: 'Hola',
    contentText: 'Hola',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    translation: 'Hello',
    commandOnly: false,
    warnings: [],
    audioEndpoint: 'browser',
    state: {
      anchorLanguage: 'es',
      partnerLanguage: 'en',
      revision: 1
    },
    tts: {
      status: 'queued',
      language: 'en',
      audioEndpoint: 'browser'
    }
  });
});

test('pipeline reports ASR fallback provenance without exposing transcript in that event', async () => {
  const events = [];
  const fixture = providers({
    asr: {
      async transcribe() {
        return {
          text: 'Hola',
          language: 'es',
          languageEvidence: {
            tagObserved: true,
            speechMs: 900,
            provider: 'gemma4',
            fallbackFrom: 'nemotron-3.5-asr',
            fallbackReason: 'language_tag_missing'
          }
        };
      }
    }
  });
  const pipeline = createInterpreterPipeline({
    ...fixture,
    broadcast: (payload) => events.push(payload)
  });

  await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'fallback-event',
    turnId: 'turn-1'
  });

  const event = events.find((entry) => entry.type === 'interpreter_asr_fallback');
  assert.deepEqual(
    {
      from: event?.from,
      to: event?.to,
      reason: event?.reason
    },
    {
      from: 'nemotron-3.5-asr',
      to: 'gemma4',
      reason: 'language_tag_missing'
    }
  );
  assert.equal(Object.hasOwn(event, 'transcript'), false);
});

test('PTT reuses one ASR result and its provider context in the normal Atom pipeline', async () => {
  const calls = [];
  const providerContext = Object.freeze({
    transcript: '안녕하세요',
    sourceLanguage: 'ko'
  });
  const pipeline = createInterpreterPipeline({
    asr: {
      async transcribe(_audio, options) {
        calls.push(['asr', options.languageHint]);
        return {
          text: '안녕하세요',
          language: 'ko',
          confidence: 0.94,
          providerContext
        };
      }
    },
    intent: {
      async analyze(input) {
        calls.push(['intent', input.providerContext]);
        return {
          contentText: input.transcript,
          requestedTargetLanguage: null,
          commandOnly: false,
          providerContext: input.providerContext
        };
      }
    },
    translation: {
      async translate(input) {
        calls.push(['translation', input.providerContext]);
        return { translation: 'Hello.' };
      }
    },
    tts: {
      async enqueue(input) {
        calls.push(['tts', input.audioEndpoint]);
        return { accepted: true, generation: 7 };
      }
    }
  });

  const asrResult = await pipeline.transcribeAudio({
    audio: Buffer.from('wav'),
    sessionId: 'ptt:192.0.2.4',
    turnId: 'ptt-one',
    inputSource: 'atom',
    speechMs: 720
  });
  const result = await pipeline.processRecognizedTurn({
    asrResult,
    sessionId: 'atom:face-one',
    turnId: 'ptt-one',
    inputSource: 'atom'
  });
  const duplicate = await pipeline.processRecognizedTurn({
    asrResult,
    sessionId: 'atom:face-one',
    turnId: 'ptt-one',
    inputSource: 'atom'
  });

  assert.equal(asrResult.sourceLanguage, 'ko');
  assert.equal(asrResult.providerContext, providerContext);
  assert.equal(result.sourceLanguage, 'ko');
  assert.equal(result.targetLanguage, 'en');
  assert.equal(result.audioEndpoint, 'atom');
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(calls, [
    ['asr', 'auto'],
    ['intent', providerContext],
    ['translation', providerContext],
    ['tts', 'atom']
  ]);
});

test('pipeline forwards Atom VAD speech duration to ASR language evidence', async () => {
  let capturedOptions = null;
  const fixture = providers({
    asr: {
      async transcribe(_audio, options) {
        capturedOptions = options;
        return {
          text: 'Hola',
          language: 'es',
          languageEvidence: {
            tagObserved: true,
            speechMs: options.speechMs,
            contentGraphemeCount: 4
          }
        };
      }
    }
  });
  const pipeline = createInterpreterPipeline(fixture);
  await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'atom-duration',
    turnId: 'turn-1',
    inputSource: 'atom',
    speechMs: 1_375.9
  });
  assert.equal(capturedOptions.speechMs, 1_375);
});

test('Atom VAD ignores an unusable ASR result without changing state or latest turn', async () => {
  const calls = [];
  const events = [];
  const unusable = Object.assign(new Error('language tag missing'), {
    code: 'asr_unusable_result'
  });
  const pipeline = createInterpreterPipeline({
    ...providers({
      asr: {
        async transcribe() {
          calls.push('asr');
          throw unusable;
        }
      }
    }),
    broadcast: (payload) => events.push(payload)
  });
  const input = {
    audio: Buffer.from('wav'),
    sessionId: 'atom:unclear',
    turnId: 'turn-unclear',
    inputSource: 'atom',
    speechMs: 480
  };

  const result = await pipeline.processTurn(input);
  const duplicate = await pipeline.processTurn(input);

  assert.equal(result.ok, true);
  assert.equal(result.ignored, true);
  assert.equal(result.reason, 'asr_unusable_result');
  assert.equal(result.audioEndpoint, 'atom');
  assert.deepEqual(result.state, {
    anchorLanguage: null,
    partnerLanguage: null,
    revision: 0,
    pendingLanguageCandidate: null
  });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(calls, ['asr']);
  assert.equal(pipeline.getSessionSnapshot('atom:unclear').latestTurn, null);
  assert.deepEqual(
    events.map((event) => event.type),
    ['interpreter_turn_started', 'interpreter_turn_ignored']
  );
});

test('duplicate turn id returns cached response without a second translation or TTS', async () => {
  const fixture = providers();
  const pipeline = createInterpreterPipeline(fixture);
  const input = {
    audio: Buffer.from('wav'),
    sessionId: 'one',
    turnId: 'turn-1'
  };
  await pipeline.processTurn(input);
  const duplicate = await pipeline.processTurn(input);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(fixture.calls, ['asr', 'intent', 'translation', 'tts']);
  assert.equal(duplicate.state.revision, 1);
});

test('manual pair commit is atomic, announced once, idempotent, and used by later turns', async () => {
  const fixture = providers();
  const events = [];
  const pipeline = createInterpreterPipeline({
    ...fixture,
    supportedPairLanguages: ['en', 'es', 'ja'],
    broadcast: (payload) => events.push(payload)
  });
  const input = {
    sessionId: 'manual-pair',
    turnId: 'pair-1',
    anchorLanguage: 'ja-JP',
    partnerLanguage: 'es-ES',
    inputSource: 'browser'
  };

  const result = await pipeline.setSessionPair(input);
  assert.equal(result.manual, true);
  assert.equal(result.state.anchorLanguage, 'ja');
  assert.equal(result.state.partnerLanguage, 'es');
  assert.equal(result.state.revision, 1);
  assert.equal(result.audioEndpoint, 'browser');
  assert.equal(result.pairAnnouncement.status, 'queued');
  assert.equal(pipeline.getSessionSnapshot('manual-pair').latestTurn, null);
  assert.deepEqual(
    fixture.ttsPayloads.map(({ purpose, queueMode, language }) => ({
      purpose,
      queueMode,
      language
    })),
    [
      {
        purpose: 'language_pair_announcement',
        queueMode: 'replace',
        language: 'ja'
      },
      {
        purpose: 'language_pair_announcement',
        queueMode: 'append',
        language: 'es'
      }
    ]
  );
  assert.equal(
    events.filter((event) => event.type === 'interpreter_state_changed').length,
    1
  );

  const duplicate = await pipeline.setSessionPair(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(fixture.ttsPayloads.length, 2);

  const unchanged = await pipeline.setSessionPair({
    ...input,
    turnId: 'pair-2'
  });
  assert.equal(unchanged.state.revision, 1);
  assert.equal(unchanged.pairAnnouncement.reason, 'pair_unchanged');
  assert.equal(fixture.ttsPayloads.length, 2);

  const translated = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'manual-pair',
    turnId: 'speech-1'
  });
  assert.equal(translated.sourceLanguage, 'es');
  assert.equal(translated.targetLanguage, 'ja');
  assert.equal(
    pipeline.getSessionSnapshot('manual-pair').latestTurn.turnId,
    'speech-1'
  );
});

test('manual pair validates complete, distinct, supported languages', async () => {
  const fixture = providers();
  const pipeline = createInterpreterPipeline({
    ...fixture,
    supportedPairLanguages: ['en', 'es', 'ja']
  });
  await assert.rejects(
    pipeline.setSessionPair({
      sessionId: 'manual-validation',
      turnId: 'missing-anchor',
      partnerLanguage: 'es'
    }),
    (error) => error.code === 'anchor_language_required' && error.statusCode === 400
  );
  await assert.rejects(
    pipeline.setSessionPair({
      sessionId: 'manual-validation',
      turnId: 'same',
      anchorLanguage: 'es',
      partnerLanguage: 'es'
    }),
    (error) => error.code === 'pair_languages_must_differ' && error.statusCode === 422
  );
  await assert.rejects(
    pipeline.setSessionPair({
      sessionId: 'manual-validation',
      turnId: 'unsupported',
      anchorLanguage: 'es',
      partnerLanguage: 'zh'
    }),
    (error) => error.code === 'unsupported_pair_language' && error.statusCode === 422
  );
  assert.deepEqual(fixture.calls, []);
});

test('manual pair announcement follows current Atom presence', async () => {
  const fixture = providers();
  const pipeline = createInterpreterPipeline({
    ...fixture,
    supportedPairLanguages: ['en', 'es'],
    atomRegistry: {
      getPresence() {
        return { connected: true, endpoint: 'atom' };
      }
    }
  });
  const result = await pipeline.setSessionPair({
    sessionId: 'atom:one',
    turnId: 'manual-atom',
    anchorLanguage: 'es',
    partnerLanguage: 'en',
    inputSource: 'browser'
  });
  assert.equal(result.audioEndpoint, 'atom');
  assert.equal(fixture.ttsPayloads.every((entry) => entry.audioEndpoint === 'atom'), true);
});

test('first English in the browser is transcript-only and does not call translation or TTS', async () => {
  const fixture = providers({
    asr: {
      async transcribe() {
        fixture.calls.push('asr');
        return {
          text: 'Good morning',
          language: 'en',
          languageEvidence: { tagObserved: true, speechMs: 900 }
        };
      }
    }
  });
  const pipeline = createInterpreterPipeline(fixture);
  const result = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'english',
    turnId: 'turn-1'
  });
  assert.deepEqual(fixture.calls, ['asr', 'intent']);
  assert.equal(result.targetLanguage, null);
  assert.deepEqual(result.warnings, ['target_required']);
  assert.equal(result.state.anchorLanguage, 'en');
  assert.equal(result.state.partnerLanguage, null);
});

test('first English on Atom asks for a target once, then accepts a spoken target', async () => {
  const asrResults = [
    {
      text: 'Good morning',
      language: 'en',
      languageEvidence: { tagObserved: true, speechMs: 900 }
    },
    {
      text: 'How are you?',
      language: 'en',
      languageEvidence: { tagObserved: true, speechMs: 900 }
    },
    {
      text: 'Translate into Japanese',
      language: 'en',
      languageEvidence: { tagObserved: true, speechMs: 900 }
    },
    {
      text: 'Where is the station?',
      language: 'en',
      languageEvidence: { tagObserved: true, speechMs: 900 }
    }
  ];
  const ttsPayloads = [];
  const events = [];
  const fixture = providers({
    asr: {
      async transcribe() {
        fixture.calls.push('asr');
        return asrResults.shift();
      }
    },
    intent: {
      async analyze(input) {
        fixture.calls.push('intent');
        if (input.transcript === 'Translate into Japanese') {
          return {
            contentText: '',
            requestedTargetLanguage: 'ja',
            commandOnly: true
          };
        }
        return {
          contentText: input.transcript,
          requestedTargetLanguage: null,
          commandOnly: false
        };
      }
    },
    tts: {
      async enqueue(payload) {
        fixture.calls.push('tts');
        ttsPayloads.push(payload);
        return { accepted: true, generation: ttsPayloads.length };
      }
    }
  });
  const pipeline = createInterpreterPipeline({
    ...fixture,
    broadcast: (payload) => events.push(payload)
  });

  const first = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'english-atom',
    turnId: 'first',
    inputSource: 'atom'
  });
  assert.equal(first.targetLanguage, null);
  assert.equal(first.state.anchorLanguage, 'en');
  assert.equal(first.state.partnerLanguage, null);
  assert.deepEqual(first.warnings, ['target_required']);
  assert.deepEqual(first.tts, {
    status: 'queued',
    purpose: 'target_language_prompt',
    language: 'en',
    audioEndpoint: 'atom',
    generation: 1
  });
  assert.deepEqual(ttsPayloads[0], {
    text: 'What language should I translate into?',
    language: 'en',
    sessionId: 'english-atom',
    turnId: 'first',
    audioEndpoint: 'atom',
    purpose: 'target_language_prompt'
  });
  assert.equal(
    events.some((event) =>
      event.type === 'interpreter_target_prompt'
      && event.audioEndpoint === 'atom'
    ),
    true
  );

  const repeated = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'english-atom',
    turnId: 'repeated',
    inputSource: 'atom'
  });
  assert.equal(repeated.tts.status, 'skipped');
  assert.equal(ttsPayloads.length, 1);

  const command = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'english-atom',
    turnId: 'target',
    inputSource: 'atom'
  });
  assert.equal(command.commandOnly, true);
  assert.equal(command.state.anchorLanguage, 'en');
  assert.equal(command.state.partnerLanguage, 'ja');
  assert.equal(command.pairAnnouncement.status, 'queued');
  assert.equal(command.pairAnnouncement.revision, 2);
  assert.deepEqual(
    command.pairAnnouncement.utterances.map(({ language, text, status }) => ({
      language,
      text,
      status
    })),
    [
      {
        language: 'en',
        text: 'Now: English and Japanese.',
        status: 'queued'
      },
      {
        language: 'ja',
        text: '英語と日本語に切り替えます。',
        status: 'queued'
      }
    ]
  );
  assert.equal(ttsPayloads.length, 3);
  assert.equal(ttsPayloads[1].purpose, 'language_pair_announcement');
  assert.equal(ttsPayloads[1].queueMode, 'replace');
  assert.equal(ttsPayloads[2].purpose, 'language_pair_announcement');
  assert.equal(ttsPayloads[2].queueMode, 'append');

  const translated = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'english-atom',
    turnId: 'translated',
    inputSource: 'atom'
  });
  assert.equal(translated.targetLanguage, 'ja');
  assert.equal(translated.pairAnnouncement.status, 'skipped');
  assert.equal(translated.pairAnnouncement.reason, 'pair_unchanged');
  assert.equal(ttsPayloads.length, 4);
  assert.equal(ttsPayloads[3].language, 'ja');
  assert.equal(ttsPayloads[3].audioEndpoint, 'atom');
  assert.equal(ttsPayloads[3].purpose, 'translation');
  assert.equal(ttsPayloads[3].queueMode, 'replace');
});

test('explicit target command changes Spanish/English into Spanish/Japanese', async () => {
  const asrResults = [
    {
      text: 'Buenos días',
      language: 'es',
      languageEvidence: { tagObserved: true, speechMs: 900 }
    },
    {
      text: '日本語にして',
      language: 'ja',
      languageEvidence: { tagObserved: true, speechMs: 600 }
    },
    {
      text: '¿Dónde está la estación?',
      language: 'es',
      languageEvidence: { tagObserved: true, speechMs: 900 }
    },
    {
      text: '駅はどこですか？',
      language: 'ja',
      languageEvidence: { tagObserved: true, speechMs: 900 }
    }
  ];
  const fixture = providers({
    asr: {
      async transcribe() {
        fixture.calls.push('asr');
        return asrResults.shift();
      }
    },
    intent: {
      async analyze(input) {
        fixture.calls.push('intent');
        if (input.transcript === '日本語にして') {
          return {
            contentText: '',
            requestedTargetLanguage: 'ja',
            commandOnly: true
          };
        }
        return {
          contentText: input.transcript,
          requestedTargetLanguage: null,
          commandOnly: false
        };
      }
    }
  });
  const pipeline = createInterpreterPipeline(fixture);
  const first = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'pair',
    turnId: 'spanish',
    inputSource: 'browser'
  });
  assert.equal(first.targetLanguage, 'en');
  assert.equal(first.state.anchorLanguage, 'es');
  assert.equal(first.state.partnerLanguage, 'en');

  const command = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'pair',
    turnId: 'command',
    inputSource: 'browser'
  });
  assert.equal(command.commandOnly, true);
  assert.equal(command.targetLanguage, null);
  assert.equal(command.state.anchorLanguage, 'es');
  assert.equal(command.state.partnerLanguage, 'ja');
  assert.equal(command.pairAnnouncement.status, 'queued');
  assert.deepEqual(
    command.pairAnnouncement.utterances.map((entry) => entry.language),
    ['es', 'ja']
  );

  const fromSpanish = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'pair',
    turnId: 'spanish-after-command',
    inputSource: 'browser'
  });
  assert.equal(fromSpanish.targetLanguage, 'ja');

  const fromJapanese = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'pair',
    turnId: 'japanese-after-command',
    inputSource: 'browser'
  });
  assert.equal(fromJapanese.targetLanguage, 'es');
});

test('a clear Spanish reply immediately changes a Japanese/English conversation to Japanese/Spanish', async () => {
  const turns = [
    { text: 'こんにちは', language: 'ja', speechMs: 900 },
    {
      text: 'Estoy bien, gracias. ¿Y usted?',
      language: 'es',
      speechMs: 1_600
    },
    {
      text: 'とても元気です。あなたはどうですか？',
      language: 'ja',
      speechMs: 1_700
    }
  ];
  const translations = new Map([
    ['こんにちは:en', 'Hello.'],
    ['Estoy bien, gracias. ¿Y usted?:ja', '元気です、ありがとう。あなたは？'],
    ['とても元気です。あなたはどうですか？:es', 'Estoy muy bien. ¿Y usted?']
  ]);
  const fixture = providers({
    asr: {
      async transcribe() {
        fixture.calls.push('asr');
        const turn = turns.shift();
        return {
          text: turn.text,
          language: turn.language,
          languageEvidence: {
            tagObserved: true,
            speechMs: turn.speechMs,
            contentGraphemeCount: [...turn.text].length
          }
        };
      }
    },
    translation: {
      async translate(input) {
        fixture.calls.push('translation');
        return {
          translation: translations.get(`${input.contentText}:${input.targetLanguage}`)
        };
      }
    }
  });
  const pipeline = createInterpreterPipeline(fixture);

  const greeting = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'implicit-ja-es',
    turnId: 'greeting'
  });
  assert.equal(greeting.translation, 'Hello.');
  assert.deepEqual(
    [greeting.state.anchorLanguage, greeting.state.partnerLanguage],
    ['ja', 'en']
  );

  const spanish = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'implicit-ja-es',
    turnId: 'spanish-reply'
  });
  assert.equal(spanish.translation, '元気です、ありがとう。あなたは？');
  assert.equal(spanish.targetLanguage, 'ja');
  assert.deepEqual(spanish.warnings, []);
  assert.deepEqual(
    [spanish.state.anchorLanguage, spanish.state.partnerLanguage],
    ['ja', 'es']
  );
  assert.equal(spanish.pairAnnouncement.status, 'queued');
  assert.deepEqual(
    fixture.ttsPayloads.slice(1, 4).map(({ purpose, queueMode, language }) => ({
      purpose,
      queueMode,
      language
    })),
    [
      {
        purpose: 'language_pair_announcement',
        queueMode: 'replace',
        language: 'ja'
      },
      {
        purpose: 'language_pair_announcement',
        queueMode: 'append',
        language: 'es'
      },
      {
        purpose: 'translation',
        queueMode: 'append',
        language: 'ja'
      }
    ]
  );

  const japanese = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'implicit-ja-es',
    turnId: 'japanese-reply'
  });
  assert.equal(japanese.translation, 'Estoy muy bien. ¿Y usted?');
  assert.equal(japanese.targetLanguage, 'es');
  assert.equal(japanese.pairAnnouncement.status, 'skipped');
  assert.equal(japanese.pairAnnouncement.reason, 'pair_unchanged');
  assert.equal(
    fixture.ttsPayloads.filter(
      (payload) => payload.purpose === 'language_pair_announcement'
    ).length,
    2
  );
});

test('an uncertain third language waits for repetition before announcing the pair', async () => {
  const turns = [
    {
      text: 'こんにちは',
      language: 'ja',
      languageEvidence: {
        tagObserved: true,
        speechMs: 900,
        contentGraphemeCount: 5
      }
    },
    {
      text: 'Sí',
      language: 'es',
      languageEvidence: {
        tagObserved: false,
        confidence: 0.2,
        speechMs: 200,
        contentGraphemeCount: 2
      }
    },
    {
      text: 'Sí',
      language: 'es',
      languageEvidence: {
        tagObserved: false,
        confidence: 0.2,
        speechMs: 200,
        contentGraphemeCount: 2
      }
    }
  ];
  const fixture = providers({
    asr: {
      async transcribe() {
        fixture.calls.push('asr');
        return turns.shift();
      }
    },
    translation: {
      async translate(input) {
        fixture.calls.push('translation');
        return {
          translation: input.targetLanguage === 'en' ? 'Hello.' : 'はい。'
        };
      }
    }
  });
  const pipeline = createInterpreterPipeline(fixture);

  await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'repeated-third-language',
    turnId: 'initial'
  });
  const uncertain = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'repeated-third-language',
    turnId: 'uncertain'
  });
  assert.deepEqual(uncertain.warnings, ['language_uncertain']);
  assert.equal(uncertain.pairAnnouncement.status, 'skipped');
  assert.equal(uncertain.pairAnnouncement.reason, 'pair_unchanged');
  assert.equal(
    fixture.ttsPayloads.filter(
      (payload) => payload.purpose === 'language_pair_announcement'
    ).length,
    0
  );

  const accepted = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'repeated-third-language',
    turnId: 'accepted'
  });
  assert.equal(accepted.targetLanguage, 'ja');
  assert.deepEqual(
    [accepted.state.anchorLanguage, accepted.state.partnerLanguage],
    ['ja', 'es']
  );
  assert.equal(accepted.pairAnnouncement.status, 'queued');
  assert.equal(
    fixture.ttsPayloads.filter(
      (payload) => payload.purpose === 'language_pair_announcement'
    ).length,
    2
  );
});

test('a content-bearing Japanese switch from English to Spanish uses the new target immediately', async () => {
  const modelBodies = [];
  const modelResponses = [
    {
      content_text: 'こんばんは。',
      requested_target_language: 'es',
      command_only: false,
      candidate_target_language: 'es',
      candidate_translation: 'Good evening.'
    },
    { translation: 'Buenas noches.' }
  ];
  const gemma = createGemma4InterpreterProviders({
    acceptExternalTranscripts: true,
    fetchImpl: async (_url, options) => {
      modelBodies.push(JSON.parse(options.body));
      return openAiResponse(modelResponses.shift());
    }
  });
  const ttsPayloads = [];
  const pipeline = createInterpreterPipeline({
    asr: {
      async transcribe() {
        return {
          text: 'こんばんは。スペイン語に切り替えてください',
          language: 'ja',
          languageEvidence: {
            tagObserved: true,
            speechMs: 1_500,
            contentGraphemeCount: 22
          }
        };
      }
    },
    intent: gemma.intent,
    translation: gemma.translation,
    tts: {
      async enqueue(payload) {
        ttsPayloads.push(payload);
        return { accepted: true, generation: ttsPayloads.length };
      }
    },
    atomRegistry: {
      getPresence() {
        return { connected: true };
      }
    },
    supportedPairLanguages: ['en', 'es', 'ja']
  });

  await pipeline.setSessionPair({
    sessionId: 'switch-ja-en-to-ja-es',
    turnId: 'manual-ja-en',
    anchorLanguage: 'ja',
    partnerLanguage: 'en',
    inputSource: 'atom'
  });
  ttsPayloads.length = 0;

  const result = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'switch-ja-en-to-ja-es',
    turnId: 'switch-to-es',
    inputSource: 'atom'
  });

  assert.equal(result.contentText, 'こんばんは。');
  assert.equal(result.targetLanguage, 'es');
  assert.equal(result.translation, 'Buenas noches.');
  assert.deepEqual(
    [result.state.anchorLanguage, result.state.partnerLanguage],
    ['ja', 'es']
  );
  assert.equal(modelBodies.length, 2);
  assert.match(modelBodies[1].messages[0].content, /from ja to es/u);
  assert.deepEqual(
    ttsPayloads.map(({ language, purpose, queueMode }) => ({
      language,
      purpose,
      queueMode
    })),
    [
      {
        language: 'ja',
        purpose: 'language_pair_announcement',
        queueMode: 'replace'
      },
      {
        language: 'es',
        purpose: 'language_pair_announcement',
        queueMode: 'append'
      },
      {
        language: 'es',
        purpose: 'translation',
        queueMode: 'append'
      }
    ]
  );
  assert.equal(ttsPayloads.at(-1).text, 'Buenas noches.');
});

test('a target instruction attached to content establishes Japanese/Spanish immediately', async () => {
  const turns = [
    {
      text: 'こんにちは。スペイン語に翻訳して',
      language: 'ja',
      speechMs: 1_500
    },
    {
      text: 'Estoy bien, gracias. ¿Y usted?',
      language: 'es',
      speechMs: 1_600
    },
    {
      text: 'とても元気です。あなたはどうですか？',
      language: 'ja',
      speechMs: 1_700
    }
  ];
  const ttsPayloads = [];
  const fixture = providers({
    asr: {
      async transcribe() {
        fixture.calls.push('asr');
        const turn = turns.shift();
        return {
          text: turn.text,
          language: turn.language,
          languageEvidence: {
            tagObserved: true,
            speechMs: turn.speechMs,
            contentGraphemeCount: [...turn.text].length
          }
        };
      }
    },
    intent: {
      async analyze(input) {
        fixture.calls.push('intent');
        if (input.transcript === 'こんにちは。スペイン語に翻訳して') {
          return {
            contentText: 'こんにちは',
            requestedTargetLanguage: 'es',
            commandOnly: false
          };
        }
        return {
          contentText: input.transcript,
          requestedTargetLanguage: null,
          commandOnly: false
        };
      }
    },
    translation: {
      async translate(input) {
        fixture.calls.push('translation');
        const key = `${input.contentText}:${input.targetLanguage}`;
        return {
          translation: {
            'こんにちは:es': 'Hola, ¿cómo está?',
            'Estoy bien, gracias. ¿Y usted?:ja': '元気です、ありがとう。あなたは？',
            'とても元気です。あなたはどうですか？:es': 'Estoy muy bien. ¿Y usted?'
          }[key]
        };
      }
    },
    tts: {
      async enqueue(payload) {
        fixture.calls.push('tts');
        ttsPayloads.push(payload);
        return { accepted: true, generation: ttsPayloads.length };
      }
    }
  });
  const pipeline = createInterpreterPipeline(fixture);

  const instructed = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'explicit-ja-es',
    turnId: 'instructed-greeting'
  });
  assert.equal(instructed.contentText, 'こんにちは');
  assert.equal(instructed.translation, 'Hola, ¿cómo está?');
  assert.equal(instructed.targetLanguage, 'es');
  assert.deepEqual(
    [instructed.state.anchorLanguage, instructed.state.partnerLanguage],
    ['ja', 'es']
  );
  assert.equal(instructed.pairAnnouncement.status, 'queued');
  assert.deepEqual(
    ttsPayloads.map(({ purpose, queueMode, language }) => ({
      purpose,
      queueMode,
      language
    })),
    [
      {
        purpose: 'language_pair_announcement',
        queueMode: 'replace',
        language: 'ja'
      },
      {
        purpose: 'language_pair_announcement',
        queueMode: 'append',
        language: 'es'
      },
      {
        purpose: 'translation',
        queueMode: 'append',
        language: 'es'
      }
    ]
  );

  const duplicate = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'explicit-ja-es',
    turnId: 'instructed-greeting'
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(ttsPayloads.length, 3);

  const spanish = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'explicit-ja-es',
    turnId: 'spanish-reply'
  });
  assert.equal(spanish.targetLanguage, 'ja');
  assert.equal(spanish.translation, '元気です、ありがとう。あなたは？');

  const japanese = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'explicit-ja-es',
    turnId: 'japanese-reply'
  });
  assert.equal(japanese.targetLanguage, 'es');
  assert.equal(japanese.translation, 'Estoy muy bien. ¿Y usted?');
});

test('translation failure does not commit a proposed pair change', async () => {
  const fixture = providers({
    translation: {
      async translate() {
        fixture.calls.push('translation');
        throw new Error('offline');
      }
    }
  });
  const pipeline = createInterpreterPipeline(fixture);
  await assert.rejects(
    pipeline.processTurn({
      audio: Buffer.from('wav'),
      sessionId: 'fail',
      turnId: 'turn-1'
    }),
    (error) => error.code === 'translation_failed'
  );
  assert.equal(pipeline.getSessionState('fail').revision, 0);
  assert.equal(pipeline.getSessionState('fail').anchorLanguage, null);
  assert.equal(fixture.ttsPayloads.length, 0);
});

test('one unsupported pair announcement does not block its partner or translation', async () => {
  const ttsPayloads = [];
  const fixture = providers({
    asr: {
      async transcribe() {
        fixture.calls.push('asr');
        return {
          text: 'こんにちは。スペイン語に翻訳して',
          language: 'ja',
          languageEvidence: {
            tagObserved: true,
            speechMs: 1_500,
            contentGraphemeCount: 17
          }
        };
      }
    },
    intent: {
      async analyze() {
        fixture.calls.push('intent');
        return {
          contentText: 'こんにちは',
          requestedTargetLanguage: 'es',
          commandOnly: false
        };
      }
    },
    translation: {
      async translate() {
        fixture.calls.push('translation');
        return { translation: 'Hola.' };
      }
    },
    tts: {
      async enqueue(payload) {
        fixture.calls.push('tts');
        ttsPayloads.push(payload);
        if (
          payload.purpose === 'language_pair_announcement'
          && payload.language === 'ja'
        ) {
          return { accepted: false, reason: 'unsupported_language' };
        }
        return { accepted: true, generation: ttsPayloads.length };
      }
    }
  });
  const pipeline = createInterpreterPipeline(fixture);
  const result = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'partial-announcement',
    turnId: 'turn-1'
  });

  assert.equal(result.translation, 'Hola.');
  assert.equal(result.pairAnnouncement.status, 'partial');
  assert.equal(result.pairAnnouncement.queuedCount, 1);
  assert.deepEqual(
    result.pairAnnouncement.utterances.map((entry) => entry.status),
    ['unsupported', 'queued']
  );
  assert.deepEqual(
    ttsPayloads.map(({ purpose, queueMode, language }) => ({
      purpose,
      queueMode,
      language
    })),
    [
      {
        purpose: 'language_pair_announcement',
        queueMode: 'replace',
        language: 'ja'
      },
      {
        purpose: 'language_pair_announcement',
        queueMode: 'replace',
        language: 'es'
      },
      {
        purpose: 'translation',
        queueMode: 'append',
        language: 'es'
      }
    ]
  );
  assert.equal(result.tts.status, 'queued');
});

test('one failed pair announcement does not block its partner or translation', async () => {
  const ttsPayloads = [];
  const fixture = providers({
    asr: {
      async transcribe() {
        return {
          text: 'Translate this into Spanish',
          language: 'en',
          languageEvidence: {
            tagObserved: true,
            speechMs: 1_200,
            contentGraphemeCount: 27
          }
        };
      }
    },
    intent: {
      async analyze() {
        return {
          contentText: 'This',
          requestedTargetLanguage: 'es',
          commandOnly: false
        };
      }
    },
    translation: {
      async translate() {
        return { translation: 'Esto.' };
      }
    },
    tts: {
      async enqueue(payload) {
        ttsPayloads.push(payload);
        if (
          payload.purpose === 'language_pair_announcement'
          && payload.language === 'en'
        ) {
          throw new Error('fixture synthesis failure');
        }
        return { accepted: true, generation: ttsPayloads.length };
      }
    }
  });
  const pipeline = createInterpreterPipeline({
    ...fixture,
    log: { info: () => {}, warn: () => {}, error: () => {} }
  });
  const result = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'failed-announcement',
    turnId: 'turn-1'
  });

  assert.equal(result.translation, 'Esto.');
  assert.equal(result.pairAnnouncement.status, 'partial');
  assert.deepEqual(
    result.pairAnnouncement.utterances.map((entry) => entry.status),
    ['failed', 'queued']
  );
  assert.deepEqual(
    ttsPayloads.map((payload) => payload.purpose),
    [
      'language_pair_announcement',
      'language_pair_announcement',
      'translation'
    ]
  );
  assert.equal(ttsPayloads[2].queueMode, 'append');
  assert.equal(result.tts.status, 'queued');
});

test('TTS failure preserves translation and committed pair state', async () => {
  const fixture = providers({
    tts: {
      async enqueue() {
        fixture.calls.push('tts');
        throw new Error('speaker unavailable');
      }
    }
  });
  const pipeline = createInterpreterPipeline(fixture);
  const result = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'tts-fail',
    turnId: 'turn-1'
  });
  assert.equal(result.translation, 'Hello');
  assert.equal(result.tts.status, 'failed');
  assert.equal(result.state.revision, 1);
});

test('unsupported TTS language keeps the translation without a wrong-language fallback', async () => {
  const fixture = providers({
    tts: {
      async enqueue() {
        fixture.calls.push('tts');
        return { accepted: false, reason: 'unsupported_language' };
      }
    }
  });
  const events = [];
  const pipeline = createInterpreterPipeline({
    ...fixture,
    broadcast: (payload) => events.push(payload)
  });
  const result = await pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'tts-unsupported',
    turnId: 'turn-1'
  });
  assert.equal(result.translation, 'Hello');
  assert.equal(result.tts.status, 'unsupported');
  assert.equal(result.tts.reason, 'unsupported_language');
  assert.equal(result.state.revision, 1);
  assert.equal(
    events.some((event) => event.type === 'interpreter_tts_unsupported'),
    true
  );
});

test('Atom presence latches Atom output for the whole turn', async () => {
  let resolveTranslation;
  const translationWait = new Promise((resolve) => {
    resolveTranslation = resolve;
  });
  const registry = createAtomEndpointRegistry();
  const socket = {};
  registry.observeDirectFrame({ socket, deviceId: 'atom-one' });
  const ttsPayloads = [];
  const fixture = providers({
    translation: {
      async translate() {
        fixture.calls.push('translation');
        await translationWait;
        return { translation: 'Hello' };
      }
    },
    tts: {
      async enqueue(payload) {
        fixture.calls.push('tts');
        ttsPayloads.push(payload);
        return { accepted: true };
      }
    }
  });
  const pipeline = createInterpreterPipeline({ ...fixture, atomRegistry: registry });
  const promise = pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'atom',
    turnId: 'turn-1',
    inputSource: 'atom'
  });
  registry.forgetSocket(socket);
  resolveTranslation();
  const result = await promise;
  assert.equal(result.audioEndpoint, 'atom');
  assert.equal(ttsPayloads[0].audioEndpoint, 'atom');
});

test('different concurrent turn in one session is rejected with 409', async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = providers({
    asr: {
      async transcribe() {
        await wait;
        return {
          text: 'Hola',
          language: 'es',
          languageEvidence: { tagObserved: true, speechMs: 900 }
        };
      }
    }
  });
  const pipeline = createInterpreterPipeline(fixture);
  const first = pipeline.processTurn({
    audio: Buffer.from('wav'),
    sessionId: 'busy',
    turnId: 'one'
  });
  await assert.rejects(
    pipeline.processTurn({
      audio: Buffer.from('wav'),
      sessionId: 'busy',
      turnId: 'two'
    }),
    (error) => error.statusCode === 409 && error.code === 'turn_in_progress'
  );
  await assert.rejects(
    pipeline.setSessionPair({
      sessionId: 'busy',
      turnId: 'pair-two',
      anchorLanguage: 'ja',
      partnerLanguage: 'es'
    }),
    (error) => error.statusCode === 409 && error.code === 'turn_in_progress'
  );
  release();
  await first;
});
