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
