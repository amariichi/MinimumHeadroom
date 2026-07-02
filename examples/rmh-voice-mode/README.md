# Real Minimum Headroom — Voice-First Agent Mode

This directory turns any of **Claude Code**, **Codex CLI**, or **Antigravity CLI (agy)** into a voice-first agent that talks to you through the AtomS3R desk device (Real Minimum Headroom, RMH).

The goal: you press push-to-talk on the AtomS3R, speak a request, and the agent speaks the answer back through the AtomS3R — no terminal needed.

## Prerequisites

1. The minimum-headroom operator stack is already running (`face-app` on the configured `FACE_WS_URL`, AtomS3R bridge alive).
2. The AtomS3R firmware in `firmware/atoms3r-headroom/` is flashed, connected to Wi-Fi, and provisioned against the same `face-app`.
3. The CLI you want to use is installed (`claude`, `codex`, or `agy`).

If any of those are missing, see the top-level `README.md` first.

## Quick start

```bash
# From anywhere on disk:
$REPO/examples/rmh-voice-mode/start-rmh.sh --agent claude
$REPO/examples/rmh-voice-mode/start-rmh.sh --agent codex
$REPO/examples/rmh-voice-mode/start-rmh.sh --agent agy
```

Replace `$REPO` with the path to your minimum-headroom checkout. The script auto-detects its own repo root, so no paths are hard-coded.

Optional flags:

```bash
start-rmh.sh --agent claude --model sonnet           # heavier model for a hard task
start-rmh.sh --agent codex  --model gpt-5            # override the default light model
start-rmh.sh --agent codex  --with-vision            # start/reuse the M12 vision backend first
start-rmh.sh --agent codex  -- exec "fix the failing test"   # extra args after -- pass through
```

## Vision backend (AtomS3R-M12 + diffusiongemma)

`--with-vision` starts or reuses the M12 camera backend before the agent CLI opens. You can also set `RMH_WITH_VISION=1` for the same behavior:

```bash
RMH_WITH_VISION=1 $REPO/examples/rmh-voice-mode/start-rmh.sh --agent codex
```

Prerequisites:

1. AtomS3R-M12 firmware is flashed, connected to Wi-Fi, and provisioned against the same `face-app`.
2. `~/.config/minimum-headroom.env` exists and contains `MH_FACE_AUTH_TOKEN`.
3. A GPU is available and the diffusiongemma weights are already set up with `scripts/setup-vllm-diffusiongemma.sh`.

Cold-boot sequence:

1. Start the operator stack once:

   ```bash
   $REPO/scripts/run-operator-once.sh
   ```

   If the operator stack already exists, restart it in place instead:

   ```bash
   $REPO/scripts/restart-operator-stack-in-place.sh
   ```

2. Launch the voice-mode CLI and include the vision backend:

   ```bash
   $REPO/examples/rmh-voice-mode/start-rmh.sh --agent codex --with-vision
   ```

The vision startup path calls `scripts/run-vision-stack.sh` synchronously. A cold diffusiongemma/vLLM load can take several minutes; if the vision backend fails to become available, the launcher prints a warning and continues into voice mode without vision. For detailed vision-worker environment variables, see `vision-worker/README.md`.

## What the script does

