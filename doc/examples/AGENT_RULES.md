# AGENT_RULES.md (Minimum Headroom MCP Signaling Rules)

Purpose: provide a practical baseline so coding agents continuously report intent and status through both motion and voice, not visuals only.

## 1. Required tools

- `face_ping` (connectivity check near task start)
- `face_event` (primary status channel)
- `face_say` (spoken status channel for key moments)

### 1.1 Always pass `agent_id`

Every `face_ping` / `face_event` / `face_say` call must include an explicit `agent_id` that matches the caller's real identity:

- **Operator pane** (user-facing agent started by `run-operator-once.sh` / `start-mobile.sh`): `agent_id="__operator__"`.
- **Helper agent** (running under an owner assignment): `agent_id="<assigned helper id>"` (for example `"helper-1"`).
- **Ad-hoc caller**: pick the agent id whose face the user is actually watching.

Skipping `agent_id` makes the main 3D head stop animating its mouth even though the text bubble and TTS audio still arrive — face-app routes every `tts_mouth` payload through per-agent runtime state, and without an explicit `agent_id` the routing falls back to null. `session_id` does not substitute for `agent_id`; it can be any stable tracking string.

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
  - `agent.spawn` — pass `agent_cmd` (`claude`, `gemini`, `codex`) and `permission_preset` (`reviewer`, `implementer`, `full`) to auto-configure helper tool permissions at spawn time
  - `agent.assign`
  - `agent.inject`
  - `agent.assignment.list`
  - `owner.inbox.list`
  - `owner.inbox.resolve`
  - `agent.delete`
- Treat `agent.assign` as the durable mission record and `agent.inject` as controlled delivery for bootstrap or explicit reinstruction.
- For review, investigation, or other narrow helper work, shape the mission explicitly:
  - set `role` when it helps the helper stay narrow (`reviewer`, `investigator`, `implementer`, `docs-check`)
  - use `target_paths` when the owner knows the file or directory scope
  - use `completion_criteria` to define what "done" means for this pass
  - use `timebox_minutes` when the owner wants a bounded first pass
  - use `max_findings` when the owner wants a short return such as "one finding or done"
- Treat `target_paths` as stream-root/source-repo anchored. They may point outside the helper worktree; helpers should inspect those exact paths under the stream root instead of guessing mirrored locations inside their own worktree.
- For reinstruction to an already-running helper, prefer `agent.inject(..., probe_before_send=true)` when the helper may be sitting at a prompt or when input readiness is uncertain. The probe sends a short ASCII token, checks that it appears, erases it with matching backspaces, and only then sends the real text.
- If a multiline mission still appears buffered in the helper input after submit, prefer `agent.inject(..., rescue_submit_if_buffered=true)` so the runtime can send one guarded extra `Enter` only when the buffered tail is still visibly present.
- After `agent.inject`, verify the helper can use MCP tools by checking whether a `progress` report arrives in `owner.inbox.list` within the ack deadline. If `permission_preset` was set at spawn, tool approvals should be automatic; if no `progress` arrives and `agent.assignment.list` shows `timeout`, the helper may still be blocked by an uncovered prompt. In that case, surface `needs_attention` and check the helper pane directly instead of firing a rescue.
- After `agent.inject`, expect helper acknowledgment through `agent.report`. A matching `progress`, `blocked`, `question`, `done`, or `review_findings` report counts as acknowledgment.
- If delivery reaches `failed` or `timeout`, retry injection at most once. If acknowledgment still does not arrive, surface that helper as `needs_attention`.
- If a probe-based reinstruction fails, stop and surface `needs_attention` instead of looping repeated probe attempts.
- Helpers report to the owner, not to the user. Only the current user-facing owner asks the user for input or approval.
- `agent.focus` changes visibility only; it does not transfer ownership.
- Review helpers should default to read-only missions unless the owner explicitly chooses otherwise.
- Prefer spinning up a reviewer helper when the owner expects non-trivial code edits, broad config/docs changes, or a risky cross-cutting patch.
- Prefer spinning up an investigation helper when one bounded question can be answered independently while the owner continues another path.
- Prefer spinning up an implementation helper only when the change splits cleanly by file set or subsystem and the owner can still integrate the result safely.
- Prefer spinning up a docs-check helper when the likely work is documentation, README, guide, or diagram consistency rather than code behavior.
- Prefer staying single-agent when the task is a tiny one-file edit, a narrowly scoped wording change, or anything where mission overhead would exceed the likely parallelism gain.
- Prefer one bounded helper mission at a time over a broad "review everything" request. Ask helpers for one finding or done, then follow up only if needed.
- If a helper acknowledges late (`acked_late`) after a timeout, treat that as evidence the mission eventually reached the helper. Review or resolve the report before concluding the delivery path is broken.
- If a helper has acknowledged but still has no final `done` or `review_findings` after the scoped timebox or a long quiet window, wait through a short grace period first (about 10 seconds, or use `completion_rescue_ready_at` / `completion_rescue_wait_ms` from `agent.assignment.list` when available).
- After that grace window expires, check `owner.inbox.list` for that helper first; if a `done` or `review_findings` report has already arrived since the mission was assigned, skip the rescue entirely.
- If `owner.inbox.list` shows zero reports (not even `progress`) for the helper since injection, treat the report channel as potentially broken. Check the helper pane directly for output instead of firing a rescue into a possibly permission-blocked helper.
- If the inbox shows at least a `progress` ack but no final report yet, prefer a bounded follow-up such as `agent.inject(..., followup_mode="completion_rescue", probe_before_send=true, rescue_submit_if_buffered=true)` instead of broad reinstruction.
- If two final reports from the same helper arrive close together after a rescue, resolve the earlier one with `owner.inbox.resolve` and treat the later one as the authoritative result.

