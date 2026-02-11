# AGENTS.sample.md

Paste this into your project `AGENTS.md` and customize.

## Minimum Headroom MCP signaling (required)

- Send `face_ping` once at task start.
- Send `face_event` at major boundaries (`cmd_started`, `cmd_failed`, `cmd_succeeded`, `tests_failed`, `tests_passed`, `permission_required`, `retrying`, `idle`).
- Prefer `face_say` for key state changes (start, failure, permission, success, completion), not visuals only.

## Speech defaults

- `priority=3` + `policy=interrupt` for critical notices.
- `priority=2` for important status updates.
- Keep `priority<=1` sparse.
- Add `message_id` and `revision` when possible.

For the full policy, see `doc/examples/AGENT_RULES.md`.
