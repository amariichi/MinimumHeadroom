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

Wire the minimum-headroom hook bridge so the face speaks even when the agent
forgets to call `face_say` voluntarily. The same settings can also wire the M12
camera situation hook for `UserPromptSubmit`; it emits nothing unless
`MH_SITUATION_INJECT=1`, so it is safe to leave installed. Merge the following
into your `~/.claude/settings.json` (top-level `hooks` key), or prefer
`examples/rmh-voice-mode/start-rmh.sh --agent claude --with-vision`, which
generates an equivalent per-launch settings file without editing global config:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/ABS/PATH/minimum-headroom/scripts/mh-hook.mjs --runtime claude --event permission_required"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "/ABS/PATH/minimum-headroom/scripts/mh-hook.mjs --runtime claude --event idle_after_response"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/ABS/PATH/minimum-headroom/scripts/situation-context-hook.sh"
          }
        ]
      }
    ]
  }
}
```

`mh-hook.mjs` is silent and exits 0 on every error path, so it never blocks Claude Code. It only fires when `MH_FACE_AGENT_ID` is set in the agent process environment (which `scripts/run-operator-once.sh` already does for the operator pane). See `doc/hook-bridge/` for cross-runtime details.

`situation-context-hook.sh` is also safe-by-default: if the vision worker is
down or `MH_SITUATION_INJECT` is false, it exits 0 without stdout. Enable it for
a manual Claude launch by exporting `MH_SITUATION_INJECT=1` and, if needed,
`VISION_BASE_URL=http://127.0.0.1:8095`. In RMH voice-first mode,
`start-rmh.sh --with-vision` sets `MH_SITUATION_INJECT=1` for the launched
Claude process, so the generated hook injects the `[カメラの状況 ...]` block
(including its `見覚え:` entity-callback lines) when the M12 backend is
available.
