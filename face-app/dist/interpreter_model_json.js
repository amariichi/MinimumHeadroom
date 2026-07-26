function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function parseInterpreterModelJson(value) {
  const content = asNonEmptyString(value);
  if (!content) {
    return null;
  }
  const candidates = [content];
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }
  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(content.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Continue through bounded JSON representations.
    }
  }
  return null;
}

export function extractOpenAiAssistantText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        return typeof part?.text === 'string' ? part.text : '';
      })
      .join('');
  }
  return typeof payload?.choices?.[0]?.text === 'string'
    ? payload.choices[0].text
    : null;
}

export function resolveOpenAiChatCompletionsUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const url = new URL(value.trim());
  const path = url.pathname.replace(/\/+$/u, '');
  if (!path.endsWith('/chat/completions')) {
    url.pathname = `${path}/chat/completions`.replace(/\/{2,}/gu, '/');
  }
  return url;
}