## 9. Helper reporting discipline

- When acting as a helper under a minimum-headroom owner assignment, send the first `agent.report(progress)` before repo exploration, broad file reads, or skill lookup.
- Treat that first report as the mission-accept handshake. If you cannot accept the mission as written, send `blocked` or `question` instead of silent waiting.
- Use the owner-provided identity tuple exactly as given: `stream_id`, `mission_id`, `owner_agent_id`, and `from_agent_id`.
- After the first report succeeds, use the `minimum-headroom-ops` skill if it is available and relevant to the assignment.
- After the first report succeeds, inspect the owner-provided target files before optional `/skills`, slash commands, or unrelated repo exploration unless you are blocked without them.
- After the first report succeeds, continue the requested work. On completion, report `done` or `review_findings`.
- Once you have a bounded answer that satisfies the current completion criteria, send the final `done` or `review_findings` report before any extra prompts, `/skills`, or follow-up exploration.
- If this is a narrow review or investigation pass, return the first qualifying finding immediately instead of continuing to hunt for more.
- If `max_findings` is `1` or the completion criteria say "one finding or done", stop after the first qualifying result and report it immediately.
- If no qualifying finding appears within the scoped pass or timebox, send `done` with a concise no-findings summary instead of lingering silently.
- After your final `done` or `review_findings` report, stop and wait for the owner instead of continuing exploration on your own.
- If the owner provided `target_paths`, stay on those paths first.
- Treat owner-provided `target_paths` as stream-root/source-repo anchored, even when they point outside your helper worktree.
- If the owner provided `completion_criteria`, follow them exactly.
- If the owner provided `timebox_minutes` or `max_findings`, treat them as hard bounds for the current pass.
- If scope is still broad or ambiguous after the first report, send `question` instead of broad repo exploration.
- If the owner sends a follow-up reinstruction, apply the same discipline again: acknowledge or escalate promptly instead of drifting into unrelated exploration first.
- If the owner sends a completion rescue follow-up, do not restart broad exploration. Send `done`, `review_findings`, `blocked`, or `question` immediately from the current scoped work.
- If `agent.report` calls fail due to tool permissions or MCP connectivity, continue the assigned work and leave your results visible in terminal output. The operator may check your pane directly as a fallback.
