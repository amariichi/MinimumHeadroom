# Gemini CLI (Antigravity) MCP setup (example)

## MCP config

Place `mcp_config.json` in your Gemini config directory (typically `~/.gemini/`), or in a project-local `.gemini/` folder.

Template (update the absolute path):

```json
{
  "mcpServers": {
    "minimum-headroom": {
      "command": "node",
      "args": [
        "/ABS/PATH/minimum-headroom/mcp-server/dist/index.js"
      ],
      "env": {
        "FACE_WS_URL": "ws://127.0.0.1:8765/ws",
        "MCP_TOOL_NAME_STYLE": "underscore"
      }
    }
  }
}
```

Gemini CLI requires `MCP_TOOL_NAME_STYLE=underscore` because it does not accept dotted tool names.

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
