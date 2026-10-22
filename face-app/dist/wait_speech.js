// Automatic speech uses reason categories and allowlisted identities only.
// Never interpolate a question, command, path, free-form label or tool input.
export function waitSpeechSubject(agentId, runtime, lang = 'en') {
  const provider = new Map([['codex', 'Codex'], ['claude', 'Claude'], ['antigravity', 'agy'], ['agy', 'agy']]).get(runtime) ?? '';
  const helper = /^helper-\d{1,6}$/.test(agentId ?? '') ? agentId : '';
  return [provider, helper].filter(Boolean).join(' ') || (lang === 'ja' ? 'エージェント' : 'Agent');
}

export function waitSpeechCategory(report) {
  if (report?.attention_kind === 'approval') return 'approval';
  if (report?.attention_kind === 'choice') return 'choice';
  if (report?.attention_kind === 'question' || report?.kind === 'question') return 'answer';
  return 'unknown';
}

export function waitSpeechLine(category, subject, lang = 'en') {
  const lines = {
    approval: { ja: `${subject} が実行の承認を待っています。`, en: `${subject} is waiting for approval.` },
    answer: { ja: `${subject} が回答を待っています。`, en: `${subject} is waiting for an answer.` },
    choice: { ja: `${subject} が選択を待っています。`, en: `${subject} is waiting for a choice.` },
    unknown: { ja: `${subject} の状態を確認してください。`, en: `Check ${subject}'s status if needed.` }
  };
  return (lines[category] ?? lines.unknown)[lang === 'ja' ? 'ja' : 'en'];
}

export function reportSpeechKey(report) {
  if (report?.source === 'mh_hook' && ['from_agent_id', 'session_id', 'request_id', 'tool_name'].every(field =>
    typeof report[field] === 'string' && report[field].trim())) {
    return JSON.stringify(['native-wait', report.from_agent_id, report.session_id, report.request_id, report.tool_name, report.kind]);
  }
  return report?.stream_id && report?.report_id
    ? JSON.stringify(['owner-wait', report.stream_id, report.report_id]) : null;
}
