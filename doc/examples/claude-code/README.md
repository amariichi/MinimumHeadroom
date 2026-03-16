# Claude Code MCP setup (example)

Claude Code supports adding stdio MCP servers via CLI.

Example:
  claude mcp add --transport stdio --env FACE_WS_URL=ws://127.0.0.1:8765/ws minimum-headroom -- node /ABS/PATH/minimum-headroom/mcp-server/dist/index.js

If your environment rejects dotted tool names (`face.event` style), add:
  --env MCP_TOOL_NAME_STYLE=underscore

Then tools are exposed as:
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
