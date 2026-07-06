#!/usr/bin/env bash
# Launch a coding agent in Real Minimum Headroom (RMH) voice-first mode.
#
# Usage:
#   start-rmh.sh --agent {claude|codex|agy} [--model <id>] [--with-vision] [extra args passed to the CLI]
#
# Required runtime: the minimum-headroom operator stack must already be running
# (face-app on FACE_WS_URL, AtomS3R bridge alive). This script does not start
# the stack — it only launches the chosen CLI so that the agent reads the
# voice-first rules in this directory and talks through face_say.
#
# Path discipline: no machine-specific paths are baked in. We resolve the
# minimum-headroom repo root from the script's own location (this folder is
# committed inside the repo), or accept MH_REPO_ROOT as an explicit override.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Resolve repo root ------------------------------------------------------
# This script lives at <repo>/examples/rmh-voice-mode/start-rmh.sh, so the
# repo root is two levels up. Allow MH_REPO_ROOT to override for the case
# where the user copies this folder out of the repo.
DEFAULT_REPO_ROOT="$(cd "$HERE/../.." && pwd)"
MH_REPO_ROOT="${MH_REPO_ROOT:-$DEFAULT_REPO_ROOT}"

if [[ ! -x "$MH_REPO_ROOT/scripts/run-bound-mcp-server.sh" ]]; then
  cat >&2 <<EOF
[start-rmh] could not find run-bound-mcp-server.sh under: $MH_REPO_ROOT
Set MH_REPO_ROOT to the absolute path of your minimum-headroom checkout.
EOF
  exit 2
fi

# --- Bootstrap per-CLI rule files (idempotent) -----------------------------
# CLAUDE.md / AGENTS.md / GEMINI.md are auto-generated from
# tools/voice-first-rules.md and are .gitignored at the repo root. Regenerate
# any that are missing so the first cd into this folder makes the CLI happy.
for rule_file in "$HERE/CLAUDE.md" "$HERE/AGENTS.md" "$HERE/GEMINI.md"; do
  if [[ ! -f "$rule_file" ]]; then
    "$HERE/tools/regenerate-rules.sh"
    break
  fi
done

# --- Defaults (overridable via env or CLI) ---------------------------------
: "${FACE_WS_URL:=ws://127.0.0.1:8765/ws}"
: "${VISION_BASE_URL:=http://127.0.0.1:8095}"
: "${MH_FACE_AGENT_ID:=__operator__}"
: "${MH_FACE_AGENT_LABEL:=Operator}"
: "${MH_FACE_SESSION_ID:=operator}"

# In voice-first mode, the agent itself speaks every turn end through face_say,
# so the hook bridge's idle_after_response fallback ("作業が止まっているかも
# しれません。" / "I may be stuck waiting.") is redundant noise. Suppress it
# at the hook level — mh-hook.mjs will skip forwarding but still emit the
# runtime stdout payload so Antigravity/Codex/Claude hosts see a clean handoff.
# To keep the idle phrase, run with MH_HOOK_SUPPRESS_EVENTS='' .
: "${MH_HOOK_SUPPRESS_EVENTS:=idle_after_response}"

# Conservative model defaults for voice-first use. Override with --model <id>.
: "${RMH_DEFAULT_MODEL_CLAUDE:=haiku}"
: "${RMH_DEFAULT_MODEL_CODEX:=gpt-5.4-mini}"
# agy has no --model flag; it reads ~/.gemini/antigravity-cli/settings.json. Document only.
: "${RMH_DEFAULT_MODEL_AGY_HINT:=gemini-flash-latest}"
: "${RMH_WITH_VISION:=0}"

# Runtime workdir for generated configs (machine-local, not committed).
RUNTIME_DIR="${XDG_RUNTIME_DIR:-$HOME/.cache}/rmh-voice-mode/$$"
mkdir -p "$RUNTIME_DIR"
trap 'rm -rf "$RUNTIME_DIR"' EXIT

# --- Argument parsing -------------------------------------------------------
AGENT=""
MODEL=""
PASSTHRU=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) AGENT="$2"; shift 2 ;;
    --agent=*) AGENT="${1#*=}"; shift ;;
    --model) MODEL="$2"; shift 2 ;;
    --model=*) MODEL="${1#*=}"; shift ;;
    --with-vision) RMH_WITH_VISION=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) PASSTHRU+=("$1"); shift ;;
  esac
done

if [[ -z "$AGENT" ]]; then
  echo "[start-rmh] missing --agent {claude|codex|agy}" >&2
  exit 2
