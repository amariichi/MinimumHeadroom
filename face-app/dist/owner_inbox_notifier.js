// Tell the owner when a helper report lands, instead of waiting to be asked.
//
// Before this, a report reaching the inbox changed nothing an owner could
// perceive: the only way to learn a helper had finished was to poll. Measured
// over four missions in one session, that cost five minutes on one report and
// on another the user noticed before the operator did. Two of the operator's
// own polling loops were also written wrong, which is the stronger argument —
// a design that needs every owner to hand-roll correct polling has already
// failed twice.
//
// Only terminal and attention kinds are announced. Progress reports are the
// common case and announcing them would be noise; one helper parked on a CLI
// survey produced twenty-two blocked reports in eleven minutes, which is why
// repeats are collapsed in the store before they reach here.

const ANNOUNCED_KINDS = new Set(['done', 'blocked', 'question', 'review_findings']);

const CJK_REGEX = /[　-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;

const LINES = {
  done: {
    en: (agent) => `${agent} is done.`,
    ja: (agent) => `${agent} が完了しました。`
  },
  review_findings: {
    en: (agent) => `${agent} has findings.`,
    ja: (agent) => `${agent} から指摘が来ています。`
  },
  blocked: {
    en: (agent) => `${agent} is blocked.`,
    ja: (agent) => `${agent} が止まっています。`
  },
  question: {
    en: (agent) => `${agent} has a question.`,
    ja: (agent) => `${agent} が質問しています。`
  }
};

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

export function createOwnerInboxNotifier(options = {}) {
  const log = options.log ?? console;
  const enabled = options.enabled !== false;

  function pickLanguage(report) {
    const sample = `${report?.summary ?? ''} ${report?.detail ?? ''}`;
    if (CJK_REGEX.test(sample)) {
      return 'ja';
    }
    const env = asNonEmptyString(process.env.MH_FACE_LANG);
    return env && env.toLowerCase().startsWith('ja') ? 'ja' : 'en';
  }

  function buildPayloads(report) {
    const kind = asNonEmptyString(report?.kind);
    if (!kind || !ANNOUNCED_KINDS.has(kind)) {
      return null;
    }
    const helperId = asNonEmptyString(report?.from_agent_id);
    // The owner is the one being told, so the owner's face is the one that
    // speaks. Attributing this to the helper would animate the helper's tile
    // and leave the operator's face silent.
    const ownerId = asNonEmptyString(report?.owner_agent_id);
    if (!helperId || !ownerId) {
      return null;
    }
    const lang = pickLanguage(report);
    const text = LINES[kind][lang](helperId);
    const ts = Date.now();
    const blocking = kind === 'blocked' || kind === 'question';
    return {
      event: {
        v: 1,
        type: 'event',
        session_id: 'owner-inbox',
        agent_id: ownerId,
        ts,
        name: blocking ? 'permission_required' : 'cmd_succeeded',
        severity: blocking ? 0.9 : 0.5,
        meta: {
          source: 'owner_inbox',
          report_kind: kind,
          from_agent_id: helperId,
          mission_id: report?.mission_id ?? null,
          report_id: report?.report_id ?? null
        },
        ttl_ms: 30000
      },
      say: {
        v: 1,
        type: 'say',
        session_id: 'owner-inbox',
        agent_id: ownerId,
        ts,
        utterance_id: `inbox-${kind}-${ts}-utt`,
        text,
        // A helper that is stuck or asking needs the owner now; one that has
        // finished can wait for a gap in whatever is being said.
        priority: blocking ? 3 : 2,
        policy: blocking ? 'interrupt' : 'replace',
        ttl_ms: 30000,
        notification_event: `owner_inbox_${kind}`,
        dedupe_key: null,
        message_id: `inbox-${kind}-${report?.report_id ?? ts}`,
        revision: ts
      }
    };
  }

  async function notify({ report, server, ttsController } = {}) {
    if (!enabled) {
      return { ok: false, reason: 'disabled' };
    }
    const payloads = buildPayloads(report);
    if (!payloads) {
      return { ok: false, reason: 'not_announced' };
    }
    if (server && typeof server.broadcast === 'function') {
      try {
        server.broadcast(payloads.event);
      } catch (error) {
        log.warn?.(`[owner-inbox] broadcast event failed: ${error.message}`);
      }
      try {
        server.broadcast(payloads.say);
      } catch (error) {
        log.warn?.(`[owner-inbox] broadcast say failed: ${error.message}`);
      }
    }
    if (ttsController && typeof ttsController.handleSayPayload === 'function') {
      try {
        await ttsController.handleSayPayload(payloads.say);
      } catch (error) {
        log.warn?.(`[owner-inbox] speak failed: ${error.message}`);
      }
    }
    return { ok: true, kind: report.kind, text: payloads.say.text };
  }

  return { notify, __test: { buildPayloads, ANNOUNCED_KINDS } };
}
