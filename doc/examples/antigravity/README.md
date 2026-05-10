# Gemini CLI (Antigravity) MCP setup (example)

## MCP config

Place `mcp_config.json` in your Gemini config directory (typically `~/.gemini/`), or in a project-local `.gemini/` folder.

Template (update the absolute path):

```json
{
  "mcpServers": {
    "minimum-headroom": {
      "command": "/ABS/PATH/minimum-headroom/scripts/run-bound-mcp-server.sh",
      "args": [],
      "env": {
        "FACE_WS_URL": "ws://127.0.0.1:8765/ws",
        "MCP_TOOL_NAME_STYLE": "underscore"
      }
    }
  }
}
```

Gemini CLI requires `MCP_TOOL_NAME_STYLE=underscore` because it does not accept dotted tool names. `run-bound-mcp-server.sh` starts the MCP server and preserves `MH_FACE_AGENT_ID` / `MH_FACE_AGENT_LABEL` from the current agent process or its parent process when available.

## Permission presets for helpers

When spawning Gemini helper agents with `agent.spawn(permission_preset=...)`, the operator writes a `.gemini/settings.json` in the helper worktree with the appropriate `tools.core` allow-list.

### Reviewer preset

```json
{
  "tools": {
    "core": ["read_file", "list_directory", "search_files", "run_shell_command"]
  }
}
```

### Implementer / Full preset

```json
{
  "tools": {
    "core": [
      "read_file", "edit_file", "write_file",
      "list_directory", "search_files", "run_shell_command"
    ]
  }
}
```

For `--yolo` mode (auto-approve all tool calls), pass `--yolo` when launching the Gemini agent in the helper pane.

### git push deny

Gemini helpers use a shell wrapper or AGENTS.md instruction to deny `git push`. The `run_shell_command` tool is present in all presets but constrained by agent instructions.

## AGENTS.md

Place an `AGENTS.md` in the target repository root. Use `doc/examples/AGENTS.sample.md` as the starting template, and include the signaling rules from `doc/examples/AGENT_RULES.md`.

## Hook bridge (face safety net)

Wire the minimum-headroom hook bridge so the face speaks even when the agent forgets to call `face_say` voluntarily. Merge this top-level `hooks` block into `~/.gemini/settings.json`:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "mh-hook-permission",
            "type": "command",
            "command": "/ABS/PATH/minimum-headroom/scripts/mh-hook.mjs --runtime gemini --event permission_required",
            "timeout": 5000
          }
        ]
      }
    ],
    "AfterAgent": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "mh-hook-idle",
            "type": "command",
            "command": "/ABS/PATH/minimum-headroom/scripts/mh-hook.mjs --runtime gemini --event idle_after_response",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

Notes:

- `mh-hook.mjs` is hard-wired to write nothing to stdout and exit `0` under all conditions. This is required because Gemini parses hook stdout as JSON and treats exit code `2` from `AfterAgent` as "retry this turn with stderr as the new prompt" — exiting non-zero from a safety-net hook would silently kick the agent into an unwanted retry loop.
- The hook fires only when `MH_FACE_AGENT_ID` is set in the agent process environment. `scripts/run-operator-once.sh` sets this for the operator pane; helper panes inherit it from `agent.spawn`.
- See `doc/hook-bridge/` for cross-runtime details.
