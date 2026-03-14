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
- Do not ask for approval in chat before those two signals are emitted.
- Treat approval wait as `needs_attention`, not as `idle` or `prompt_idle`.

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
- If a user response is required and no explicit product event exists, prefer `permission_required` over silent waiting.

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

## 8. Operator-led multi-agent workflow

- When acting as the user-facing owner/operator, prefer first-class MCP tools over raw localhost HTTP or manual `tmux send-keys`.
- Standard lifecycle:
  - `agent.list(scope="stream")`
  - `agent.spawn`
  - `agent.assign`
  - `agent.inject`
  - `agent.assignment.list`
  - `owner.inbox.list`
  - `owner.inbox.resolve`
  - `agent.delete`
- Treat `agent.assign` as the durable mission record and `agent.inject` as controlled delivery for bootstrap or explicit reinstruction.
- For review, investigation, or other narrow helper work, shape the mission explicitly:
  - use `target_paths` when the owner knows the file or directory scope
  - use `completion_criteria` to define what "done" means for this pass
  - use `timebox_minutes` when the owner wants a bounded first pass
  - use `max_findings` when the owner wants a short return such as "one finding or done"
- Treat `target_paths` as stream-root/source-repo anchored. They may point outside the helper worktree; helpers should inspect those exact paths under the stream root instead of guessing mirrored locations inside their own worktree.
- For reinstruction to an already-running helper, prefer `agent.inject(..., probe_before_send=true)` when the helper may be sitting at a prompt or when input readiness is uncertain. The probe sends a short ASCII token, checks that it appears, erases it with matching backspaces, and only then sends the real text.
- If a multiline mission still appears buffered in the helper input after submit, prefer `agent.inject(..., rescue_submit_if_buffered=true)` so the runtime can send one guarded extra `Enter` only when the buffered tail is still visibly present.
- After `agent.inject`, expect helper acknowledgment through `agent.report`. A matching `progress`, `blocked`, `question`, `done`, or `review_findings` report counts as acknowledgment.
- If delivery reaches `failed` or `timeout`, retry injection at most once. If acknowledgment still does not arrive, surface that helper as `needs_attention`.
- If a probe-based reinstruction fails, stop and surface `needs_attention` instead of looping repeated probe attempts.
- Helpers report to the owner, not to the user. Only the current user-facing owner asks the user for input or approval.
- `agent.focus` changes visibility only; it does not transfer ownership.
- Review helpers should default to read-only missions unless the owner explicitly chooses otherwise.

## 9. Helper reporting discipline

- When acting as a helper under a minimum-headroom owner assignment, send the first `agent.report(progress)` before repo exploration, broad file reads, or skill lookup.
- Treat that first report as the mission-accept handshake. If you cannot accept the mission as written, send `blocked` or `question` instead of silent waiting.
- Use the owner-provided identity tuple exactly as given: `stream_id`, `mission_id`, `owner_agent_id`, and `from_agent_id`.
- After the first report succeeds, use the `minimum-headroom-ops` skill if it is available and relevant to the assignment.
- After the first report succeeds, inspect the owner-provided target files before optional `/skills`, slash commands, or unrelated repo exploration unless you are blocked without them.
- After the first report succeeds, continue the requested work. On completion, report `done` or `review_findings`.
- Once you have a bounded answer that satisfies the current completion criteria, send the final `done` or `review_findings` report before any extra prompts, `/skills`, or follow-up exploration.
- If the owner provided `target_paths`, stay on those paths first.
- Treat owner-provided `target_paths` as stream-root/source-repo anchored, even when they point outside your helper worktree.
- If the owner provided `completion_criteria`, follow them exactly.
- If the owner provided `timebox_minutes` or `max_findings`, treat them as hard bounds for the current pass.
- If scope is still broad or ambiguous after the first report, send `question` instead of broad repo exploration.
- If the owner sends a follow-up reinstruction, apply the same discipline again: acknowledge or escalate promptly instead of drifting into unrelated exploration first.
