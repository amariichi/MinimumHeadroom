import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pcmFrames,
  validateInterpreterEvents
} from '../../scripts/atom-interpreter-replay.mjs';

test('Atom interpreter replay pads the final firmware-sized PCM frame', () => {
  const pcm = Buffer.alloc(10);
  pcm.writeInt16LE(1234, 0);
  const frames = pcmFrames(pcm, 4);

  assert.equal(frames.length, 2);
  assert.equal(frames[0].length, 8);
  assert.equal(frames[1].length, 8);
  assert.equal(frames[0].readInt16LE(0), 1234);
  assert.deepEqual(frames[1].subarray(2), Buffer.alloc(6));
});

test('Atom interpreter replay validates one translated Atom turn', () => {
  const events = [
    {
      type: 'interpreter_turn_started',
      sessionId: 'atom:test',
      turnId: 'turn-1',
      audioEndpoint: 'atom'
    },
    {
      type: 'interpreter_transcript',
      sessionId: 'atom:test',
      turnId: 'turn-1',
      transcript: 'Hola, ¿dónde está la estación?',
      sourceLanguage: 'es'
    },
    {
      type: 'interpreter_translation',
      sessionId: 'atom:test',
      turnId: 'turn-1',
      translation: 'Hello, where is the station?',
      sourceLanguage: 'es',
      targetLanguage: 'en',
      audioEndpoint: 'atom'
    }
  ];

  const result = validateInterpreterEvents({
    events,
    expectedSessionId: 'atom:test',
    expectedSource: 'es',
    expectedTarget: 'en'
  });

  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.audioEndpoint, 'atom');
  assert.deepEqual(result.eventCounts, {
    started: 1,
    transcripts: 1,
    translations: 1,
    stateChanges: 0,
    failures: 0
  });
});

test('Atom interpreter replay rejects browser routing and duplicate turns', () => {
  const base = [
    {
      type: 'interpreter_turn_started',
      sessionId: 'atom:test',
      turnId: 'turn-1',
      audioEndpoint: 'atom'
    },
    {
      type: 'interpreter_transcript',
      sessionId: 'atom:test',
      turnId: 'turn-1',
      transcript: 'Hola',
      sourceLanguage: 'es'
    },
    {
      type: 'interpreter_translation',
      sessionId: 'atom:test',
      turnId: 'turn-1',
      translation: 'Hello',
      sourceLanguage: 'es',
      targetLanguage: 'en',
      audioEndpoint: 'browser'
    }
  ];

  assert.throws(
    () => validateInterpreterEvents({
      events: base,
      expectedSessionId: 'atom:test',
      expectedSource: 'es',
      expectedTarget: 'en'
    }),
    /expected atom/
  );

  assert.throws(
    () => validateInterpreterEvents({
      events: [base[0], { ...base[0], turnId: 'turn-2' }, ...base.slice(1)],
      expectedSessionId: 'atom:test',
      expectedSource: 'es',
      expectedTarget: 'en'
    }),
    /expected one started turn/
  );
});
