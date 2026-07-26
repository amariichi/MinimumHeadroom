import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInterpreterPairAnnouncements
} from '../../face-app/dist/interpreter_pair_announcement.js';
import {
  interpreterTtsSupportedLanguages
} from '../../face-app/dist/interpreter_tts_support.js';

test('pair announcements localize one short utterance in each language', () => {
  assert.deepEqual(
    createInterpreterPairAnnouncements({
      anchorLanguage: 'ja',
      partnerLanguage: 'es'
    }),
    [
      {
        language: 'ja',
        text: '日本語とスペイン語に切り替えます。'
      },
      {
        language: 'es',
        text: 'Ahora, japonés y español.'
      }
    ]
  );
});

test('pair announcements preserve anchor order in both localized utterances', () => {
  assert.deepEqual(
    createInterpreterPairAnnouncements({
      anchorLanguage: 'en-US',
      partnerLanguage: 'ja-JP'
    }),
    [
      {
        language: 'en',
        text: 'Now: English and Japanese.'
      },
      {
        language: 'ja',
        text: '英語と日本語に切り替えます。'
      }
    ]
  );
});

test('pair announcements use localized names without a model for other languages', () => {
  const announcements = createInterpreterPairAnnouncements({
    anchorLanguage: 'ar',
    partnerLanguage: 'uk'
  });
  assert.deepEqual(announcements.map((entry) => entry.language), ['ar', 'uk']);
  assert.equal(announcements.every((entry) => entry.text.length > 4), true);
});

test('pair announcements require a complete pair of different languages', () => {
  assert.deepEqual(
    createInterpreterPairAnnouncements({ anchorLanguage: 'ja' }),
    []
  );
  assert.deepEqual(
    createInterpreterPairAnnouncements({
      anchorLanguage: 'ja',
      partnerLanguage: 'ja'
    }),
    []
  );
});

test('pair announcements cover every declared Supertonic and Qwen3 language', () => {
  for (const engine of ['supertonic', 'qwen3']) {
    const supported = interpreterTtsSupportedLanguages(engine);
    assert.ok(supported.length > 0);
    for (const language of supported) {
      const counterpart = language === 'en' ? 'ja' : 'en';
      const announcements = createInterpreterPairAnnouncements({
        anchorLanguage: language,
        partnerLanguage: counterpart
      });
      assert.deepEqual(
        announcements.map((entry) => entry.language),
        [language, counterpart],
        `${engine} ${language} must produce both language-hinted utterances`
      );
      assert.equal(
        announcements.every((entry) => entry.text.trim().length > 3),
        true,
        `${engine} ${language} must have non-empty localized announcement text`
      );
    }
  }
});
