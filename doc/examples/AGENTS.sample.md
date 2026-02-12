# AGENTS.sample.md

Paste this into your project `AGENTS.md` and customize.

## Minimum Headroom MCP signaling (required)

- Send `face_ping` once at task start.
- Send `face_event` at major boundaries (`cmd_started`, `cmd_failed`, `cmd_succeeded`, `tests_failed`, `tests_passed`, `permission_required`, `retrying`, `idle`).
- Prefer `face_say` for key state changes (start, failure, permission, success, completion), not visuals only.
- Before any approval prompt, send `face_event(permission_required)` and then `face_say(priority=3, policy=interrupt)`.

## Compatibility baseline (recommended)

- Depend only on baseline MCP calls (`face_ping`, `face_event`, `face_say`).
- Avoid tool-specific notify/hook features as hard dependencies.

## Speech defaults

- `priority=3` + `policy=interrupt` for critical notices.
- `priority=2` for important status updates.
- Keep `priority<=1` sparse.
- Add `message_id` and `revision` when possible.
- For approval speech, keep it short and varied instead of fixed wording.
- Good follow-up wording example: `One more approval, please.`

For the full policy, see `doc/examples/AGENT_RULES.md`.
