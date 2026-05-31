const ACKS = {
  ja: {
    accepted: ['確認します。', '少々お待ちください。', '確認しますね。', 'はい、確認します。', 'はい、お待ちください。', '承知しました。', '確認してみます。', '少し待ってください。', '見てみます。', '受け取りました。'],
    heard: ['はい。', '聞いています。'],
    unclear: ['もう一度お願いします。']
  },
  en: {
    accepted: ['Checking.', 'One moment.', 'Let me check.', 'Checking now.', 'On it.', 'I will check.', 'Just a moment.', 'Got it.', 'I will take a look.', 'Received.'],
    heard: ['Yes.', 'I am listening.'],
    unclear: ['Please say that again.']
  }
};

export function normalizeAckLanguage(value, fallback = 'en') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized.startsWith('ja')) {
    return 'ja';
  }
  if (normalized.startsWith('en')) {
    return 'en';
  }
  return fallback === 'ja' ? 'ja' : 'en';
}

export function chooseFixedAck({ language, kind = 'accepted', index = 0 } = {}) {
  const normalizedLanguage = normalizeAckLanguage(language, 'en');
  const phrases = ACKS[normalizedLanguage]?.[kind] ?? ACKS[normalizedLanguage].accepted;
  const phraseIndex = Number.isFinite(index) ? Math.abs(Math.floor(index)) % phrases.length : 0;
  return {
    language: normalizedLanguage,
    kind,
    text: phrases[phraseIndex]
  };
}
