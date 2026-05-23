---
name: minimum-headroom-ops
description: Operate and troubleshoot minimum-headroom runtime components (face app, mcp server, tts worker, websocket signaling) with reproducible checks.
---

# Minimum Headroom Ops

Use this skill when the user asks to start, verify, or diagnose runtime behavior of minimum-headroom.

## Runtime components

- `face-app`: browser UI and websocket hub (`ws://127.0.0.1:8765/ws`)
- `mcp-server`: stdio MCP bridge forwarding to face websocket
- `tts-worker`: Python Kokoro worker process used by face-app

## Standard startup order

From repository root:

```bash
./scripts/setup.sh
./scripts/run-face-app.sh
```

In another terminal:

```bash
./scripts/run-mcp-server.sh
```

## Health checks

1. Unit test baseline:

   ```bash
   npm test
   ```

2. Face app reachable:

   ```bash
   curl -I http://127.0.0.1:8765/
   ```

3. MCP forwarding smoke test (Node 24+):

   ```bash
   node -e 'const ws=new WebSocket("ws://127.0.0.1:8765/ws");ws.onopen=()=>{ws.send(JSON.stringify({v:1,type:"ping",session_id:"ops#smoke",ts:Date.now()}));setTimeout(()=>ws.close(),300)};'
   ```

4. TTS worker availability:

   ```bash
   npm run tts-worker:smoke
   ```

## Frequent failure modes

- `MCP startup failed` or timeout:
  - Use absolute Node path in client config if PATH differs from interactive shell.
  - Prefer `scripts/run-bound-mcp-server.sh` as the MCP command when agent identity should be inherited.
  - If using the raw entrypoint, confirm `command` and `args` point to an existing `mcp-server/dist/index.js`.
  - Increase `startup_timeout_sec` only after fixing path and handshake issues.

- TTS is silent:
  - Confirm model files exist in `assets/kokoro/`.
  - On Linux, install PortAudio or use ALSA fallback.
  - Check face-app log lines for `tts worker ready` and backend name.

- `XR NOT SUPPORTED` while Looking Glass Bridge is running:
  - Verify Chromium/Firefox usage.
  - Confirm polyfill is applied before XR session request.
  - Use monitor mode fallback while troubleshooting.

## Agent signaling policy

When MCP is available, emit:

- `face_ping` near task start
- `face_event` on important boundaries
- `face_say` for high-value notices

Keep `agent_id` stable on every face_* payload. Prefer setting `MH_FACE_AGENT_ID` in the agent process environment so the MCP server auto-fills `agent_id`; pass it explicitly only when that default is unavailable. Use `"__operator__"` for the user-facing operator pane and `"<assigned helper id>"` for helpers. Do not hard-code `"__operator__"` when running as a helper. Without the correct `agent_id`, the visible 3D head may stop animating its mouth even though the text bubble and audio still arrive.

For concrete timing and priority rules, follow `doc/examples/AGENT_RULES.md`.

## Multi-agent lifecycle (operator side)

When acting as the user-facing operator, prefer first-class MCP tools over raw `tmux send-keys` or direct HTTP calls. Standard flow:

1. `agent.list scope=stream` — see current helpers
2. `agent.spawn` — create a helper with a `permission_preset` and (optionally) a `create_worktree` / `create_tmux` request
3. `agent.assign` — store the mission durably; set `role`, `target_paths`, `completion_criteria`, `timebox_minutes`, `max_findings` when they help bound the work
4. `agent.inject` — deliver the stored mission to the helper's LLM input
5. `agent.assignment.list` — confirm `delivery_state` reaches `acked`
6. `owner.inbox.list` — read helper reports as they arrive
7. `owner.inbox.resolve` — close out done / review_findings / informational items
8. `agent.delete` — remove finished helpers (also cascades to assignment and inbox records)

## Recovering a helper stuck on a CLI modal

A helper can stall inside a CLI-level dialog (tool approval, model picker, usage-limit notice, CLI feedback survey) before its LLM reads any input. In that state injected missions are eaten by the modal, no report arrives, and `agent.assignment.list` ends up at `delivery_state=timeout` with no diagnostic. The runtime addresses this in three pieces. Operators of any CLI (claude, codex, agy) follow the same flow:

1. The background stuck-detector inside face-app scans active helper panes every ~5 seconds and matches known modal patterns. On a fresh match it posts `{kind: "blocked", from_agent_id, summary: "helper paused on …", detail: "<matched line>\n---\n<pane tail>"}` into the owner inbox. You will see it via `owner.inbox.list`.
2. Call `agent.pane_snapshot agent_id=<helper> tail_lines=30` to read the full modal verbatim (ANSI stripped). This is the operator-callable equivalent of `tmux capture-pane`, so it works from any MCP client, not just one that has shell access.
3. Decide the response and call `agent.pane_send_key agent_id=<helper> keys=[…]`. Examples:
   - Number-keyed selector (`1. Yes / 2. Yes, always allow / 3. No`): `keys=["2","Enter"]`
   - Arrow-keyed selector (`› 1. Switch model`): `keys=["Down","Enter"]`
   - Cancel an unwanted modal: `keys=["Escape"]`
   - Free-text input: `keys=["hello world"], literal=true`
4. Re-snapshot to confirm the modal cleared. If the original mission text was consumed by the modal, call `agent.inject` again to re-deliver it.
5. `owner.inbox.resolve action=resolved` on the auto-generated `blocked` report.

Notes:

- The detector posts; it never auto-presses keys. Operator (or user) decides every response so a regex match cannot pick `No, and always deny` for you.
- Same `(helper, pattern, matched line)` matches dedupe for ~30 seconds; changing the line re-arms the alarm.
- Disable the detector with `MH_HELPER_STUCK_DETECTOR=off`. Adjust cadence with `MH_HELPER_STUCK_DETECTOR_INTERVAL_MS` (default 5000, minimum 250).
- The three tools (`agent.pane_snapshot`, `agent.pane_send_key`, and the detector that drives them) are part of the same `minimum_headroom` MCP server. No per-CLI MCP configuration change is required to use them — only the auto-approval allowlist in each CLI's settings if you want to skip per-call confirm dialogs.
