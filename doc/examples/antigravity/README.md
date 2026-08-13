# Antigravity setup (CLI and GUI)

Antigravity ships in two shapes — the `agy` terminal CLI and the Electron desktop app (Antigravity GUI). They share `~/.gemini/` but **read MCP servers and skills from different paths**. This directory contains files that work for both; the difference is where you put them.

| Layer        | Antigravity CLI (`agy`)                              | Antigravity GUI                                          |
|--------------|------------------------------------------------------|----------------------------------------------------------|
| MCP servers  | per-plugin `mcp_config.json` (installed via `agy plugin install`) | global `~/.gemini/config/mcp_config.json` |
| Skills       | per-plugin `skills/<name>/SKILL.md` under `~/.gemini/antigravity-cli/plugins/<plugin>/` | per-plugin `skills/<name>/SKILL.md` under `~/.gemini/config/plugins/<plugin>/` |
| Hooks        | plugin/workspace `hooks.json`; current builds can also use shared `~/.gemini/settings.json` snippets | same `hooks.json` / shared settings behavior |
| Install path | `~/.gemini/antigravity-cli/plugins/<name>/`         | `~/.gemini/config/plugins/<name>/`                       |

Files shipped here:

| File                                | Purpose                                                       |
|-------------------------------------|---------------------------------------------------------------|
| `plugin.json`                       | plugin manifest (name, version, description, etc.)            |
| `mcp_config.json`                   | MCP server registration for `minimum_headroom`, including `VISION_BASE_URL` for host-side vision tools |
| `hooks.json`                        | Antigravity JSON Hooks example for plugin/workspace installs  |
| `settings-hooks.snippet.json`       | Compatibility hook entries to merge into `~/.gemini/settings.json` |
| (skill source)                      | canonical `~/.agents/skills/<name>/SKILL.md`, with `doc/examples/skills` as a portable fallback |

Before any of the steps below, **replace `/ABS/PATH/minimum-headroom`** in `mcp_config.json`, `hooks.json`, and `settings-hooks.snippet.json` with the absolute path of your checkout (for example, `/path/to/minimum-headroom`).

For manual skill copies, resolve the same canonical-first sources used by the
RMH launcher. These are shell variables for the commands below:

    SHARED_SKILLS_DIR="${MH_SHARED_SKILLS_DIR:-$HOME/.agents/skills}"
    MH_OPS_SKILL="$SHARED_SKILLS_DIR/minimum-headroom-ops/SKILL.md"
    MH_VISION_SKILL="$SHARED_SKILLS_DIR/atoms3r-vision/SKILL.md"
    [[ -f "$MH_OPS_SKILL" ]] || MH_OPS_SKILL=doc/examples/skills/minimum-headroom-ops/SKILL.md
    [[ -f "$MH_VISION_SKILL" ]] || MH_VISION_SKILL=doc/examples/skills/atoms3r-vision/SKILL.md

---

## Antigravity CLI (`agy`)

From the repository root:

    agy plugin install doc/examples/antigravity

`agy plugin install` is idempotent — re-running it overwrites the previous install. The plugin lands at `~/.gemini/antigravity-cli/plugins/minimum-headroom/`. Verify:

    agy plugin list   # → minimum-headroom, source "local-install"

On agy 1.0.16, `agy plugin install` may validate hooks/skills but still leave
the CLI plugin directory with only `plugin.json` and `mcp_config.json`.
`examples/rmh-voice-mode/start-rmh.sh --agent agy` works around that by copying
the rendered plugin into `~/.gemini/antigravity-cli/plugins/minimum-headroom/`
after install. If you install manually and `agy plugin validate
~/.gemini/antigravity-cli/plugins/minimum-headroom` reports `skills: skipped`
or `hooks: skipped`, copy the rendered plugin files into that directory too.

