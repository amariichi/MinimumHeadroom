#!/usr/bin/env bash
# Idempotently ensure the AtomS3R HTTP bridge (PC face-app WS -> Atom) is up.
#
# The bridge is the PC->Atom audio/display pump. It is intentionally NOT a
# supervised child of run-operator-stack.sh: if the Atom is unreachable the
# bridge must not be able to take the whole operator stack down. Instead it
# runs in its own detached tmux session and is (re)ensured on every operator
# bring-up, so a stack restart can no longer leave the Atom silent.
#
# Opt out with MH_SKIP_ATOMS3R_BRIDGE=1. Never fails the caller (exit 0).
set -uo pipefail

SESSION="atoms3r-bridge"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SHARED_ENV="${MH_SHARED_ENV_FILE:-$HOME/.config/minimum-headroom.env}"
LOG="${ATOMS3R_BRIDGE_LOG:-/tmp/atoms3r-bridge.log}"
WAIT_UNMANAGED_SECONDS="${MH_ATOMS3R_BRIDGE_WAIT_UNMANAGED_SECONDS:-0}"

if [[ ! "$WAIT_UNMANAGED_SECONDS" =~ ^[0-9]+$ ]] \
  || ((10#$WAIT_UNMANAGED_SECONDS > 60)); then
  echo "[ensure-atoms3r-bridge] MH_ATOMS3R_BRIDGE_WAIT_UNMANAGED_SECONDS must be 0..60" >&2
  exit 0
fi

if [[ "${MH_SKIP_ATOMS3R_BRIDGE:-0}" == "1" ]]; then
  echo "[ensure-atoms3r-bridge] skipped (MH_SKIP_ATOMS3R_BRIDGE=1)"
  exit 0
fi

if pgrep -f 'atoms3r-http-bridge\.mjs' >/dev/null 2>&1; then
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux set-option -t "$SESSION" @minimum_headroom_atom_bridge_owner operator
    echo "[ensure-atoms3r-bridge] already running"
    exit 0
  fi
  wait_steps=$((10#$WAIT_UNMANAGED_SECONDS * 5))
  for ((step = 0; step < wait_steps; step += 1)); do
    sleep 0.2
    if ! pgrep -f 'atoms3r-http-bridge\.mjs' >/dev/null 2>&1; then
      break
    fi
  done
  if pgrep -f 'atoms3r-http-bridge\.mjs' >/dev/null 2>&1; then
    echo "[ensure-atoms3r-bridge] bridge process is running outside the operator session" >&2
    exit 0
  fi
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "[ensure-atoms3r-bridge] tmux not found; cannot start bridge" >&2
  exit 0
fi

# A session with no live bridge process is stale; clear it before recreating.
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Forward only the overrides that are explicitly set; the bridge has sane
# defaults (face ws 127.0.0.1:8765, Atom auto-discovery via /health) and
# resolves the auth token from the shared env file sourced below.
tmux_env=()
for v in ATOM_HEADROOM_URL FACE_WS_URL MH_FACE_WS_URL ATOM_HEADROOM_AUTH_TOKEN \
         ATOM_HEADROOM_FETCH_AUDIO_REF ATOM_HEADROOM_FORWARD_AUDIO MH_FACE_AUTH_TOKEN; do
  if [[ -n "${!v:-}" ]]; then
    tmux_env+=(-e "${v}=${!v}")
  fi
done

if ! tmux new-session -d -s "$SESSION" -c "$REPO_ROOT" "${tmux_env[@]}" \
  "bash -lc 'set -a; [ -r \"$SHARED_ENV\" ] && . \"$SHARED_ENV\"; set +a; exec node scripts/atoms3r-http-bridge.mjs 2>&1 | tee \"$LOG\"'"; then
  echo "[ensure-atoms3r-bridge] failed to start tmux session" >&2
  exit 0
fi

tmux set-option -t "$SESSION" @minimum_headroom_atom_bridge_owner operator
echo "[ensure-atoms3r-bridge] started (tmux session '$SESSION', log: $LOG)"
exit 0
