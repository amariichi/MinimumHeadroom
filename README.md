# minimum-headroom

<img width="800" height="475" alt="Image" src="https://github.com/user-attachments/assets/b3b0a1dd-ef19-49d0-bdaf-5068ee1a376c" />
<img width="800" height="600" alt="Image" src="https://github.com/user-attachments/assets/fa7f65d5-f314-4118-90c7-3853fddd6668" />

---

A local face companion app for coding agents.

`minimum-headroom` visualizes agent state in a separate browser window (3D face + motion) and optionally speaks short status messages through Kokoro TTS. It exposes an MCP server so clients like Codex/Claude/Antigravity can call tools and drive the face.

## Features

- MCP tools for signaling:
  - `face.event` / `face.say` / `face.ping`
- Browser 3D face renderer with state-driven animation:
  - eyebrow/eye/mouth/head movement
  - state modes (`confused`, `frustration`, `confidence`, `urgency`, `stuckness`, `neutral`)
- Looking Glass WebXR support path
- Phase 3 TTS pipeline:
  - Kokoro ONNX + Misaki (`af_heart`)
  - freshness-first speech policy (`interrupt`, TTL, generation invalidation)
  - speech result feedback (`say_result`)

## Requirements

- Node.js 20+ (Node 24 recommended)
- `uv` (for Python worker dependencies)
- Python 3.10+
- Optional for audible TTS on Linux:
  - either PortAudio (`libportaudio2`) for `sounddevice`
  - or ALSA `aplay` fallback

## Quick Start

From repository root:

```bash
./scripts/setup.sh
./scripts/run-face-app.sh
```

Open the UI shown in logs (default: `http://127.0.0.1:8765/`).

In another terminal:

```bash
./scripts/run-mcp-server.sh
```

You can also use npm scripts:

```bash
npm run face-app:start
npm run mcp-server:start
```

## TTS Model Files

Place model files in `assets/kokoro/`:

- `kokoro-v1.0.onnx`
- `voices-v1.0.bin`

Reference download instructions are in `assets/kokoro/README.md`.

These large model files are intentionally ignored by git.

## Speech Language Routing

Current Phase 3 default behavior routes text by character class:

- ASCII text is spoken as English (`en-us`, speed `1.0`)
- Non-ASCII text is spoken as Japanese (`j`, speed `1.2`)

This is implemented in the TTS worker chunking/synthesis path.

## MCP Client Config

Do not commit your personal local config files.

### Codex CLI example

Use `doc/examples/codex/config.toml` as a template. Update absolute paths for your machine.

If your MCP client rejects tool names with dots (for example `face.event`), set:

```toml
env = { FACE_WS_URL = "ws://127.0.0.1:8765/ws", MCP_TOOL_NAME_STYLE = "underscore" }
```

Then tools are published as:

- `face_event`
- `face_say`
- `face_ping`

### Antigravity example

Use `doc/examples/antigravity/mcp_config.json` as a template with your own absolute path.

For agent-side signaling conventions, see `doc/examples/AGENT_RULES.md`.

## Release Checklist

- Run tests:

```bash
npm test
```

- Verify MCP startup:

```bash
./scripts/run-mcp-server.sh
```

- Verify face app startup and browser rendering:

```bash
./scripts/run-face-app.sh
```

- Verify TTS worker smoke:

```bash
npm run tts-worker:smoke
```

## Repository Notes

- Runtime/local files (models, local MCP config, caches, venv) are excluded via `.gitignore`.