The plugin includes MCP server registration. If you install through
`examples/rmh-voice-mode/start-rmh.sh --agent agy`, the launcher also copies the
`minimum-headroom-ops` and `atoms3r-vision` skills into the generated plugin so
`/skills` can see both. For a manual install from this directory, install those
skills alongside the MCP plugin if your `agy` build does not copy them:

    mkdir -p ~/.gemini/antigravity-cli/plugins/minimum-headroom/skills/minimum-headroom-ops
    mkdir -p ~/.gemini/antigravity-cli/plugins/minimum-headroom/skills/atoms3r-vision
    cp "$MH_OPS_SKILL" \
       ~/.gemini/antigravity-cli/plugins/minimum-headroom/skills/minimum-headroom-ops/SKILL.md
    cp "$MH_VISION_SKILL" \
       ~/.gemini/antigravity-cli/plugins/minimum-headroom/skills/atoms3r-vision/SKILL.md

Restart `agy`, type `/mcp` inside the TUI to confirm `minimum_headroom` is loaded.

### Shared skill source

On hosts that centralize reusable skills under `~/.agents/skills` and expose
them to coding agents with symlinks, `start-rmh.sh` treats that directory as the
source of truth. It copies the current `minimum-headroom-ops` and
`atoms3r-vision` contents into the rendered agy plugin because plugin packages
need concrete files. Set `MH_SHARED_SKILLS_DIR` to use a different canonical
directory. If a canonical file is absent, the launcher falls back to
`doc/examples/skills`; it never modifies the shared source.
The checked-in fallback files are portable snapshots, not symlinks into one
user's home directory. Keep machine-specific paths and private instructions in
the shared source rather than adding them to those snapshots.

### Print mode on agy 1.1.1

Minimum Headroom's managed helpers and RMH launcher start the interactive agy
TUI and do not use print mode. They therefore keep multi-turn state and are not
affected by the 1.1.1 stdin change.

For external one-shot scripts, `-p` consumes its following value. `agy -p -`
therefore sends a literal hyphen and must not be used as an stdin sentinel.
Use `agy -p 'short prompt'` for a non-sensitive argv prompt. For a large or
sensitive stdin prompt, the 1.1.1 compatibility path is a non-TTY stdin stream
with no prompt flag:

    printf '%s\n' 'Reply with exactly PONG' | agy --print-timeout 60s

Check the process exit status and stderr. Version 1.1.1 returns a nonzero status
for server-side print failures instead of silently returning an empty success.
This no-prompt-flag stdin behavior is not shown in `agy --help`, so keep it
covered by an integration smoke test in any service that depends on it.

### Model selection on agy 1.1.1

Run `agy models` to see the names available to the current account. The RMH
launcher accepts an explicit name and passes it through to the interactive CLI:

    examples/rmh-voice-mode/start-rmh.sh --agent agy \
      --model 'Gemini 3.7 Flash (Low)'

The launcher deliberately leaves the model unset by default because the list is
account-dependent and changes over time.

After updating this repository or `~/.agents/skills`, refresh the installed
plugin without starting a conversation:

    examples/rmh-voice-mode/start-rmh.sh --agent agy --setup-only

> Note: if your `agy plugin validate` build reports `hooks: skipped (not found)`, keep using the shared `~/.gemini/settings.json` snippet below for hook delivery. MCP tools are still installed by the plugin either way.

---

## Antigravity GUI (desktop app)

The GUI reads its MCP server list from `~/.gemini/config/mcp_config.json`. **A common failure mode is that this file exists but is 0 bytes**, which causes `unexpected end of JSON input` in `~/.config/Antigravity/logs/language_server.log` and silently disables every MCP server. Always check the file is valid JSON before debugging anything else:

    cat ~/.gemini/config/mcp_config.json | head -c 100
    node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.gemini/config/mcp_config.json","utf8"))'   # exits non-zero on parse error

### Register the MCP server

Edit `~/.gemini/config/mcp_config.json`. If you have other MCP servers there already, merge into the existing `mcpServers` object — don't overwrite. Minimal version:

