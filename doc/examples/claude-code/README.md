# Claude Code MCP setup (example)

Claude Code supports adding stdio MCP servers via CLI.

Example:

```sh
claude mcp add --transport stdio --env FACE_WS_URL=ws://127.0.0.1:8765/ws --env MCP_TOOL_NAME_STYLE=underscore minimum_headroom -- /ABS/PATH/minimum-headroom/scripts/run-bound-mcp-server.sh
```

This example uses underscore tool names (`face_event` style), matching the other
agent examples in this repository. Remove `--env MCP_TOOL_NAME_STYLE=underscore`
only when you intentionally want the default dotted names (`face.event` style).

`run-bound-mcp-server.sh` starts the MCP server and preserves `MH_FACE_AGENT_ID` /
`MH_FACE_AGENT_LABEL` from the current agent process or its parent process when
available. This lets `face_ping`, `face_event`, and `face_say` omit `agent_id`
in operator/helper panes that were launched by Minimum Headroom.

With the command above, tools are exposed as:

- `face_event`
- `face_say`
- `face_ping`

Notes:

- Options (--transport/--env/--scope/...) must come before the server name.
- `--` separates the server name from the command and args.

## Permission presets for helpers

When spawning helper agents with `agent.spawn(permission_preset=...)`, the operator auto-configures Claude Code's `.claude/settings.json` in the helper worktree.

The `settings.json` format uses `allowedTools` and `deniedTools` arrays:

```json
{
  "permissions": {
    "allowedTools": ["Read", "Glob", "Grep", "Agent", ...],
    "deniedTools": ["Bash(git push*)"]
  }
}
```

### git push deny (security hardening)

All permission presets (`reviewer`, `implementer`, `full`) include a `deniedTools` entry that blocks `git push` from helper agents:

```json
"deniedTools": ["Bash(git push*)"]
```

This prevents helper agents from pushing to remote repositories without operator review.

### Read-only protection

After writing `settings.json`, the operator sets `chmod 444` on the file so that helper agents cannot modify their own permission configuration during a session.

## Hook bridge and M12 situation injection

Use the existing [hook bridge settings example](../../hook-bridge/claude-settings.json.example), replacing placeholder paths and merging its `hooks` entries into your chosen settings scope. Keep existing model, authentication and permission settings; do not overwrite the whole file. It observes questions, approvals, matching tool results, response endings and selected notifications. MCP registration above is a separate step.

Alternatively, `examples/rmh-voice-mode/start-rmh.sh --agent claude` generates per-launch MCP and hook settings. `--with-vision` additionally starts the optional vision stack; it is not needed for ordinary input-wait notifications. Other settings sources can still contribute hooks, so inspect duplicate registrations. The launcher does not choose Auto mode or bypass permissions for you.

The observer is silent and exits zero on errors; that keeps the CLI running but does not establish delivery. Check MCP with `face_ping`, then a harmless helper question/answer/explicit done through the intended inbox. CLI `Stop` means response end, not completion. See [hook verification and migration](../../hook-bridge/README.md#english).

`situation-context-hook.sh` is also safe-by-default: if the vision worker is
down or `MH_SITUATION_INJECT` is false, it exits 0 without stdout. Enable it for
a manual Claude launch by exporting `MH_SITUATION_INJECT=1` and, if needed,
`VISION_BASE_URL=http://127.0.0.1:8095`. In RMH voice-first mode,
`start-rmh.sh --with-vision` sets `MH_SITUATION_INJECT=1` for the launched
Claude process, so the generated hook injects the `[カメラの状況 ...]` block
(including its `見覚え:` entity-callback lines) when the M12 backend is
available.
