#!/usr/bin/env bash
# =============================================================================
#  situation-context-hook.sh — Design B: inject the AtomS3R-M12 camera's
#  situation digest into the conversational agent's context on every user turn,
#  so the agent's understanding never drifts from what the camera sees. Wire it
#  as a UserPromptSubmit hook in the CONVERSATIONAL agent's settings; its stdout
#  is added to that turn's context.
#
#  Opt-in and safe-by-default:
#    * Emits nothing unless MH_SITUATION_INJECT is truthy (so it never pollutes
#      ordinary dev sessions even if the hook is registered there).
#    * Emits nothing (exit 0) when the vision-worker is unreachable, so it is
#      harmless to leave enabled when the camera stack is down.
#
#  Enable it (in the voice/operator agent's environment + settings.json):
#    export MH_SITUATION_INJECT=1          # turn the hook on for this agent
#    export VISION_BASE_URL=http://127.0.0.1:8095   # or the Tailscale address
#    # settings.json:
#    # {"hooks": {"UserPromptSubmit": [{"hooks": [
#    #   {"type": "command",
#    #    "command": "/home/amari1/github/minimum-headroom/scripts/situation-context-hook.sh"}]}]}}
# =============================================================================
set -uo pipefail

case "${MH_SITUATION_INJECT:-0}" in
  1 | true | yes | on) ;;
  *) exit 0 ;;
esac

BASE="${VISION_BASE_URL:-http://127.0.0.1:8095}"
text="$(curl -fsS -m 1.5 "$BASE/situation?format=text" 2>/dev/null)" || exit 0
[ -n "$text" ] || exit 0
printf '%s\n' "$text"