```json
{
  "mcpServers": {
    "minimum_headroom": {
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

### Install the plugin (skill metadata)

The MCP registration above already makes the tools callable from the GUI; the plugin directory below is what makes the **skill** (`minimum-headroom-ops`) visible to the GUI's skill listing.

    mkdir -p ~/.gemini/config/plugins/minimum-headroom/skills/minimum-headroom-ops
    cp doc/examples/antigravity/plugin.json \
       ~/.gemini/config/plugins/minimum-headroom/plugin.json
    cp "$MH_OPS_SKILL" \
       ~/.gemini/config/plugins/minimum-headroom/skills/minimum-headroom-ops/SKILL.md

### Restart the GUI

**Fully quit** Antigravity — not just close the window. The Electron process keeps running on close-to-tray, and stale processes will not re-read configs.

    pgrep -af antigravity              # verify the installed executable path first
    pkill -f '/opt/antigravity-2/antigravity'  # adjust this path for your installation
    # then relaunch from the desktop launcher

### Verify in the GUI

In the chat, ask:

    List every MCP tool you can call right now. Then call face_ping and report the result.
    List every skill you have access to.

A working setup shows `face_event`, `face_say`, `face_ping`, the `agent_*` lifecycle tools, and `minimum-headroom-ops` in the skill list, plus `face_ping` returning `forwarded face.ping`.
For M12 vision sessions it should also show `vision_situation` and `vision_look`;
ask the agent to call `vision_situation` rather than inferring camera state from
`ps`, browser tabs, or process names.

---

## Hooks
<a id="hooks"></a>

Antigravity's current public hook format is `hooks.json`. This directory ships `hooks.json` for plugin/workspace installs:

- `PreInvocation` → `situation-context-hook-agy.mjs`: injects the AtomS3R-M12 camera situation digest as a transient `ephemeralMessage` before each model invocation. Safe-by-default: the underlying `scripts/situation-context-hook.sh` prints nothing (and the wrapper emits `{}`) unless `MH_SITUATION_INJECT=1` is set in the agy process environment, so registering it costs nothing in ordinary sessions. The wrapper derives a stable watermark key from the agy `conversationId` and passes it to the plain hook via `MH_SITUATION_SESSION_KEY`, so the salience watermark survives across invocations of the same conversation.
- `Stop` → `mh-hook.mjs --runtime antigravity --event idle_after_response`
- a disabled `PreToolUse` example for approval attention, because enabling it can ask before matching tools and should be an explicit local choice.

The global/operator plugin deliberately does not register
`agy-helper-policy.mjs`. Antigravity requires every `PreToolUse` hook to return
an explicit decision, so such a hook cannot be inert in ordinary sessions.
`agent.spawn(permission_preset=...)` instead creates a worktree-local plugin at
`.agents/plugins/minimum-headroom-helper-policy/` for managed agy helpers only.

During migration testing, current CLI/GUI builds also accepted a shared `~/.gemini/settings.json` hook block using `Notification` and `AfterAgent`. If your installed build does not load plugin `hooks.json`, merge `settings-hooks.snippet.json` into `~/.gemini/settings.json` instead. That snippet uses `--runtime antigravity --stdout-mode silent` so no deprecated Gemini runtime name remains and no stray stdout JSON is emitted for that settings-style hook path.

Restart Antigravity (CLI or GUI) after changing either hook file.

In RMH voice-first mode the agent itself speaks every turn-end, so the `AfterAgent → idle_after_response` line is suppressed at the hook script level via `MH_HOOK_SUPPRESS_EVENTS=idle_after_response` (set automatically by `examples/rmh-voice-mode/start-rmh.sh`). See `examples/rmh-voice-mode/README.md` for details.

---

## How the bound wrapper preserves identity

`run-bound-mcp-server.sh` (the `command` in `mcp_config.json`) forwards `MH_FACE_AGENT_ID` and `MH_FACE_AGENT_LABEL` from the current agent process or its parent process. When agy / Antigravity is launched by minimum-headroom (operator or helper pane), those env vars are already set, so `face_event` / `face_say` / `face_ping` can omit `agent_id`.

If face-app is bound outside loopback and requires `MH_FACE_AUTH_TOKEN`, the wrapper also forwards the token from the current environment, from a parent process, or from `MH_FACE_ENV_FILE` (default `~/.config/minimum-headroom.env`). Keep real tokens out of `mcp_config.json` and `settings.json`.

## Tool name style

`MCP_TOOL_NAME_STYLE=underscore` publishes tools as `face_event`, `face_say`, `face_ping`, etc. — the conservative choice across MCP clients. Remove that env entry if you specifically want dotted names.

## Hook stdout mode

All Antigravity examples use `--runtime antigravity`. The optional `--stdout-mode` flag selects the host hook contract:

- omit `--stdout-mode` for Antigravity JSON Hooks (`hooks.json`); `mh-hook.mjs` writes the small stdout JSON object Antigravity expects.
- use `--stdout-mode silent` for the shared `settings-hooks.snippet.json` compatibility path; `mh-hook.mjs` forwards to the face app but emits no stdout.

Do not use the retired `gemini` runtime name in new configs.

## Permission presets for helpers

When spawning agy helpers with `agent.spawn(permission_preset=...)`, pass `agent_cmd: "agy"`. Minimum Headroom scopes the policy with launch flags, `MH_AGY_PERMISSION_PRESET`, and a generated worktree-local plugin under `.agents/plugins/minimum-headroom-helper-policy/`. Normal interactive agy sessions do not load that helper-only plugin.

- `reviewer`: launch with `--sandbox`; allow simple read-oriented commands and force an approval prompt for other commands.
- `implementer` and `full`: launch with `--sandbox --dangerously-skip-permissions`; the policy hook still hard-denies direct `git push` commands.

The hook is a guardrail, not a hostile-shell security boundary; deliberately obfuscated shell code can evade command-text matching. Keep the helper instruction that forbids push, review helper changes before publishing, and reserve `git push` for the user-facing owner.

First-run behavior is still interactive. A fresh helper worktree can stop at Antigravity's workspace trust prompt before `agent.inject` can probe input. Confirm `Yes, I trust this folder` for that generated worktree, then retry injection. The first MCP calls can also prompt for approval (`minimum_headroom/agent_report`, then often `face_ping`, `face_event`, and `face_say`). Choose the conversation-scoped allow option for smoke tests, or persist only after you have reviewed the installed plugin path and permissions. This is expected Antigravity CLI behavior, not a Minimum Headroom transport failure.

The project `AGENTS.md` (or `GEMINI.md`) rules remain part of the security model. Keep the minimum-headroom signaling rules and the helper rule that helpers must not run `git push`.

## Validation summary

| Step | Command | Expected |
|------|---------|----------|
| CLI plugin valid | `agy plugin validate doc/examples/antigravity` | `mcpServers: 1 processed`; hooks may be processed or skipped depending on agy build |
| CLI installed plugin complete | `agy plugin validate ~/.gemini/antigravity-cli/plugins/minimum-headroom` | `skills: 2 processed`, `mcpServers: 1 processed`, `hooks: 3 processed` for the voice-mode launcher install |
| CLI plugin installed | `agy plugin list` | `minimum-headroom` listed as `local-install` |
| GUI MCP file valid | `node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME+"/.gemini/config/mcp_config.json","utf8"))'` | exits 0 |
| GUI sees server | chat prompt in GUI: `List every MCP tool you can call right now` | response includes `face_event`, `face_say`, `face_ping` |
| GUI sees vision tools | chat prompt in GUI: `List every MCP tool you can call right now` | response includes `vision_situation` and `vision_look` |
| GUI sees skill | chat prompt in GUI: `List every skill you have access to` | response includes `minimum-headroom-ops` and `atoms3r-vision` |
| End-to-end voice | chat prompt: `Call face_say with text="テストです" priority=2` | AtomS3R speaks |