1. Resolves `MH_REPO_ROOT` from its own location (override with `MH_REPO_ROOT=...`).
2. Exports `MH_FACE_AGENT_ID=__operator__`, `MH_FACE_SESSION_ID=operator`, `FACE_WS_URL`, so the MCP server can auto-fill `agent_id` / `session_id` on every `face_say` / `face_event` / `face_ping`.
3. When `--with-vision` or `RMH_WITH_VISION=1` is set, runs `scripts/run-vision-stack.sh` before launching the CLI.
4. Renders per-CLI runtime config from `templates/` into a temporary runtime directory (`$XDG_RUNTIME_DIR/rmh-voice-mode/<pid>/`) — never written into the repo. Codex gets MCP + hook config; Claude and agy get MCP config, with agy hooks handled as a one-time Antigravity setup because the hook file is shared with the user's other customizations.
5. Launches the chosen CLI from this directory, so the agent picks up the voice-first rules in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`.

For agy, the script renders the minimum-headroom plugin from `templates/antigravity-plugin/` into a per-launch temp dir (with `MH_REPO_ROOT` resolved) and runs `agy plugin install` on it. The plugin is installed idempotently into `~/.gemini/antigravity-cli/plugins/minimum-headroom/`, so re-launches simply overwrite the previous install. Hooks are NOT touched: Antigravity hook configuration is shared with the user's other customizations. Use `doc/examples/antigravity/hooks.json`, or merge `doc/examples/antigravity/settings-hooks.snippet.json` into `~/.gemini/settings.json` if your installed agy build does not load plugin hooks. See `doc/examples/antigravity/README.md` for details.

## The voice-first rules

`CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` in this directory are **auto-generated** copies of the same source — `tools/voice-first-rules.md`. They tell the agent to:

- speak the **substantive answer** through `face_say`, not just status milestones;
- pass long text in one `face_say` call (the server chunks it at sentence boundaries with `MH_TTS_CHUNK_MAX_CHARS=64`);
- avoid screen-only language ("as shown", "the diff below");
- emit `face_event(permission_required)` plus `face_say(priority=3, policy=interrupt)` before every approval prompt;
- summarize stack traces / diffs / URLs verbally instead of reading them character-by-character.

After editing the source, regenerate the three CLI-facing copies:

```bash
tools/regenerate-rules.sh
```

## Model defaults

The script picks light models by default — adequate for short conversational turns over voice:

| CLI    | Default                  | Override                        |
|--------|--------------------------|---------------------------------|
| claude | `haiku`                  | `--model sonnet` etc.            |
| codex  | `gpt-5-mini`             | `--model <id>` or `-c model=...` |
| agy    | (read from `~/.gemini/antigravity-cli/settings.json`) | edit settings.json — agy has no `--model` flag |

Override the script defaults globally with environment variables:

```bash
export RMH_DEFAULT_MODEL_CLAUDE=sonnet
export RMH_DEFAULT_MODEL_CODEX=gpt-5
```

## Idle-hook suppression

`start-rmh.sh` exports `MH_HOOK_SUPPRESS_EVENTS=idle_after_response` so the hook bridge's "作業が止まっているかもしれません" / "I may be stuck waiting." fallback is silenced. In voice-first mode the agent itself speaks every turn end through `face_say`, so the safety-net phrase is redundant noise. `permission_required` is still delivered normally (it is the safety net we actually want).

To restore the idle phrase for a single launch, pass `MH_HOOK_SUPPRESS_EVENTS=` (empty) on the command line:

```bash
MH_HOOK_SUPPRESS_EVENTS= ./start-rmh.sh --agent claude
```

To suppress additional events, list them comma-separated: `MH_HOOK_SUPPRESS_EVENTS=idle_after_response,permission_required`. This is per-launch — the global hook bridge configuration is unchanged.

## Auth tokens

If `face-app` is bound outside loopback and requires `MH_FACE_AUTH_TOKEN`, the bundled `scripts/run-bound-mcp-server.sh` already forwards the token from the current environment, from a parent process, or from `~/.config/minimum-headroom.env`. Do not put real tokens in any file under this directory.

## First-launch quirks

- **Codex hook trust.** Codex marks user-defined hooks as untrusted until you trust them inside the TUI. After the first launch, run `scripts/grant-codex-hook-trust.sh` once, or open codex interactively and type `/hooks` to trust each event row.
- **Agy MCP loaded.** After `--agent agy` starts, type `/mcp` inside the agy TUI to confirm `minimum_headroom` is listed. If it shows zero servers, the plugin install step probably failed — run `agy plugin list` to check, and `agy plugin validate $XDG_RUNTIME_DIR/rmh-voice-mode/<pid>/agy-plugin/minimum-headroom` to see the error. The plugin install is idempotent; you can also install manually with `agy plugin install doc/examples/antigravity` (after editing the absolute path in `mcp_config.json`).
- **Claude MCP scope.** This script uses `claude --mcp-config <generated.json>` so the MCP registration is scoped to the launched process; nothing is added to your global `~/.claude.json`.

## Troubleshooting

- **The face does not speak.** Confirm the operator stack is up (`scripts/restart-operator-stack-in-place.sh` if needed), confirm the AtomS3R bridge tmux pane is alive, and confirm `FACE_AUDIO_TARGET` is `browser` (recommended) or `both`. `browser` is preferred for RMH because the TTS worker's remote prefetch + the Atom-side WAV FIFO only engage in that mode, giving the shortest inter-chunk gaps on long answers; `both` also forwards `tts_audio` to the bridge but disables prefetch so remote playback falls back to the older synthesize-then-play pacing.
- **Audio plays but mouth does not move.** The agent is probably calling `face_say` with the wrong `agent_id`. This script sets `MH_FACE_AGENT_ID=__operator__`; if the agent is overriding it manually, fix that in your prompt.
- **Long answers play as voice-then-silence.** A chunk likely exceeded the Atom HTTP ingress cap. Confirm `MH_TTS_CHUNK_MAX_CHARS=64` is in effect on the running stack (`scripts/run-operator-stack.sh` sets it as the default).
