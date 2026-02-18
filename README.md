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
- TTS pipeline:
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

## Speech Gate Config (`config.yaml`)

`face-app` now reads `config.yaml` from repository root at startup (or `FACE_CONFIG_PATH` if set) and applies `speech_gate` values to voice throttling.

Checked-in defaults are intentionally relaxed so the assistant can speak more often:

```yaml
speech_gate:
  min_interval_priority1_ms: 1500
  global_window_ms: 60000
  global_limit_low_priority: 24
  session_window_ms: 60000
  session_limit_low_priority: 12
  dedupe_ms_low_priority: 800
```

Fields map to runtime gate options:

- `min_interval_priority1_ms` -> minimum interval for `priority=1`
- `global_limit_low_priority` within `global_window_ms` for `priority<=2`
- `session_limit_low_priority` within `session_window_ms` for `priority<=2`
- `dedupe_ms_low_priority` for repeated `dedupe_key` on `priority<=2`

## Long Speech Behavior

- `face.say` default `ttl_ms` is now `60000` (60s) when omitted.
- You can override default with env var `FACE_SAY_DEFAULT_TTL_MS` on `mcp-server`.
- `face-app` also supports `tts.default_ttl_ms` in `config.yaml`.
- `face-app` supports `tts.auto_interrupt_after_ms`: when `policy=replace` input arrives after this threshold while another speech is active, it is promoted to interrupt.

When a new `face.say` arrives during playback:

- `policy=replace` keeps current playback and queues only the latest pending utterance.
- `policy=interrupt` (or `priority=3`) stops current playback and starts the new utterance immediately.

## Speech Language Routing

- ASCII text is spoken as English (`en-us`, speed `1.0`)
- Non-ASCII text is spoken as Japanese (`j`, speed `1.2`)

### English Normalization Spec

Applied to all `face.say` text before speech synthesis.

- `‘` / `’` -> `'`
- `“` / `”` -> `"`
- `…` -> `...`
- NBSP (`U+00A0`) / NNBSP (`U+202F`) -> regular space
- Latin letters with combining marks are ASCII-normalized
  - `café -> cafe`, `naïve -> naive`, `rôle -> role`
- Existing inline dash normalization is preserved for English
  - `9-to-5 -> 9 to 5`
- Full-width symbols/letters and Japanese characters are preserved

This is implemented in the face-app TTS controller (normalization) plus tts-worker chunking/synthesis path (language routing).

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

## Optional Agent Skills

This repository includes reusable skill packages under `doc/examples/skills/`:

- `release-ci-flow`
- `minimum-headroom-ops`
- `looking-glass-webxr-setup`

Each folder contains a `SKILL.md` and can be copied into your local skills directory (for example `$CODEX_HOME/skills/`) if your agent supports local skill loading.

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
