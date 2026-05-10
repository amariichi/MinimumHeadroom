#!/usr/bin/env bash
# Grant trust to user-defined Codex hooks without manual TUI navigation.
#
# Codex (verified against rust-v0.130.0 and main as of 2026-05-10) gates
# user-defined hooks behind an explicit per-hook trust grant: untrusted hooks
# are silently filtered out at startup. The interactive way to grant trust on
# Codex 0.130.x is to launch `codex`, type `/hooks` to open the lifecycle hooks
# browser, walk into each event group with Enter, press `t` to trust each
# hook, then Esc back. Once trusted, Codex writes a SHA-256 trusted hash under
# `[hooks.state.<key>]` in `~/.codex/config.toml`, after which every future
# Codex session including helpers spawned via `agent.spawn` will execute the
# hooks.
#
# This script automates that one-time interaction by:
#   1. Spawning a transient `codex` process inside a private tmux server (so it
#      does not touch the user's existing tmux sessions).
#   2. Polling `capture-pane` for the "hooks need review" banner.
#   3. Typing `/hooks` (one character at a time so the slash-command picker
#      activates), then Tab + Enter to open the hooks browser.
#   4. Walking through all eight event groups, opening each (Enter), pressing
#      `t` to trust the visible hook, and Esc back to the events page. Empty
#      events are no-ops.
#   5. Waiting until `~/.codex/config.toml` grows new `[hooks.state.*]` tables.
#   6. Killing the transient tmux server.
#
# Usage:
#   ./scripts/grant-codex-hook-trust.sh
#
# Exits 0 on success or when there is nothing to trust, non-zero with a
# diagnostic on failure.

set -euo pipefail

CONFIG="${HOME}/.codex/config.toml"
SOCKET="mh-codex-trust-$$"
SESSION="grant"
TIMEOUT_BANNER_SECS="${TIMEOUT_BANNER_SECS:-25}"
TIMEOUT_PERSIST_SECS="${TIMEOUT_PERSIST_SECS:-15}"

if [[ ! -f "$CONFIG" ]]; then
  echo "[grant-codex-hook-trust] $CONFIG does not exist; run codex once normally to create it." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "[grant-codex-hook-trust] codex CLI not on PATH" >&2
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "[grant-codex-hook-trust] tmux not installed; required for PTY automation" >&2
  exit 1
fi

count_state_entries() {
  local n
  n=$(grep -cE '^\[hooks\.state\.' "$CONFIG" 2>/dev/null) || n=0
  printf '%s' "$n"
}

snd() {
  tmux -L "$SOCKET" send-keys -t "${SESSION}:0.0" "$@"
}

before=$(count_state_entries)
echo "[grant-codex-hook-trust] starting (existing [hooks.state.*] entries: $before)"

cleanup() {
  tmux -L "$SOCKET" kill-server 2>/dev/null || true
}
trap cleanup EXIT

tmux -L "$SOCKET" new-session -d -s "$SESSION" -x 200 -y 50 "codex"

# 1. Wait for banner (or the prompt with no banner = nothing to trust).
banner_seen=0
for ((i=0; i<TIMEOUT_BANNER_SECS; i++)); do
  pane=$(tmux -L "$SOCKET" capture-pane -t "${SESSION}:0.0" -p 2>/dev/null || true)
  if echo "$pane" | grep -qiE "(hooks need review|need to be reviewed|Open /hooks)"; then
    banner_seen=1
    break
  fi
  if echo "$pane" | grep -qiE "(Explain this codebase|Type your message)"; then
    echo "[grant-codex-hook-trust] codex started without a review banner; nothing to trust."
    exit 0
  fi
  sleep 1
done

if [[ $banner_seen -eq 0 ]]; then
  echo "[grant-codex-hook-trust] codex did not show a review banner within ${TIMEOUT_BANNER_SECS}s." >&2
  echo "[grant-codex-hook-trust] Last pane snapshot:" >&2
  tmux -L "$SOCKET" capture-pane -t "${SESSION}:0.0" -p 2>/dev/null | tail -25 >&2 || true
  exit 2
fi

# 2. Open the hooks browser via /hooks.
for c in '/' h o o k s; do snd "$c"; sleep 0.3; done
sleep 0.8
snd Tab
sleep 0.6
snd Enter
sleep 2

# 3. Wait for the events page.
events_seen=0
for ((i=0; i<10; i++)); do
  pane=$(tmux -L "$SOCKET" capture-pane -t "${SESSION}:0.0" -p 2>/dev/null || true)
  if echo "$pane" | grep -qE "(Press enter to view hooks|PermissionRequest|PreToolUse)"; then
    events_seen=1
    break
  fi
  sleep 1
done

if [[ $events_seen -eq 0 ]]; then
  echo "[grant-codex-hook-trust] hooks browser events page did not appear after /hooks Enter." >&2
  tmux -L "$SOCKET" capture-pane -t "${SESSION}:0.0" -p 2>/dev/null | tail -25 >&2 || true
  exit 3
fi

# 4. Walk through all 8 event groups and trust each one. The list order is:
#    PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact,
#    SessionStart, UserPromptSubmit, Stop. Default selection is the top.
for ((evt=0; evt<8; evt++)); do
  snd Enter        # open Handlers page for the current event
  sleep 0.6
  snd "t"          # trust selected hook (no-op if event has no hooks)
  sleep 0.4
  snd Escape       # back to Events page
  sleep 0.4
  snd Down         # move to next event row
  sleep 0.2
done

# 5. Close the browser.
snd Escape
sleep 0.6

# 6. Wait for persistence.
persisted=0
for ((i=0; i<TIMEOUT_PERSIST_SECS; i++)); do
  after=$(count_state_entries)
  if [[ "$after" -gt "$before" ]]; then
    persisted=1
    break
  fi
  sleep 1
done

after=$(count_state_entries)
if [[ $persisted -eq 0 ]]; then
  echo "[grant-codex-hook-trust] no new [hooks.state.*] entries appeared within ${TIMEOUT_PERSIST_SECS}s (was $before, now $after)." >&2
  tmux -L "$SOCKET" capture-pane -t "${SESSION}:0.0" -p 2>/dev/null | tail -25 >&2 || true
  exit 4
fi

echo "[grant-codex-hook-trust] trust granted ([hooks.state.*] entries: $before → $after)"

# Politely quit codex.
for c in '/' q u i t; do snd "$c"; sleep 0.2; done
snd Tab
sleep 0.4
snd Enter
sleep 1