fi

# --- Template rendering -----------------------------------------------------
render() {
  # render <template-path> <output-path>
  # Substitutes __MH_REPO_ROOT__, __FACE_WS_URL__, __VISION_BASE_URL__,
  # and __CODEX_MODEL__.
  local in="$1" out="$2"
  sed \
    -e "s|__MH_REPO_ROOT__|$MH_REPO_ROOT|g" \
    -e "s|__FACE_WS_URL__|$FACE_WS_URL|g" \
    -e "s|__VISION_BASE_URL__|$VISION_BASE_URL|g" \
    -e "s|__CODEX_MODEL__|${MODEL:-$RMH_DEFAULT_MODEL_CODEX}|g" \
    "$in" > "$out"
}

toml_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

export MH_FACE_AGENT_ID MH_FACE_AGENT_LABEL MH_FACE_SESSION_ID MH_REPO_ROOT FACE_WS_URL VISION_BASE_URL MH_HOOK_SUPPRESS_EVENTS

if [[ "${RMH_WITH_VISION:-0}" == "1" ]]; then
  case "${MH_SITUATION_INJECT+x}:${MH_SITUATION_INJECT:-}" in
    x:0|x:false|x:False|x:FALSE|x:no|x:No|x:NO|x:off|x:Off|x:OFF)
      ;;
    x:)
      export MH_SITUATION_INJECT=1
      ;;
    x:*)
      ;;
    :)
      export MH_SITUATION_INJECT=1
      ;;
  esac
  export MH_SITUATION_INJECT
  echo "[start-rmh] starting vision backend (may take a few minutes on cold start)" >&2
  if ! "$MH_REPO_ROOT/scripts/run-vision-stack.sh"; then
    echo "[start-rmh] warning: vision backend unavailable; continuing without vision." >&2
  fi
fi

