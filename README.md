# minimum-headroom

<p>
  <img width="49%" alt="Image" src="https://github.com/user-attachments/assets/b3b0a1dd-ef19-49d0-bdaf-5068ee1a376c" />
  <img width="49%" alt="Image" src="https://github.com/user-attachments/assets/60905c13-7c4b-4321-bfe3-f343a85c974f" />
</p>
<p>
  <img width="49%" alt="Image" src="https://github.com/user-attachments/assets/fa7f65d5-f314-4118-90c7-3853fddd6668" />
  <img width="49%" alt="Image" src="https://github.com/user-attachments/assets/404988d5-6a26-4bf5-a5a0-867ef4317305" />
</p>

[English](#english) | [日本語](#japanese)

<a id="english"></a>

## English

---

A face and operator companion app for coding agents.

## Contents

- [At a Glance](#en-at-a-glance)
- [Features](#en-features)
- [Quick Start](#en-quick-start)
- [Agent Setup](#en-agent-setup)
- [Detailed Guides](#en-detailed-guides)
- [Japanese](#japanese)

<a id="en-at-a-glance"></a>
## At a Glance

- **Control your PC coding agent from your phone** — approve, type, or speak commands via mobile browser.
- **Works with Claude Code, Codex CLI, and Antigravity CLI** — any agent that runs in a terminal.
- **tmux operator bridge** relays input/output between the browser UI and the agent pane.
- **3D face + TTS + MCP signaling** give your agent a voice and expressions that reflect its state.
- **Multi-agent support** (experimental) — spawn helper agents in isolated worktrees with permission presets and durable mission tracking. See [Multi-Agent Guide](doc/guides/multi-agent.md).
- **Tailscale Serve** for secure remote access from phone or tablet.

<a id="en-features"></a>
## Features

- **Operator input** — terminal direct prompt, browser PTT (JA/EN ASR), text fallback, desktop `Space`/`Shift+Space` hold-to-talk safety, key controls (`Esc`, `↑`, `Select`, `↓`)
- **Terminal mirror** — read-only tmux tail snapshots at 500ms change-only intervals; lines render at native width with horizontal scroll, and on touch devices you can pinch-to-zoom (anchored under your fingers) and double-tap to reset
- **Multi-agent** (experimental) — spawn/focus/delete helpers from desktop tiles or mobile list, permission presets, mission assignment and delivery, owner inbox. A background stuck-detector scans each helper's tmux pane and posts auto `blocked` reports to the owner inbox when a known CLI modal (approval prompt, model picker, usage-limit notice, survey) is visible, so the operator notices stalled helpers without polling. See [Multi-Agent Guide](doc/guides/multi-agent.md).
- **MCP signaling** — `face.event` / `face.say` / `face.ping` plus agent lifecycle tools (`agent.list`, `agent.spawn`, `agent.focus`, `agent.delete`, `agent.assign`, `agent.assignment.list`, `agent.inject`, `agent.report`, `agent.pane_snapshot`, `agent.pane_send_key`, `owner.inbox.*`)
- **3D face** — eyebrow/eye/mouth/head animation, state modes (`confused`, `frustration`, `confidence`, `urgency`, `stuckness`, `neutral`), drag control, panel toggles
- **TTS** — Kokoro ONNX + Misaki default, optional Qwen3-TTS Japanese backend, freshness-first speech policy. See [TTS and Speech Guide](doc/guides/tts-and-speech.md).
- **ASR** — Parakeet batch, optional Voxtral realtime. See [Operator Stack and ASR Guide](doc/guides/operator-stack.md).
- **Looking Glass** WebXR support path

## System Flow Diagrams

Static exports: [High-Level Flow PNG](doc/diagrams/high-level-flow.png), [Sequence Timeline PNG](doc/diagrams/sequence-timeline.png), [High-Level Flow SVG](doc/diagrams/high-level-flow.svg), [Sequence Timeline SVG](doc/diagrams/sequence-timeline.svg)

### High-Level Flow

```mermaid
flowchart LR
  U[User]
  TMUX[tmux Terminal<br/>Agent pane]
  C[Coding Agent]
  MCP[MCP Server<br/>face_event / face_say / face_ping]
  WS[face-app<br/>WebSocket + HTTP :8765]
  FE[Frontend UI<br/>Browser]
  BR[operator-bridge]
  ASRP[/POST /api/operator/asr/]
  ASR[asr-worker<br/>Parakeet ASR<br/>JA/EN]
  TTS[tts-worker<br/>Kokoro TTS]
  TS[Tailscale VPN / serve]

  U -- Direct prompt --> TMUX
  U -- PTT recording --> FE
  U -- Text input --> FE

  FE -- Audio binary --> ASRP
  ASRP -- JSON (audioBase64,mimeType,lang) --> ASR
  ASR -- JSON transcript --> ASRP
  ASRP -- Transcript --> FE

  FE -- operator_response JSON --> WS
  WS -- relay --> BR
  BR -- tmux send-keys --> TMUX
  TMUX --> C
  C -- Work logs / results --> TMUX

  BR -- capture-pane (500ms, change-only) --> BR
  BR -- operator_terminal_snapshot --> WS
  WS --> FE

  C -- stdio tool calls --> MCP
  MCP -- WebSocket JSON --> WS
  WS --> FE

  WS -- say payload --> TTS
  TTS -- audio + tts state --> FE

  FE <-- HTTPS/WS --> TS
  TS <---> WS
```

### Sequence Timeline

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant TS as Tailscale (optional)
  participant FE as Frontend UI
  participant FA as face-app (:8765, /ws, /api/operator/asr)
  participant ASR as asr-worker (Parakeet)
  participant BR as operator-bridge
  participant TM as tmux (Agent pane)
  participant CX as Coding Agent
  participant MCP as mcp-server
  participant TTS as tts-worker (Kokoro)

  opt Remote access
    U->>TS: Open Face UI URL
    TS->>FE: Serve forwarded UI
  end

  FE->>FA: Connect WebSocket /ws
  BR->>FA: Connect WebSocket /ws

  alt Input path A: direct terminal prompt
    U->>TM: Type prompt
    TM->>CX: Prompt arrives
  else Input path B: frontend PTT
    U->>FE: Hold PTT JA/EN
    FE->>FA: POST /api/operator/asr?lang=ja|en (audio)
    FA->>ASR: /v1/asr/ja|en (audioBase64,mimeType)
    ASR-->>FA: Transcript JSON
    FA-->>FE: Transcript response
    U->>FE: Tap Send
    FE->>FA: operator_response{text}
    FA-->>BR: Relay payload
    BR->>TM: tmux send-keys(text + Enter)
    TM->>CX: Prompt arrives
  else Input path C: frontend text
    U->>FE: Enter text + Send Text
    FE->>FA: operator_response{text}
    FA-->>BR: Relay payload
    BR->>TM: tmux send-keys(text + Enter)
    TM->>CX: Prompt arrives
  end

  loop During work
    CX-->>TM: Progress/result logs
    BR->>TM: capture-pane -e (500ms)
    BR-->>FA: operator_terminal_snapshot
    FA-->>FE: Terminal mirror update
  end

  CX->>MCP: face_event / face_say / face_ping
  MCP->>FA: Forward WebSocket JSON
  FA-->>FE: event/say/state payloads

  FA->>TTS: TTS request
  TTS-->>FA: tts_audio / tts_mouth / say_result
  FA-->>FE: Realtime status + audio
  FE-->>U: Voice, facial state, and status updates
```

## Requirements

- Node.js 20+ (Node 24 recommended)
- `uv` (for Python worker dependencies)
- Python 3.10+
- `ffmpeg` (recommended; used by ASR worker fallback decode for webm/ogg/mp4)
- Optional for audible TTS on Linux:
  - either PortAudio (`libportaudio2`) for `sounddevice`
  - or ALSA `aplay` fallback

<a id="en-quick-start"></a>
## Quick Start

Choose one startup path depending on your goal.
Before starting, configure your coding agent for MCP (see [Agent Setup](#en-agent-setup)), set up the agent-specific `AGENTS.md`, and reflect `doc/examples/AGENT_RULES.md` in the agent instructions. If you want a ready-to-paste starting point, use `doc/examples/AGENTS.sample.md` as the template for your project-local `AGENTS.md`.

If you plan to use the mobile UI remotely, it is convenient to start Tailscale Serve in advance:

```bash
tailscale serve --bg 8765
```

### Binding to 0.0.0.0 for docker / remote agents

If an MCP client runs in docker or another network namespace, face-app must bind to a non-loopback address. Set `FACE_WS_HOST=0.0.0.0` in your shell environment.

When binding outside loopback, `MH_FACE_AUTH_TOKEN` is required. Use a long random token and keep the OS firewall/Tailscale boundary in place:

```bash
export FACE_WS_HOST=0.0.0.0
export MH_FACE_AUTH_TOKEN="$(openssl rand -base64 32)"
```

Without `MH_FACE_AUTH_TOKEN`, face-app refuses to start on `0.0.0.0`. The token protects the HTTP API and WebSocket endpoint; static UI files remain public so the browser can bootstrap and then attach the token to API/WS calls.

When bound to `0.0.0.0`, port 8765 is reachable from the LAN unless blocked. If you do not want LAN devices to reach it, deny the LAN interface explicitly at the OS firewall (leave `lo`, `tailscale0`, and `docker0` untouched so tailscale and containers still work):

```bash
sudo ufw deny in on <lan-interface> to any port 8765 proto tcp
```

Replace `<lan-interface>` with your actual Ethernet/Wi-Fi name (for example `enp129s0`, `eth0`, `wlan0`; check with `ip -brief addr`).

For Tailscale Serve, open the UI with the token once:

```text
https://<tailscale-host>:8443/?auth_token=<token>
```

The browser stores it in `sessionStorage`, and face-app also sets an `mh_face_auth` cookie for the same origin. The visible URL is then cleaned so mobile home-screen shortcuts do not need to keep the token in the URL.

Local browser access works the same way: open `http://127.0.0.1:8765/?auth_token=<token>` once and bookmark the resulting page. Without `?auth_token=...`, the static UI loads but `/api/agents/state` returns 401 and the dashboard shows `agent state error`.

If UFW (or another host firewall) is set to default deny incoming, Docker bridges from non-loopback containers to host ports `8765` / `8081` are also blocked. Allow the Docker default address pool explicitly. UFW is disabled on most distros until `sudo ufw enable`; check with `sudo ufw status`. If you are configuring UFW for the first time on a remote machine, run `sudo ufw allow OpenSSH` **before** `sudo ufw enable` to avoid locking yourself out.

```bash
sudo ufw allow from 172.16.0.0/12 to any port 8765 proto tcp comment 'docker → face-app'
sudo ufw allow from 172.16.0.0/12 to any port 8081 proto tcp comment 'docker → llm backend'
sudo ufw reload
```

`172.16.0.0/12` covers the stock Docker default address pool on Linux. Verify your actual bridges first:

```bash
docker network ls -q | xargs -I{} docker network inspect {} --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

If Docker has been reconfigured to a different pool (for example `10.200.0.0/16` via `daemon.json`), or if your LAN itself sits in `172.16/12` (some corporate networks do — check `ip -brief addr`), narrow the rule to the specific Docker network subnet (for example `172.20.0.0/16`) and pin that subnet in the compose / `docker network create` so it does not drift on recreation. With a typical home LAN (`192.168/16` or `10/8`) and stock Docker, the `172.16/12` rule keeps LAN and Tailnet (`100.64/10`) blocked.

The token must be present in the shell that starts face-app, the operator bridge, and any agent CLI whose MCP server forwards to face-app. If you keep it in `~/.config/minimum-headroom.env` sourced from `.bashrc`, also source it from `~/.profile` (or a launcher wrapper) so non-interactive and GUI-launched agents inherit it. Recovery from a 401 MCP WebSocket: `set -a; . ~/.config/minimum-headroom.env; set +a` in the launching shell, then restart the agent.

### Path A: Face + MCP (minimal)

From repository root:

```bash
./scripts/setup.sh
./scripts/run-face-app.sh
```

Then, in another terminal:

```bash
./scripts/run-mcp-server.sh
```

Use this path when you want the simple face UI and signaling, without the full operator panel workflow. `run-face-app.sh` hides the operator panel by default.

- If your coding agent already starts this repository's MCP server from its own MCP client config, do not also run `./scripts/run-mcp-server.sh`.
- By default, `face-app` starts `tts-worker` for you unless `FACE_TTS_ENABLED=0` is set. The default backend is Kokoro; if the `face-app` process is launched with `TTS_ENGINE=qwen3`, the spawned worker uses the optional Qwen3 path instead.

### Path B: Full Mobile Operator Stack (recommended)

After `./scripts/setup.sh`, recommended one-shot startup:

```bash
./scripts/run-operator-once.sh --profile realtime
```

Use this when you want the full tmux-backed operator workflow, browser PTT, terminal mirror, hidden mobile recovery, and the safest default bridge wiring. Start with `--profile default` or `--profile realtime` unless you specifically want Qwen3 TTS.

- `run-operator-once.sh` / `run-operator-stack.sh` launch `face-app`, and `face-app` starts `tts-worker` by default unless `FACE_TTS_ENABLED=0` is set. `qwen3` / `qwen3-realtime` profiles work by passing `TTS_ENGINE=qwen3` into that spawned worker path.
- `run-operator-once.sh` exports `MH_FACE_AGENT_ID=__operator__` / `MH_FACE_AGENT_LABEL=Operator` for the operator pane, and the integrated operator stack binds its optional MCP server to the same identity. Helper panes get their assigned helper id at spawn time; Docker-based helper commands receive it through `docker exec -e`.
- The MCP face tools auto-fill `agent_id` from `MH_FACE_AGENT_ID` when their MCP server process has that binding, and reject mismatched explicit ids with remediation guidance. If your MCP client runs a separate unbound server, pass `agent_id` explicitly on every `face_ping`, `face_event`, and `face_say` call, using `MH_FACE_AGENT_ID` as the source of truth.
- `--agent-cmd` controls only the primary operator pane. `MH_AGENT_DEFAULT_CMD` is the helper-agent launch template used by `face-app` when you add helpers later. If that helper template starts with `docker exec`, Minimum Headroom inserts the per-helper `MH_FACE_AGENT_ID` / `MH_FACE_AGENT_LABEL` with `docker exec -e`; otherwise it prefixes the helper command with `env ...`. See [Operator Stack Guide](doc/guides/operator-stack.md#docker-and-helper-agent-commands) for Docker examples.
- Profile shorthand:
  - `--profile default`: Kokoro TTS + batch ASR only
  - `--profile realtime`: Kokoro TTS + Voxtral realtime ASR + Parakeet fallback
  - `--profile qwen3`: Qwen3 TTS + batch ASR only
  - `--profile qwen3-realtime`: Qwen3 TTS + Voxtral realtime ASR + Parakeet fallback
- When you use this app to work on another repository, put a project-local `AGENTS.md` in that target repository too. Start from `doc/examples/AGENTS.sample.md`, then customize the repo-specific build/test/run rules there.
- For another repository, you can start the operator in either of these equivalent styles:
  - run from this repository and pass `--repo /path/to/target-repo`
  - or `cd` into the target repository and launch `/path/to/MinimumHeadroom/scripts/run-operator-once.sh ...`

After startup, multi-agent helpers can be spawned and managed from the browser UI or MCP tools. See the [Multi-Agent Guide](doc/guides/multi-agent.md) for the full workflow.

Useful variants:

```bash
# work on another repository while keeping minimum-headroom as the operator shell
./scripts/run-operator-once.sh --profile realtime --repo /path/to/target-repo

# work from the target repository itself and call the script by absolute path
cd /path/to/target-repo
/path/to/MinimumHeadroom/scripts/run-operator-once.sh --profile realtime

# start with a shell in the agent pane first
./scripts/run-operator-once.sh --profile realtime --agent-shell

# resume an existing Codex conversation
./scripts/run-operator-once.sh --agent-cmd 'codex resume --last'

# keep the current shell instead of attaching to tmux
./scripts/run-operator-once.sh --profile realtime --no-attach

# choose Qwen3 TTS only when you want that path explicitly
./scripts/run-operator-once.sh --profile qwen3-realtime
```

<a id="en-agent-setup"></a>
## Agent Setup

Do not commit your personal local config files.

### Claude Code

Add the MCP server via CLI:

```bash
claude mcp add --transport stdio \
  --env FACE_WS_URL=ws://127.0.0.1:8765/ws \
  minimum-headroom -- /ABS/PATH/minimum-headroom/scripts/run-bound-mcp-server.sh
```

See [Claude Code setup details](doc/examples/claude-code/README.md) for permission presets and security hardening.

### Codex CLI

Use `doc/examples/codex/config.toml` as a template. Place at `~/.codex/config.toml` or `.codex/config.toml` within a trusted project. Update absolute paths for your machine.

```toml
[mcp_servers.minimum_headroom]
command = "/ABS/PATH/minimum-headroom/scripts/run-bound-mcp-server.sh"
args = []
env = { "FACE_WS_URL" = "ws://127.0.0.1:8765/ws", "MCP_TOOL_NAME_STYLE" = "underscore" }
```

`run-bound-mcp-server.sh` starts the MCP server and preserves `MH_FACE_AGENT_ID` / `MH_FACE_AGENT_LABEL` from the current agent process or its parent process when available. This lets `face_ping`, `face_event`, and `face_say` omit `agent_id` in operator/helper panes that were launched by Minimum Headroom.

When face-app is bound outside loopback and requires `MH_FACE_AUTH_TOKEN`, the
same wrapper forwards `MH_FACE_AUTH_TOKEN` from the current environment, from a
parent process, or from `MH_FACE_ENV_FILE`. The default env file is
`~/.config/minimum-headroom.env`. Keep real tokens out of checked-in Codex
config files.

### Antigravity (CLI and GUI)

Both the `agy` terminal CLI and the Antigravity GUI (Electron desktop app) are supported. They share `~/.gemini/` but read MCP servers and skills from **different paths**, so the install steps differ — see [Antigravity setup details](doc/examples/antigravity/README.md) for the full matrix. The CLI uses `agy plugin install` into `~/.gemini/antigravity-cli/plugins/`; the GUI reads `~/.gemini/config/mcp_config.json` and looks for skills under `~/.gemini/config/plugins/`. Hooks can use `hooks.json`; current builds can also use the shared `~/.gemini/settings.json` snippet. Replace `/ABS/PATH/minimum-headroom` in `mcp_config.json`, `hooks.json`, and `settings-hooks.snippet.json` with the absolute path to your checkout first.

```bash
# 0. Edit doc/examples/antigravity/{mcp_config.json,hooks.json,settings-hooks.snippet.json}:
#    replace /ABS/PATH/minimum-headroom with the absolute path of your checkout.

# --- CLI (agy) -----------------------------------------------------------------
agy plugin install doc/examples/antigravity                   # idempotent
# optional: also drop the skill so /skills shows it
mkdir -p ~/.gemini/antigravity-cli/plugins/minimum-headroom/skills/minimum-headroom-ops
cp doc/examples/skills/minimum-headroom-ops/SKILL.md \
   ~/.gemini/antigravity-cli/plugins/minimum-headroom/skills/minimum-headroom-ops/SKILL.md

# --- GUI -----------------------------------------------------------------------
# 1. Merge mcp_config.json into ~/.gemini/config/mcp_config.json
#    (this file is often a 0-byte stub that silently breaks every MCP server until valid).
# 2. Drop plugin.json + the skill under ~/.gemini/config/plugins/minimum-headroom/
mkdir -p ~/.gemini/config/plugins/minimum-headroom/skills/minimum-headroom-ops
cp doc/examples/antigravity/plugin.json \
   ~/.gemini/config/plugins/minimum-headroom/plugin.json
cp doc/examples/skills/minimum-headroom-ops/SKILL.md \
   ~/.gemini/config/plugins/minimum-headroom/skills/minimum-headroom-ops/SKILL.md

# --- shared: hooks --------------------------------------------------------------
# Use doc/examples/antigravity/hooks.json, or merge settings-hooks.snippet.json into
# ~/.gemini/settings.json if your installed agy build does not load plugin hooks.
```

After installing, restart `agy` (CLI) and **fully quit + relaunch** the GUI (close-to-tray does not re-read configs). In `agy` type `/mcp`; in the GUI ask the chat `List every MCP tool you can call right now`. Both should list `minimum_headroom` with `face_event` / `face_say` / `face_ping` and the agent lifecycle tools.

See [Antigravity setup details](doc/examples/antigravity/README.md) for the path matrix, common failure modes (especially the 0-byte `mcp_config.json` trap on GUI), permission presets, and the `GEMINI.md` rule placement. The RMH voice-first launcher at `examples/rmh-voice-mode/start-rmh.sh --agent agy` handles the CLI plugin install automatically with the machine's path resolved.

### Agent Instructions

- Place an `AGENTS.md` in your target repository root (use `doc/examples/AGENTS.sample.md` as the starting template).
- Include signaling rules from `doc/examples/AGENT_RULES.md` in the agent instructions.
- For Claude Code, use `CLAUDE.md`; for Antigravity CLI (`agy`), use `GEMINI.md`; Codex CLI reads `AGENTS.md`.

### Real Minimum Headroom (RMH) voice-first launcher

If you have an AtomS3R running the firmware in `firmware/atoms3r-headroom/`, `examples/rmh-voice-mode/` is a turnkey workspace that makes any of Claude Code, Codex, or Antigravity CLI talk to you through the device. From there:

    examples/rmh-voice-mode/start-rmh.sh --agent {claude|codex|agy} [--model <id>]

The script auto-detects the repo root (no hard-coded paths), exports `MH_FACE_AGENT_ID=__operator__`, renders the per-CLI MCP config into a runtime directory, and launches the chosen CLI in this folder so it reads the voice-first rules in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`. For Codex, that generated config also includes hooks; for agy, the script installs the MCP plugin and leaves hook setup as the one-time Antigravity step documented above. Conservative light-model defaults (`haiku` for Claude, `gpt-5-mini` for Codex) keep RMH conversations responsive. See `examples/rmh-voice-mode/README.md` for details.

### Tool name style

If your MCP client rejects tool names with dots (for example `face.event`), set env `MCP_TOOL_NAME_STYLE=underscore`. Tools are then published as `face_event`, `face_say`, `face_ping`.

<a id="en-detailed-guides"></a>
## Detailed Guides

- [Operator Stack and ASR Guide](doc/guides/operator-stack.md#english) — launcher choice, tmux bridge, operator UI, keyboard shortcuts, hidden mobile recovery, batch/realtime ASR, Tailscale remote operation
- [TTS and Speech Guide](doc/guides/tts-and-speech.md#english) — Kokoro and Qwen3 setup, speech gate, long-speech behavior, pre-synthesis text normalization
- [Multi-Agent Guide](doc/guides/multi-agent.md#english) — spawning helpers, permission presets, mission assignment, owner inbox, worktree isolation, security hardening

## Hook Bridge (safety net for forgotten face_say)

`scripts/mh-hook.mjs` is a small wrapper that maps each agent runtime's hook
events to a `face_say` + `face_event` (and an owner-inbox entry for helpers),
so the face speaks even when the agent forgets to call `face_say` voluntarily.
Currently supports Claude Code, Codex (new `hooks` system + legacy `notify`
fallback), and Antigravity CLI.

Configuration:

- Per-runtime examples (drop-in JSON/TOML): `doc/hook-bridge/`
- Embedded in the per-runtime setup READMEs: `doc/examples/claude-code/README.md`, `doc/examples/codex/config.toml`, `doc/examples/antigravity/README.md`

The hook only fires when `MH_FACE_AGENT_ID` is set in the agent process
environment, so unrelated Claude/Codex/Antigravity sessions on the same machine are
unaffected. Templates (the lines spoken on each event) live at
`~/.minimum-headroom/face-templates.json`; if absent, the built-in
Japanese + English defaults are used. Language is auto-detected from the
agent's recent `face_say` history (CJK → `ja`, otherwise → `en`), with
`MH_FACE_LANG` as fallback.

Codex silently filters untrusted hooks at startup, so a one-time trust grant
is required after editing `~/.codex/config.toml`. The trust is persisted in
`[hooks.state.*]` at the user level — once granted, every subsequent Codex
session for that user (including helpers spawned by `agent.spawn`) inherits
it automatically. You do not need to enter individual helper panes. The
easiest way is `./scripts/grant-codex-hook-trust.sh` (spawns a transient
Codex inside a private tmux server, walks the trust UI, exits). Manually:
run any Codex once, type `/hooks`, walk the browser, and quit. Re-grant only
when you change a hook command or matcher. See `doc/hook-bridge/README.md`
for the full procedure.

## Optional Agent Skills

This repository includes reusable skill packages under `doc/examples/skills/`:

- `release-ci-flow`
- `minimum-headroom-ops`
- `looking-glass-webxr-setup`

Each folder contains a `SKILL.md` and can be copied into your local skills directory (for example `$CODEX_HOME/skills/`) if your agent supports local skill loading.

If you are using the minimum-headroom operator/helper runtime, install `minimum-headroom-ops`. It covers the expected MCP lifecycle flow (`agent.list`, `agent.spawn`, `agent.assign`, `agent.inject`, `agent.assignment.list`, `owner.inbox.*`, `agent.delete`), the stuck-helper recovery flow (`agent.pane_snapshot`, `agent.pane_send_key`), and the helper reporting contract.

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

- Verify ASR worker smoke:

```bash
npm run asr-worker:smoke
```

- Verify operator stack startup (inside tmux or with `MH_BRIDGE_TMUX_PANE` set):

```bash
./scripts/run-operator-stack.sh
```

## Repository Notes

- Runtime/local files (models, local MCP config, caches, venv) are excluded via `.gitignore`.

<a id="japanese"></a>

## 日本語

コーディングエージェント向けのフェイス・オペレーター支援アプリです。

## 目次

- [全体像（要点）](#ja-overview)
- [機能](#ja-features)
- [クイックスタート](#ja-quick-start)
- [エージェント設定](#ja-agent-setup)
- [詳細ガイド](#ja-detailed-guides)
- [English](#english)

<a id="ja-overview"></a>
## 全体像（要点）

- **スマホから PC のコーディングエージェントを操作** — モバイルブラウザで承認・入力・音声コマンドを送信できます。
- **Claude Code、Codex CLI、Antigravity CLI に対応** — ターミナルで動くエージェントなら何でも使えます。
- **tmux operator bridge** がブラウザ UI とエージェントペイン間の入出力を中継します。
- **3D フェイス + TTS + MCP シグナリング** でエージェントに声と表情を与え、状態をリアルタイムに反映します。
- **マルチエージェント対応**（実験的） — 分離 worktree に helper を生成し、権限プリセットとミッション追跡で管理します。[マルチエージェントガイド](doc/guides/multi-agent.md#japanese)を参照。
- **Tailscale Serve** でスマホ/タブレットから安全にリモートアクセス。

<a id="ja-features"></a>
## 機能

- **オペレーター入力** — 端末直接入力、ブラウザ PTT（JA/EN ASR）、テキスト入力、Desktop `Space`/`Shift+Space` 長押し安全装置、キー操作（`Esc`, `↑`, `Select`, `↓`）
- **ターミナルミラー** — tmux 末尾出力の読み取り専用スナップショット（500ms、変更時のみ）。実機の幅そのままで描画され、長い行は横スクロール。タッチ端末では指の位置を中心にピンチズーム、ダブルタップで等倍復帰
- **マルチエージェント**（実験的） — Desktop タイルまたは Mobile リストから helper の生成/フォーカス/削除、権限プリセット、ミッション割当・配信、owner inbox。バックグラウンドの stuck-detector が各 helper の tmux pane を監視し、既知の CLI モーダル（承認プロンプト、モデルピッカー、利用上限通知、サーベイ）を検出すると owner inbox に自動で `blocked` レポートを投函するので、ポーリング不要で停止に気づけます。[マルチエージェントガイド](doc/guides/multi-agent.md#japanese)を参照。
- **MCP シグナリング** — `face.event` / `face.say` / `face.ping` およびエージェントライフサイクルツール（`agent.list`, `agent.spawn`, `agent.focus`, `agent.delete`, `agent.assign`, `agent.assignment.list`, `agent.inject`, `agent.report`, `agent.pane_snapshot`, `agent.pane_send_key`, `owner.inbox.*`）
- **3D フェイス** — 眉・目・口・頭のアニメーション、状態モード（`confused`, `frustration`, `confidence`, `urgency`, `stuckness`, `neutral`）、ドラッグ制御、パネル切替
- **TTS** — Kokoro ONNX + Misaki 既定、任意 Qwen3-TTS 日本語 backend、鮮度優先発話ポリシー。[TTS and Speech Guide](doc/guides/tts-and-speech.md#japanese) を参照。
- **ASR** — Parakeet batch、任意 Voxtral realtime。[Operator Stack and ASR Guide](doc/guides/operator-stack.md#japanese) を参照。
- **Looking Glass** WebXR 対応経路

## システムフロー図

静的エクスポート: [High-Level Flow PNG](doc/diagrams/high-level-flow.png), [Sequence Timeline PNG](doc/diagrams/sequence-timeline.png), [High-Level Flow SVG](doc/diagrams/high-level-flow.svg), [Sequence Timeline SVG](doc/diagrams/sequence-timeline.svg)

### ハイレベルフロー

```mermaid
flowchart LR
  U[ユーザー]
  TMUX[tmux ターミナル<br/>Agent ペイン]
  C[Coding Agent]
  MCP[MCP サーバー<br/>face_event / face_say / face_ping]
  WS[face-app<br/>WebSocket + HTTP :8765]
  FE[フロントエンド UI<br/>ブラウザ]
  BR[operator-bridge]
  ASRP[/POST /api/operator/asr/]
  ASR[asr-worker<br/>Parakeet ASR<br/>JA/EN]
  TTS[tts-worker<br/>Kokoro TTS]
  TS[Tailscale VPN / serve]

  U -- 直接プロンプト --> TMUX
  U -- PTT録音 --> FE
  U -- テキスト入力 --> FE

  FE -- 音声バイナリ --> ASRP
  ASRP -- JSON (audioBase64,mimeType,lang) --> ASR
  ASR -- 文字起こしJSON --> ASRP
  ASRP -- 文字起こし結果 --> FE

  FE -- operator_response JSON --> WS
  WS -- relay --> BR
  BR -- tmux send-keys --> TMUX
  TMUX --> C
  C -- 作業ログ / 結果 --> TMUX

  BR -- capture-pane (500ms, change-only) --> BR
  BR -- operator_terminal_snapshot --> WS
  WS --> FE

  C -- stdio tool calls --> MCP
  MCP -- WebSocket JSON --> WS
  WS --> FE

  WS -- say payload --> TTS
  TTS -- audio + tts state --> FE

  FE <-- HTTPS/WS --> TS
  TS <---> WS
```

### 時系列シーケンス

```mermaid
sequenceDiagram
  autonumber
  participant U as ユーザー
  participant TS as Tailscale (任意)
  participant FE as Frontend UI
  participant FA as face-app (:8765, /ws, /api/operator/asr)
  participant ASR as asr-worker (Parakeet)
  participant BR as operator-bridge
  participant TM as tmux (Agent pane)
  participant CX as Coding Agent
  participant MCP as mcp-server
  participant TTS as tts-worker (Kokoro)

  opt リモートアクセス
    U->>TS: Face UI URLを開く
    TS->>FE: 転送されたUIを表示
  end

  FE->>FA: WebSocket /ws 接続
  BR->>FA: WebSocket /ws 接続

  alt 入力経路A: 端末直接入力
    U->>TM: プロンプトを入力
    TM->>CX: プロンプト到達
  else 入力経路B: フロントエンドPTT
    U->>FE: PTT JA/EN を押下
    FE->>FA: POST /api/operator/asr?lang=ja|en (audio)
    FA->>ASR: /v1/asr/ja|en (audioBase64,mimeType)
    ASR-->>FA: 文字起こしJSON
    FA-->>FE: 文字起こし結果
    U->>FE: Send を押下
    FE->>FA: operator_response{text}
    FA-->>BR: payload relay
    BR->>TM: tmux send-keys(text + Enter)
    TM->>CX: プロンプト到達
  else 入力経路C: フロントエンドテキスト
    U->>FE: テキスト入力 + Send Text
    FE->>FA: operator_response{text}
    FA-->>BR: payload relay
    BR->>TM: tmux send-keys(text + Enter)
    TM->>CX: プロンプト到達
  end

  loop 作業中
    CX-->>TM: 進捗/結果ログ
    BR->>TM: capture-pane -e (500ms)
    BR-->>FA: operator_terminal_snapshot
    FA-->>FE: ターミナルミラー更新
  end

  CX->>MCP: face_event / face_say / face_ping
  MCP->>FA: WebSocket JSON転送
  FA-->>FE: event/say/state payloads

  FA->>TTS: TTS request
  TTS-->>FA: tts_audio / tts_mouth / say_result
  FA-->>FE: リアルタイム状態 + 音声
  FE-->>U: 音声・表情・状態を表示
```

## 必要環境

- Node.js 20+（Node 24 推奨）
- `uv`（Python worker依存管理）
- Python 3.10+
- `ffmpeg`（推奨。ASR worker の webm/ogg/mp4 フォールバックデコードに使用）
- Linuxで音声出力する場合（任意）:
  - PortAudio (`libportaudio2`) + `sounddevice`
  - または ALSA `aplay`

<a id="ja-quick-start"></a>
## クイックスタート

目的に合わせて起動パスを選んでください。
開始前に、利用するコーディングエージェントで MCP 設定を行い（[エージェント設定](#ja-agent-setup) を参照）、エージェント向け `AGENTS.md` を設定し、`doc/examples/AGENT_RULES.md` の内容をエージェント指示へ反映してください。すぐ使えるひな形が必要なら、`doc/examples/AGENTS.sample.md` を project-local `AGENTS.md` のテンプレートとして使ってください。

モバイルUIをリモート利用する場合は、先に Tailscale Serve を起動しておくと便利です。

```bash
tailscale serve --bg 8765
```

### docker / リモートエージェント向けに 0.0.0.0 でバインドする場合

MCP クライアントが docker など別ネットワーク名前空間で動く構成では、face-app をループバック以外にバインドする必要があります。シェル環境で `FACE_WS_HOST=0.0.0.0` を設定してください。

ループバック外へバインドする場合、`MH_FACE_AUTH_TOKEN` が必須です。長いランダム token を設定し、OS firewall / Tailscale の境界も維持してください。

```bash
export FACE_WS_HOST=0.0.0.0
export MH_FACE_AUTH_TOKEN="$(openssl rand -base64 32)"
```

`MH_FACE_AUTH_TOKEN` がない状態で `0.0.0.0` にすると、face-app は起動を拒否します。この token は HTTP API と WebSocket を保護します。静的 UI ファイルは、ブラウザが先に起動してから API/WS に token を付けられるよう公開のままです。

`0.0.0.0` にすると、ブロックしない限り LAN からも 8765 に到達可能になります。LAN 端末から触らせたくない場合は、LAN インタフェースだけを OS ファイアウォールで明示的に拒否してください(`lo` / `tailscale0` / `docker0` には触らないので tailscale・コンテナはそのまま動きます):

```bash
sudo ufw deny in on <lan-interface> to any port 8765 proto tcp
```

`<lan-interface>` は実際の有線/Wi-Fi 名(例: `enp129s0`, `eth0`, `wlan0`、`ip -brief addr` で確認)に置き換えてください。

Tailscale Serve 経由では、初回だけ token 付き URL を開いてください。

```text
https://<tailscale-host>:8443/?auth_token=<token>
```

ブラウザは `sessionStorage` に token を保存し、face-app も同じ origin の `mh_face_auth` cookie を設定します。その後、表示 URL からは token を取り除くため、モバイルのホーム画面ショートカットに token 付き URL を残す必要はありません。

PC ブラウザのローカルアクセスも同じ手順です。`http://127.0.0.1:8765/?auth_token=<token>` を初回だけ開き、その状態をブックマークしておけば次回からはワンクリック。`?auth_token=...` 無しで開くと、静的 UI は読み込まれても `/api/agents/state` が 401 になり、ダッシュボードに `agent state error` が出ます。

UFW など host firewall を `default deny incoming` で運用している場合、Docker bridge から host:`8765` / `8081` への ingress も落ちるので、Docker デフォルト address pool を明示的に許可してください。多くのディストロでは UFW は `sudo ufw enable` を実行するまで無効です(`sudo ufw status` で確認)。リモートマシンで初めて UFW を設定するときは、ロックアウト防止のため `sudo ufw enable` の **前**に `sudo ufw allow OpenSSH` を入れてください。

```bash
sudo ufw allow from 172.16.0.0/12 to any port 8765 proto tcp comment 'docker → face-app'
sudo ufw allow from 172.16.0.0/12 to any port 8081 proto tcp comment 'docker → llm backend'
sudo ufw reload
```

`172.16.0.0/12` は Linux 上の標準 Docker のデフォルトアドレスプールをカバーする範囲です。まず実際の bridge を確認してください:

```bash
docker network ls -q | xargs -I{} docker network inspect {} --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

`daemon.json` の `default-address-pools` で別レンジ(例: `10.200.0.0/16`)に変更している場合や、LAN 自体が `172.16/12` を採番している場合(企業 LAN にときどきあります、`ip -brief addr` で確認)は、特定 Docker network の subnet(例: `172.20.0.0/16`)に置き換え、`docker network create` / compose 側で subnet を固定して再作成時のずれを防いでください。家庭 LAN(`192.168/16` か `10/8`)+ 標準 Docker という典型構成なら、`172.16/12` ルールで LAN と Tailnet (`100.64/10`) は引き続き拒否されます。

token は、face-app・operator bridge・MCP forwarding を行う agent CLI を **起動するシェル**に存在している必要があります。`~/.config/minimum-headroom.env` を `.bashrc` から source している場合、非対話シェルや GUI 起動からは引き継がれません。`~/.profile` でも source するか、起動ラッパーで env を渡してください。MCP の WebSocket が 401 で落ちたときは、起動シェルで `set -a; . ~/.config/minimum-headroom.env; set +a` してから agent を立て直すと復旧します。

### Path A: Face + MCP（最小構成）

```bash
./scripts/setup.sh
./scripts/run-face-app.sh
```

その後、別ターミナルで:

```bash
./scripts/run-mcp-server.sh
```

これは、シンプルな face UI とシグナリングだけを使いたいとき向けです。`run-face-app.sh` は既定で operator panel を隠します。

- 利用中のコーディングエージェントが MCP クライアント設定からこのリポジトリの MCP サーバーを自動起動する場合、`./scripts/run-mcp-server.sh` は二重起動しないでください。
- 既定では `face-app` が `tts-worker` を子プロセス起動するため、`FACE_TTS_ENABLED=0` にしていない限り別ターミナルでの起動は不要です。既定 backend は Kokoro で、`face-app` 側を `TTS_ENGINE=qwen3` 付きで起動すると任意の Qwen3 worker 経路を使います。

### Path B: フルモバイル Operator Stack（推奨）

`./scripts/setup.sh` 実行後の推奨 1 発起動:

```bash
./scripts/run-operator-once.sh --profile realtime
```

これは、tmux 連携、browser PTT、terminal mirror、隠し復旧、bridge の安全な既定配線まで含む、いちばん実用的な構成です。特に Qwen3 TTS を使いたい理由がなければ、`--profile default` か `--profile realtime` から始めてください。

- `run-operator-once.sh` / `run-operator-stack.sh` は `face-app` を起動し、その `face-app` が既定で `tts-worker` を子起動します。`FACE_TTS_ENABLED=0` を指定しない限り、別ターミナルでの TTS 起動は不要です。`qwen3` / `qwen3-realtime` profile は、この子起動 worker に `TTS_ENGINE=qwen3` を渡して切り替えます。
- `run-operator-once.sh` は operator pane に `MH_FACE_AGENT_ID=__operator__` / `MH_FACE_AGENT_LABEL=Operator` を export し、統合 operator stack の任意起動 MCP server も同じ identity に束縛します。helper pane は spawn 時に割り当てられた helper id を受け取り、Docker 経由の helper command には `docker exec -e` でコンテナ内へ渡されます。
- MCP face tools は MCP server process に `MH_FACE_AGENT_ID` がある場合、`agent_id` を自動補完し、明示された id が束縛値と違う場合は対応方法つきで拒否します。MCP client が別の未束縛 server を起動する構成では、`MH_FACE_AGENT_ID` を正として `face_ping` / `face_event` / `face_say` の全 call に `agent_id` を明示してください。
- `--agent-cmd` は primary operator pane だけを指定します。`MH_AGENT_DEFAULT_CMD` は、あとで helper を追加するときに `face-app` が使う helper-agent 起動テンプレートです。この helper テンプレートが `docker exec` で始まる場合、Minimum Headroom は helper ごとの `MH_FACE_AGENT_ID` / `MH_FACE_AGENT_LABEL` を `docker exec -e` で挿入します。Docker でない場合は `env ...` を command の前に付けます。Docker の具体例は[Operator Stack Guide](doc/guides/operator-stack.md#ja-docker-and-helper-agent-commands)を参照してください。
- profile の意味:
  - `--profile default`: Kokoro TTS + batch ASR のみ
  - `--profile realtime`: Kokoro TTS + Voxtral realtime ASR + Parakeet fallback
  - `--profile qwen3`: Qwen3 TTS + batch ASR のみ
  - `--profile qwen3-realtime`: Qwen3 TTS + Voxtral realtime ASR + Parakeet fallback
- このアプリを使って別の作業リポジトリを扱う場合は、その target repository 側にも project-local な `AGENTS.md` を置いてください。`doc/examples/AGENTS.sample.md` を出発点にして、その repo 固有の build/test/run ルールを追記するのが簡単です。
- 別の作業リポジトリで使う起動方法は、次の 2 通りが実用的です。
  - このリポジトリ側から `--repo /path/to/target-repo` を付けて起動する
  - target repository 側へ `cd` してから `/path/to/MinimumHeadroom/scripts/run-operator-once.sh ...` を呼ぶ

起動後のマルチエージェント操作については[マルチエージェントガイド](doc/guides/multi-agent.md#japanese)を参照してください。

よく使う派生例:

```bash
# minimum-headroom を operator shell として使いながら、別 repo を作業対象にする
./scripts/run-operator-once.sh --profile realtime --repo /path/to/target-repo

# target repository 側から absolute path で script を呼ぶ
cd /path/to/target-repo
/path/to/MinimumHeadroom/scripts/run-operator-once.sh --profile realtime

# まず agent ペインをシェルだけで開く
./scripts/run-operator-once.sh --profile realtime --agent-shell

# 直前の Codex セッションを再開
./scripts/run-operator-once.sh --agent-cmd 'codex resume --last'

# 起動だけ行い、現在のシェルを維持
./scripts/run-operator-once.sh --profile realtime --no-attach

# Qwen3 TTS を使いたい時だけ明示的に選ぶ
./scripts/run-operator-once.sh --profile qwen3-realtime
```

<a id="ja-agent-setup"></a>
## エージェント設定

個人用ローカル設定ファイルはリポジトリにコミットしないでください。

### Claude Code

CLI で MCP サーバーを追加:

```bash
claude mcp add --transport stdio \
  --env FACE_WS_URL=ws://127.0.0.1:8765/ws \
  minimum-headroom -- /ABS/PATH/minimum-headroom/scripts/run-bound-mcp-server.sh
```

権限プリセットとセキュリティ強化の詳細は [Claude Code setup](doc/examples/claude-code/README.md) を参照。

### Codex CLI

`doc/examples/codex/config.toml` をテンプレートとして使い、`~/.codex/config.toml` またはプロジェクト内 `.codex/config.toml` に配置。絶対パスは各自の環境に合わせてください。

```toml
[mcp_servers.minimum_headroom]
command = "/ABS/PATH/minimum-headroom/scripts/run-bound-mcp-server.sh"
args = []
env = { "FACE_WS_URL" = "ws://127.0.0.1:8765/ws", "MCP_TOOL_NAME_STYLE" = "underscore" }
```

`run-bound-mcp-server.sh` は MCP server を起動し、可能な場合は現在の agent process または親 process から `MH_FACE_AGENT_ID` / `MH_FACE_AGENT_LABEL` を引き継ぎます。Minimum Headroom から起動された operator/helper pane では、これにより `face_ping` / `face_event` / `face_say` の `agent_id` 省略が可能になります。

face-app をループバック外に bind して `MH_FACE_AUTH_TOKEN` が必要な場合、
同じ wrapper は現在の環境・親 process・`MH_FACE_ENV_FILE` から
`MH_FACE_AUTH_TOKEN` を転送します。既定の env file は
`~/.config/minimum-headroom.env` です。実 token は Codex config に
チェックインしないでください。

### Antigravity (CLI と GUI)

`agy` ターミナル CLI と Antigravity GUI (Electron アプリ) の両方に対応します。両者は `~/.gemini/` を共有しますが **MCP サーバ・skill の読み取りパスが異なる**ので、導入手順も別です — 詳細マトリクスは [Antigravity setup](doc/examples/antigravity/README.md) を参照。CLI は `agy plugin install` で `~/.gemini/antigravity-cli/plugins/` へ、GUI は `~/.gemini/config/mcp_config.json` を直接読み、skill は `~/.gemini/config/plugins/` 配下を見ます。hook は `hooks.json` を利用できます。現行 build では共有 `~/.gemini/settings.json` snippet も使えます。事前に `mcp_config.json`、`hooks.json`、`settings-hooks.snippet.json` の `/ABS/PATH/minimum-headroom` をご自分のチェックアウトの絶対パスへ置換してください。

```bash
# 0. doc/examples/antigravity/{mcp_config.json,hooks.json,settings-hooks.snippet.json} の
#    /ABS/PATH/minimum-headroom を絶対パスへ置換

# --- CLI (agy) ---
agy plugin install doc/examples/antigravity                   # 冪等
# 任意: skill も入れて /skills に出るようにする
mkdir -p ~/.gemini/antigravity-cli/plugins/minimum-headroom/skills/minimum-headroom-ops
cp doc/examples/skills/minimum-headroom-ops/SKILL.md \
   ~/.gemini/antigravity-cli/plugins/minimum-headroom/skills/minimum-headroom-ops/SKILL.md

# --- GUI ---
# 1. ~/.gemini/config/mcp_config.json に mcp_config.json をマージ
#    （このファイルが 0 バイトだと全 MCP が無音で落ちるトラップ。要確認）
# 2. plugin.json + skill を ~/.gemini/config/plugins/minimum-headroom/ 配下に配置
mkdir -p ~/.gemini/config/plugins/minimum-headroom/skills/minimum-headroom-ops
cp doc/examples/antigravity/plugin.json \
   ~/.gemini/config/plugins/minimum-headroom/plugin.json
cp doc/examples/skills/minimum-headroom-ops/SKILL.md \
   ~/.gemini/config/plugins/minimum-headroom/skills/minimum-headroom-ops/SKILL.md

# --- 共通: hook ---
# doc/examples/antigravity/hooks.json を使うか、plugin hooks を読まない agy build では
# settings-hooks.snippet.json を ~/.gemini/settings.json にマージ
```

インストール後 `agy` を再起動、GUI は **完全終了 → 再起動** (タスクトレイに残ったままだと設定を読み直しません)。CLI なら `/mcp`、GUI ならチャットで `List every MCP tool you can call right now` と聞くと `minimum_headroom` の `face_event` / `face_say` / `face_ping` 及び agent ライフサイクルツールが列挙されます。

詳細パスマトリクス、よくある失敗パターン (特に GUI の 0 バイト `mcp_config.json` トラップ)、権限プリセット、`GEMINI.md` ルール配置は [Antigravity setup](doc/examples/antigravity/README.md) を参照。RMH voice-first ランチャ `examples/rmh-voice-mode/start-rmh.sh --agent agy` は CLI のプラグインインストールをマシン固有のパス解決込みで自動実行します。

### Hook ブリッジ（face_say の安全網）

エージェントが `face_say` を呼び忘れて承認待ちで沈黙した場合や、最終 report なしで turn が終わった場合に、ランタイムの hook 機構から自動的に face を喋らせる仕組みです。Claude Code / Codex（新 `hooks` 系）/ Antigravity CLI に対応。

- ドロップインの設定例: `doc/hook-bridge/`
- 各ランタイムの setup README（Claude / Codex / Antigravity）にも同じスニペットを掲載
- 詳細な設定手順: `doc/hook-bridge/README.md`

`MH_FACE_AGENT_ID` が agent process に設定されていないとき hook は何もせず exit 0 で終了するため、関係ない別 session には影響しません。発話テンプレートは `~/.minimum-headroom/face-templates.json` で上書き可能（無い場合は日本語 + 英語の組込みデフォルト）。言語は直近の `face_say` 履歴から自動判定（CJK 文字 → `ja`、それ以外 → `en`）、`MH_FACE_LANG` がフォールバック。

Codex は user-defined hook を起動時に untrusted として silent skip するため、`~/.codex/config.toml` に hook 設定を追加した後に **1 回だけ** trust 付与が必要です。trust は user-level の `[hooks.state.*]` に永続化されるので、同じユーザーで起動する以降の全 codex プロセス（operator が spawn する helper も含む）が自動的に trust 状態を引き継ぎます。helper pane に毎回入って trust 操作する必要はありません。

最も簡単なのは同梱の `./scripts/grant-codex-hook-trust.sh` を実行する方法（裏側で短命 codex を 1 つ立てて自動的に trust → 終了）。手動でやる場合は普段使いの codex で 1 回 `/hooks` を開いて trust → 閉じる、で同じ効果。再 trust が必要になるのは hook の command/matcher を編集したときだけです。詳細は `doc/hook-bridge/README.md`。

### エージェント指示の設定

- target repository のルートに `AGENTS.md` を配置（`doc/examples/AGENTS.sample.md` をテンプレートとして使用）。
- `doc/examples/AGENT_RULES.md` のシグナリング規約をエージェント指示に含める。
- Claude Code は `CLAUDE.md`、Antigravity CLI (`agy`) は `GEMINI.md`、Codex CLI は `AGENTS.md` を読み込みます。

### Real Minimum Headroom (RMH) 音声優先ランチャ

AtomS3R に `firmware/atoms3r-headroom/` のファームを焼いた物理デバイスがある場合、`examples/rmh-voice-mode/` は Claude Code / Codex / Antigravity CLI のいずれでも AtomS3R で音声会話するためのワークスペース雛形です。

    examples/rmh-voice-mode/start-rmh.sh --agent {claude|codex|agy} [--model <id>]

スクリプトはリポジトリのルートを自動検出（ハードコーディングなし）し、`MH_FACE_AGENT_ID=__operator__` を export、CLI 別の MCP 設定をランタイムディレクトリへ展開してから、このフォルダ内で CLI を起動します。Codex では生成 config に hook も含めます。agy では MCP plugin をインストールし、hook 設定は上記 Antigravity 手順の 1 回限りの設定として残します。これにより `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` の voice-first ルールが読み込まれ、回答は `face_say` で音声化されます。軽量モデル既定（Claude=`haiku`, Codex=`gpt-5-mini`）で RMH 会話のレスポンスを軽快に保ちます。詳細は `examples/rmh-voice-mode/README.md` を参照。

### ツール名スタイル

MCP クライアントがドット付きツール名（例: `face.event`）を受け付けない場合は、環境変数 `MCP_TOOL_NAME_STYLE=underscore` を設定。ツールは `face_event`, `face_say`, `face_ping` として公開されます。

<a id="ja-detailed-guides"></a>
## 詳細ガイド

- [Operator Stack and ASR Guide](doc/guides/operator-stack.md#japanese) — 起動スクリプトの選び方、tmux bridge、operator UI、キーボードショートカット、batch / realtime ASR、隠し復旧、Tailscale リモート運用
- [TTS and Speech Guide](doc/guides/tts-and-speech.md#japanese) — Kokoro / Qwen3 のセットアップ、発話ゲート、長文発話、発話前の正規化
- [マルチエージェントガイド](doc/guides/multi-agent.md#japanese) — helper の生成、権限プリセット、ミッション割当、owner inbox、worktree 分離、セキュリティ強化

## オプションスキル

`doc/examples/skills/` に再利用可能なスキルを同梱しています。

- `release-ci-flow`
- `minimum-headroom-ops`
- `looking-glass-webxr-setup`

各フォルダには `SKILL.md` があり、対応エージェントではローカルスキルディレクトリ（例: `$CODEX_HOME/skills/`）へコピーして利用できます。

minimum-headroom の operator/helper runtime を使う場合は、`minimum-headroom-ops` の導入を推奨します。`agent.list`, `agent.spawn`, `agent.assign`, `agent.inject`, `agent.assignment.list`, `owner.inbox.*`, `agent.delete` の標準フロー、`agent.pane_snapshot` / `agent.pane_send_key` による stuck helper 復旧フロー、helper report の規約をまとめています。

## リリースチェックリスト

- テスト実行:

```bash
npm test
```

- MCP起動確認:

```bash
./scripts/run-mcp-server.sh
```

- face-app起動とブラウザ表示確認:

```bash
./scripts/run-face-app.sh
```

- TTS worker smoke確認:

```bash
npm run tts-worker:smoke
```

- ASR worker smoke確認:

```bash
npm run asr-worker:smoke
```

- operator stack起動確認（tmux内 or `MH_BRIDGE_TMUX_PANE` 指定）:

```bash
./scripts/run-operator-stack.sh
```

## 補足

- 実行時ローカルファイル（モデル、ローカルMCP設定、キャッシュ、venv など）は `.gitignore` で除外されています。
