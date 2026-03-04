function clampIndex(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeOperatorTextSelection(currentText, selectionStart = null, selectionEnd = null) {
  const text = typeof currentText === 'string' ? currentText : '';
  const fallback = text.length;
  const rawStart = Number.isInteger(selectionStart) ? selectionStart : fallback;
  const rawEnd = Number.isInteger(selectionEnd) ? selectionEnd : rawStart;
  const start = clampIndex(rawStart, 0, text.length);
  const end = clampIndex(rawEnd, start, text.length);
  return { start, end };
}

export function resolveOperatorPrefixSeparator(prefixText, language = 'en') {
  if (prefixText === '' || /\s$/.test(prefixText)) {
    return '';
  }
  if (language === 'ja') {
    return /[A-Za-z0-9]$/.test(prefixText) ? ' ' : '';
  }
  return ' ';
}

export function resolveOperatorSuffixSeparator(insertedText, suffixText, language = 'en') {
  if (insertedText === '' || suffixText === '' || /^\s/.test(suffixText)) {
    return '';
  }
  if (/^[,.;:!?)}\]]/.test(suffixText)) {
    return '';
  }
  if (language === 'ja') {
    return /[A-Za-z0-9]$/.test(insertedText) && /^[A-Za-z0-9]/.test(suffixText) ? ' ' : '';
  }
  return ' ';
}

export function buildOperatorTextInsertion(currentText, insertedText, language = 'en', selectionStart = null, selectionEnd = null) {
  const text = typeof currentText === 'string' ? currentText : '';
  const content = typeof insertedText === 'string' ? insertedText : '';
  const selection = normalizeOperatorTextSelection(text, selectionStart, selectionEnd);
  const prefixText = text.slice(0, selection.start);
  const suffixText = text.slice(selection.end);
  const prefixSeparator = content === '' ? '' : resolveOperatorPrefixSeparator(prefixText, language);
  const suffixSeparator = content === '' ? '' : resolveOperatorSuffixSeparator(content, suffixText, language);
  const insertedSegment = `${prefixSeparator}${content}${suffixSeparator}`;
  const nextText = `${prefixText}${insertedSegment}${suffixText}`;
  const caret = prefixText.length + insertedSegment.length;

  return {
    text: nextText,
    selectionStart: selection.start,
    selectionEnd: selection.end,
    caretStart: caret,
    caretEnd: caret,
    prefixText,
    suffixText,
    prefixSeparator,
    suffixSeparator
  };
}