# --- Per-agent launch -------------------------------------------------------
case "$AGENT" in
  claude)
    MCP_CFG="$RUNTIME_DIR/claude-mcp.json"
    CLAUDE_SETTINGS="$RUNTIME_DIR/claude-settings.json"
    render "$HERE/templates/claude-mcp.json.tmpl" "$MCP_CFG"
    render "$HERE/templates/claude-settings.json.tmpl" "$CLAUDE_SETTINGS"
    MODEL_ARGS=()
    if [[ -n "${MODEL:-$RMH_DEFAULT_MODEL_CLAUDE}" ]]; then
      MODEL_ARGS+=(--model "${MODEL:-$RMH_DEFAULT_MODEL_CLAUDE}")
    fi
    cd "$HERE"
    exec claude --mcp-config "$MCP_CFG" --settings "$CLAUDE_SETTINGS" "${MODEL_ARGS[@]}" "${PASSTHRU[@]}"
    ;;

  codex)
    # Do not replace CODEX_HOME here. Codex stores auth, state databases,
    # memories, MCP approvals, and hook trust under the user's normal
    # ~/.codex. Per-launch RMH settings are layered with -c overrides instead.
    CODEX_MCP_COMMAND="$(toml_string "$MH_REPO_ROOT/scripts/run-bound-mcp-server.sh")"
    CODEX_FACE_WS_URL="$(toml_string "$FACE_WS_URL")"
    CODEX_VISION_BASE_URL="$(toml_string "$VISION_BASE_URL")"
    CODEX_PERMISSION_HOOK="$(toml_string "$MH_REPO_ROOT/scripts/mh-hook.mjs --runtime codex --event permission_required")"
    CODEX_STOP_HOOK="$(toml_string "$MH_REPO_ROOT/scripts/mh-hook.mjs --runtime codex --event idle_after_response")"
    CODEX_USER_PROMPT_HOOK="$(toml_string "$MH_REPO_ROOT/scripts/situation-context-hook-codex.mjs")"
    CODEX_CONFIG_ARGS=(
      -c "mcp_servers.minimum_headroom.command=$CODEX_MCP_COMMAND"
      -c "mcp_servers.minimum_headroom.args=[]"
      -c "mcp_servers.minimum_headroom.env={ FACE_WS_URL = $CODEX_FACE_WS_URL, VISION_BASE_URL = $CODEX_VISION_BASE_URL, MCP_TOOL_NAME_STYLE = \"underscore\" }"
      -c "features.hooks=true"
      -c "hooks.PermissionRequest=[{ matcher = \".*\", hooks = [{ type = \"command\", command = $CODEX_PERMISSION_HOOK, timeout = 5 }] }]"
      -c "hooks.Stop=[{ hooks = [{ type = \"command\", command = $CODEX_STOP_HOOK, timeout = 5 }] }]"
    )
    case "${MH_SITUATION_INJECT:-0}" in
      1 | true | yes | on)
        # Codex accepts UserPromptSubmit hookSpecificOutput.additionalContext.
        # Use a Codex-specific wrapper so stdout is always valid hook JSON even
        # on builds that reject plain-text UserPromptSubmit output.
        CODEX_CONFIG_ARGS+=(
          -c "hooks.UserPromptSubmit=[{ hooks = [{ type = \"command\", command = $CODEX_USER_PROMPT_HOOK, timeout = 5 }] }]"
        )
        ;;
    esac
    # Make sure codex sees the project AGENTS.md in this folder.
    cd "$HERE"
    MODEL_ARGS=()
    if [[ -n "${MODEL:-$RMH_DEFAULT_MODEL_CODEX}" ]]; then
      MODEL_ARGS+=(--model "${MODEL:-$RMH_DEFAULT_MODEL_CODEX}")
    fi
    # Codex prints a one-time hooks trust prompt when hashes change; the user
    # may need to run scripts/grant-codex-hook-trust.sh after first launch.
    exec codex "${CODEX_CONFIG_ARGS[@]}" "${MODEL_ARGS[@]}" "${PASSTHRU[@]}"
    ;;

  agy)
    # Current agy reads MCP server registrations from installed agy plugins
    # (`agy plugin install <dir>` → ~/.gemini/antigravity-cli/plugins/<name>/), and reads
    # hooks separately from hooks.json or ~/.gemini/settings.json depending on
    # the installed build. We idempotently render and install a complete
    # minimum-headroom plugin from templates so MH_REPO_ROOT is resolved for the
    # current machine. Shared ~/.gemini/settings.json is still not edited here
    # because it affects the user's other agy customisations.
    PLUGIN_SRC="$RUNTIME_DIR/agy-plugin/minimum-headroom"
    mkdir -p "$PLUGIN_SRC"
    cp "$HERE/templates/antigravity-plugin/plugin.json" "$PLUGIN_SRC/plugin.json"
    render "$HERE/templates/antigravity-plugin/mcp_config.json.tmpl" "$PLUGIN_SRC/mcp_config.json"
    render "$HERE/templates/antigravity-plugin/hooks.json.tmpl" "$PLUGIN_SRC/hooks.json"
    mkdir -p "$PLUGIN_SRC/skills/minimum-headroom-ops" "$PLUGIN_SRC/skills/atoms3r-vision"
    cp "$MH_REPO_ROOT/doc/examples/skills/minimum-headroom-ops/SKILL.md" \
      "$PLUGIN_SRC/skills/minimum-headroom-ops/SKILL.md"
    cp "$MH_REPO_ROOT/doc/examples/skills/atoms3r-vision/SKILL.md" \
      "$PLUGIN_SRC/skills/atoms3r-vision/SKILL.md"
    if ! agy plugin install "$PLUGIN_SRC" >/dev/null 2>&1; then
      echo "[start-rmh] agy plugin install failed for $PLUGIN_SRC; falling back to launch with existing plugins." >&2
    fi
    # agy 1.0.16 may validate hooks/skills in the rendered plugin but still
    # leave the CLI plugin directory with only plugin.json + mcp_config.json.
    # Make the CLI path explicit so the agy process launched below sees the
    # same MCP, hook, and skill files that validated successfully.
    AGY_CLI_PLUGIN_DIR="${HOME}/.gemini/antigravity-cli/plugins/minimum-headroom"
    mkdir -p "$AGY_CLI_PLUGIN_DIR"
    cp -a "$PLUGIN_SRC/." "$AGY_CLI_PLUGIN_DIR/"
    if [[ -n "${MODEL:-}" ]]; then
      echo "[start-rmh] note: agy has no --model flag; it reads the model from ~/.gemini/antigravity-cli/settings.json." >&2
      echo "[start-rmh] --model $MODEL was not applied. Suggested light model: $RMH_DEFAULT_MODEL_AGY_HINT" >&2
    fi
    cd "$HERE"
    exec agy "${PASSTHRU[@]}"
    ;;

  *)
    echo "[start-rmh] unknown --agent: $AGENT (expected claude|codex|agy)" >&2
    exit 2
    ;;
esac
