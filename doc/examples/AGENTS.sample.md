# AGENTS.sample.md

Paste this into your project `AGENTS.md` and customize.

## Minimum Headroom MCP signaling (required)

- Send `face_ping` once at task start.
- Send `face_event` at major boundaries (`cmd_started`, `cmd_failed`, `cmd_succeeded`, `tests_failed`, `tests_passed`, `permission_required`, `retrying`, `idle`).
- Prefer `face_say` for key state changes (start, failure, permission, success, completion), not visuals only.
- Before any approval prompt, send `face_event(permission_required)` and then `face_say(priority=3, policy=interrupt)`.
- Never ask for approval before those two signals are sent.
- Treat approval wait as attention, not idle.

## Compatibility baseline (recommended)

- Depend only on baseline MCP calls (`face_ping`, `face_event`, `face_say`).
- Avoid tool-specific notify/hook features as hard dependencies.
- If user action is required and there is no richer product event, prefer `permission_required` over silent waiting.

## Operator-led multi-agent workflow (recommended)

- Use MCP lifecycle tools as the standard path: `agent.list(scope="stream")`, `agent.spawn`, `agent.assign`, `agent.inject`, `agent.assignment.list`, `owner.inbox.list`, `owner.inbox.resolve`, `agent.delete`.
- Treat `agent.assign` as the durable mission record and `agent.inject` as controlled delivery for bootstrap or explicit reinstruction.
- For review or investigation helpers, make the mission concrete with `target_paths`, `completion_criteria`, `timebox_minutes`, and `max_findings` when possible.
- Treat `target_paths` as stream-root/source-repo anchored, even when they point outside the helper worktree.
- For reinstruction to an already-running helper, prefer `agent.inject(..., probe_before_send=true)` when the helper may already be sitting at a prompt or when input readiness is uncertain.
- If a multiline mission still appears buffered after submit, prefer `agent.inject(..., rescue_submit_if_buffered=true)` so the runtime can send one guarded extra `Enter`.
- Expect a matching helper `agent.report` after `agent.inject`; if delivery fails or times out, retry once and then surface `needs_attention`.
- If a probe-based reinstruction fails, stop and surface `needs_attention` instead of looping repeated probes.
- Helpers report to the owner, not directly to the user.
- `agent.focus` changes visibility only; it does not transfer ownership.
- Review helpers should default to read-only missions.
- Use helpers when the work splits cleanly: implementation, review/findings, or one bounded investigation.
- Prefer staying single-agent for tiny one-file edits or narrow wording changes where helper overhead would dominate.
- Prefer one bounded helper mission at a time such as "one finding or done", then follow up only if needed.
- If a helper reports late after timing out, treat the report as real work product first; do not assume the delivery path is fully broken.

## Helper reporting discipline (recommended)

- If you are the helper receiving an owner mission, send the first `agent.report(progress)` before repo exploration or broad file reads.
- Treat that first report as the mission-accept handshake; if you cannot accept the mission, send `blocked` or `question` instead of silent waiting.
- Reuse the exact `stream_id`, `mission_id`, `owner_agent_id`, and `from_agent_id` that the owner gave you.
- After the first report succeeds, use the `minimum-headroom-ops` skill if it is available and relevant.
- After the first report succeeds, inspect the owner-provided target files before optional `/skills`, slash commands, or unrelated repo exploration unless blocked without them.
- After the first report succeeds, continue the work and later report `done` or `review_findings`.
- Once you have the bounded answer for the current pass, send the final `done` or `review_findings` report before extra prompts, `/skills`, or follow-up exploration.
- If this is a narrow review or investigation pass, return the first qualifying finding immediately instead of continuing to hunt for more.
- If `max_findings` is `1` or the completion criteria say "one finding or done", stop after the first qualifying result and report it immediately.
- If no qualifying finding appears within the scoped pass or timebox, send `done` with a concise no-findings summary instead of lingering silently.
- After your final `done` or `review_findings` report, stop and wait for the owner instead of continuing exploration on your own.
- If the owner gave `target_paths`, `completion_criteria`, `timebox_minutes`, or `max_findings`, treat them as active mission constraints.
- If the owner gave `target_paths`, read those exact stream-root/source-repo paths first instead of hunting for mirrored copies inside your helper worktree.

## Speech defaults

- `priority=3` + `policy=interrupt` for critical notices.
- `priority=2` for important status updates.
- Keep `priority<=1` sparse.
- Add `message_id` and `revision` when possible.
- For approval speech, keep it short and varied instead of fixed wording.
- Good follow-up wording example: `One more approval, please.`

For the full policy, see `doc/examples/AGENT_RULES.md`.
