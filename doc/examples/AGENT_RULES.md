# AGENT_RULES.md (Minimum Headroom MCP Signaling Rules)

Purpose: provide a practical baseline so coding agents continuously report intent and status through both motion and voice, not visuals only.

## 1. Required tools

- `face_ping` (connectivity check near task start)
- `face_event` (primary status channel)
- `face_say` (spoken status channel for key moments)

## 2. Required signaling moments

1. Task start / before major command blocks

- `face_event(name="cmd_started", severity=0.3, meta={...})`
- `face_say(..., priority=1 or 2)` for a short kickoff line

2. Command, tool, or test failure

- `face_event(name="cmd_failed", severity=0.7, meta={cmd, exit_code, ...})`
- use `tests_failed` for test failures
- add `face_say(..., priority=2)` with a concise failure message

3. Significant success checkpoints

- `face_event(name="cmd_succeeded", severity=0.5, meta={...})`
- use `tests_passed` for test success
- add `face_say(..., priority=2)` for concise completion feedback

4. User approval needed

- `face_event(name="permission_required", severity=0.9, meta={action, ...})`
- `face_say(..., priority=3, policy="interrupt")` immediately before requesting approval

5. Retry after failure

- `face_event(name="retrying", severity=0.5, meta={attempt, ...})`
- optional short `face_say(..., priority=1 or 2)` when useful

6. Return to neutral

- `face_event(name="idle", severity=0.1~0.3, meta={...})`

## 3. Basic compatibility profile (future-proof default)

Use this profile when you want behavior that survives agent feature churn.

- Depend only on baseline MCP tool calls: `face_ping`, `face_event`, `face_say`.
- Do not depend on product-specific hook systems (`notify`, `hooks`, custom event buses).
- Treat permission speech as an agent-side behavior: emit it before any approval prompt.
- Keep `permission_required` as the event contract; put concrete action details in `meta.action`.

## 4. Speech policy (prefer voice on key states)

- Prefer voice for: start, failure, permission_required, success, final completion.
- Keep lines short and actionable.
- Avoid repeating the exact same sentence every step.
- `priority=3`: critical status, always `policy="interrupt"`.
- `priority=2`: important updates (default for success/failure notices).
- `priority<=1`: sparse progress nudges only.

## 5. Permission phrase generation policy (short + varied)

For approval prompts, avoid fixed canned lines. Generate short text from intent.

- Keep it brief: target 3 to 8 words in English, or one short clause in Japanese.
- Include what is needed (approval/check) and optionally one action hint.
- Avoid repeating the exact same sentence back to back.
- For repeated approvals in a short span, shorten further (for example: "One more approval, please.").
- Keep wording polite and neutral; avoid verbose explanations in voice.

Suggested natural English patterns:

- First approval: "Approval needed."
- Follow-up approval: "One more approval, please."
- Action-specific: "Approval needed to continue."

## 6. Message identity

For `face_say`, include when possible:

- `message_id`
- `revision` (usually `Date.now()`)

This preserves freshness even for similar text.

## 7. Degraded mode

- If MCP calls fail, continue core implementation work.
- Report degraded telemetry once in chat.
- Resume signaling automatically when MCP recovers.
