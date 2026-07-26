import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInterpreterSessionStore,
  createInterpreterState,
  resolveInterpreterTurnState
} from '../../face-app/dist/interpreter_state.js';

function resolve(currentState, observation, options = {}) {
  return resolveInterpreterTurnState({
    currentState,
    nowMs: 1_000,
    ...observation
  }, options);
}

test('first Spanish speech targets English and establishes es/en', () => {
  const result = resolve({}, {
    sourceLanguage: 'es',
    contentText: 'Buenos días',
    languageEvidence: { tagObserved: true, speechMs: 900 }
  });
  assert.equal(result.targetLanguage, 'en');
  assert.equal(result.proposedState.anchorLanguage, 'es');
  assert.equal(result.proposedState.partnerLanguage, 'en');
  assert.deepEqual(result.warnings, []);
});

test('first English speech remains transcript-only until another target exists', () => {
  const result = resolve({}, {
    sourceLanguage: 'en',
    contentText: 'Good morning',
    languageEvidence: { tagObserved: true, speechMs: 900 }
  });
  assert.equal(result.targetLanguage, null);
  assert.equal(result.proposedState.anchorLanguage, 'en');
  assert.equal(result.proposedState.partnerLanguage, null);
  assert.deepEqual(result.warnings, ['target_required']);
});

test('explicit Japanese command updates Spanish/English to Spanish/Japanese', () => {
  const result = resolve(
    { anchorLanguage: 'es', partnerLanguage: 'en', revision: 1 },
    {
      sourceLanguage: 'ja',
      requestedTargetLanguage: 'ja',
      commandOnly: true,
      contentText: ''
    }
  );
  assert.equal(result.targetLanguage, null);
  assert.equal(result.proposedState.anchorLanguage, 'es');
  assert.equal(result.proposedState.partnerLanguage, 'ja');
  assert.equal(result.pairChanged, true);
});

test('established pair reverses according to detected source language', () => {
  const fromAnchor = resolve(
    { anchorLanguage: 'es', partnerLanguage: 'ja' },
    { sourceLanguage: 'es', contentText: '¿Dónde está la estación?' }
  );
  assert.equal(fromAnchor.targetLanguage, 'ja');

  const fromPartner = resolve(
    { anchorLanguage: 'es', partnerLanguage: 'ja' },
    { sourceLanguage: 'ja', contentText: '駅はどこですか？' }
  );
  assert.equal(fromPartner.targetLanguage, 'es');
});

test('short uncertain third language requires a repeated observation', () => {
  const first = resolveInterpreterTurnState({
    currentState: { anchorLanguage: 'ja', partnerLanguage: 'en', revision: 2 },
    sourceLanguage: 'ko',
    contentText: '네',
    nowMs: 10_000,
    languageEvidence: {
      tagObserved: true,
      confidence: 0.4,
      speechMs: 300,
      contentGraphemeCount: 1
    }
  });
  assert.deepEqual(first.warnings, ['language_uncertain']);
  assert.equal(first.proposedState.partnerLanguage, 'en');
  assert.equal(first.proposedState.pendingLanguageCandidate.language, 'ko');

  const second = resolveInterpreterTurnState({
    currentState: first.proposedState,
    sourceLanguage: 'ko',
    contentText: '네',
    nowMs: 35_000,
    languageEvidence: {
      tagObserved: true,
      confidence: 0.4,
      speechMs: 300,
      contentGraphemeCount: 1
    }
  });
  assert.deepEqual(second.warnings, []);
  assert.equal(second.proposedState.partnerLanguage, 'ko');
  assert.equal(second.targetLanguage, 'ja');
});

test('strong evidence accepts a third language at exact thresholds', () => {
  const duration = resolve(
    { anchorLanguage: 'ja', partnerLanguage: 'en' },
    {
      sourceLanguage: 'fr',
      contentText: 'bonjour',
      languageEvidence: { tagObserved: true, speechMs: 700, contentGraphemeCount: 3 }
    }
  );
  assert.equal(duration.proposedState.partnerLanguage, 'fr');
  assert.equal(duration.targetLanguage, 'ja');

  const graphemes = resolve(
    { anchorLanguage: 'ja', partnerLanguage: 'en' },
    {
      sourceLanguage: 'de',
      contentText: 'hallo',
      languageEvidence: { tagObserved: true, speechMs: 699, contentGraphemeCount: 4 }
    }
  );
  assert.equal(graphemes.proposedState.partnerLanguage, 'de');
});

test('session store increments pair revision once and caches duplicate turn responses', async () => {
  let nowMs = 1_000;
  const store = createInterpreterSessionStore({ now: () => nowMs });
  const result = await store.runExclusive('one', async (session) => {
    const proposed = createInterpreterState({
      anchorLanguage: 'es',
      partnerLanguage: 'en'
    });
    return session.commit(proposed, 'turn-1', { ok: true, translation: 'Hello' });
  });
  assert.equal(result.state.revision, 1);
  assert.equal(store.cachedTurn('one', 'turn-1').translation, 'Hello');

  const duplicate = await store.runExclusive('one', async (session) =>
    session.cachedTurn('turn-1')
  );
  assert.equal(duplicate.state.revision, 1);

  nowMs += 10;
  const reset = store.reset('one', 'reset-1');
  assert.equal(reset.state.revision, 2);
  assert.equal(store.cachedTurn('one', 'turn-1'), null);
  assert.deepEqual(store.reset('one', 'reset-1'), reset);
});

test('session state is isolated by session id', () => {
  const store = createInterpreterSessionStore();
  store.commit('a', { anchorLanguage: 'ja', partnerLanguage: 'en' }, 'a1', { ok: true });
  assert.equal(store.snapshot('a').anchorLanguage, 'ja');
  assert.equal(store.snapshot('b').anchorLanguage, null);
});

test('session store exposes only the latest completed speech turn for UI recovery', () => {
  const store = createInterpreterSessionStore();
  const speech = store.remember('one', 'speech-1', {
    ok: true,
    turnId: 'speech-1',
    transcript: 'Hola',
    sourceLanguage: 'es',
    targetLanguage: 'en',
    translation: 'Hello'
  });
  assert.equal(store.latestTurn('one'), speech);

  store.remember('one', 'pair-1', {
    ok: true,
    manual: true,
    turnId: 'pair-1'
  });
  assert.equal(store.latestTurn('one'), speech);

  store.reset('one', 'reset-1');
  assert.equal(store.latestTurn('one'), null);
  assert.equal(store.latestTurn('two'), null);
});

test('session store retains only four completed responses by default', () => {
  const store = createInterpreterSessionStore();
  for (let index = 1; index <= 5; index += 1) {
    store.remember('one', `speech-${index}`, {
      ok: true,
      turnId: `speech-${index}`,
      transcript: `input ${index}`,
      translation: `output ${index}`
    });
  }

  assert.equal(store.cachedTurn('one', 'speech-1'), null);
  assert.equal(store.cachedTurn('one', 'speech-2').translation, 'output 2');
  assert.equal(store.latestTurn('one').translation, 'output 5');
});
