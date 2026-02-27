#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${MH_BRIDGE_WS_URL:=ws://127.0.0.1:8765/ws}"
: "${MH_BRIDGE_SESSION_ID:=default}"
: "${MH_BRIDGE_RESTART_COMMAND:=codex resume --last}"
: "${MH_BRIDGE_RESTART_PRE_KEYS:=C-u}"
: "${MH_BRIDGE_MIRROR_LINES:=200}"
: "${MH_BRIDGE_MIRROR_INTERVAL_MS:=500}"

if [[ -z "${MH_BRIDGE_TMUX_PANE:-}" ]]; then
  if [[ -n "${TMUX_PANE:-}" ]]; then
    MH_BRIDGE_TMUX_PANE="$TMUX_PANE"
  else
    echo "[run-operator-bridge] MH_BRIDGE_TMUX_PANE is required (or run inside tmux)." >&2
    exit 2
  fi
fi

exec env \
  MH_BRIDGE_WS_URL="$MH_BRIDGE_WS_URL" \
  MH_BRIDGE_SESSION_ID="$MH_BRIDGE_SESSION_ID" \
  MH_BRIDGE_TMUX_PANE="$MH_BRIDGE_TMUX_PANE" \
  MH_BRIDGE_RESTART_COMMAND="$MH_BRIDGE_RESTART_COMMAND" \
  MH_BRIDGE_RESTART_PRE_KEYS="$MH_BRIDGE_RESTART_PRE_KEYS" \
  MH_BRIDGE_MIRROR_LINES="$MH_BRIDGE_MIRROR_LINES" \
  MH_BRIDGE_MIRROR_INTERVAL_MS="$MH_BRIDGE_MIRROR_INTERVAL_MS" \
  node face-app/dist/operator_bridge.js
