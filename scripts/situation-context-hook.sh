#!/usr/bin/env bash
# =============================================================================
#  situation-context-hook.sh — Design B: inject the AtomS3R-M12 camera's
#  situation digest into the conversational agent's context on every user turn.
#
#  Design B is two-stage: when the worker is up, emit a short camera presence
#  line every turn, but escalate to the full digest only when the server reports
#  a salient event since this session's last watermark.
#
#  Opt-in and safe-by-default:
#    * Emits nothing unless MH_SITUATION_INJECT is truthy (so it never pollutes
#      ordinary dev sessions even if the hook is registered there).
#    * Emits nothing (exit 0) when the vision-worker is unreachable, so it is
#      harmless to leave enabled when the camera stack is down.
#    * Keeps per-session watermark state under ${XDG_RUNTIME_DIR:-/tmp} and
#      round-trips it as GET /situation?format=text&since=<watermark>.
#
#  Enable it (documentation only; do not edit user settings programmatically):
#    export MH_SITUATION_INJECT=1
#    export VISION_BASE_URL=http://127.0.0.1:8095
#    # settings.json UserPromptSubmit hook:
#    # {"hooks": {"UserPromptSubmit": [{"hooks": [
#    #   {"type": "command",
#    #    "command": "/ABS/PATH/minimum-headroom/scripts/situation-context-hook.sh"}]}]}}
# =============================================================================
set -uo pipefail

case "${MH_SITUATION_INJECT:-0}" in
  1 | true | yes | on) ;;
  *) exit 0 ;;
esac

HOOK_STDIN=""
if [ ! -t 0 ]; then
  HOOK_STDIN="$(cat 2>/dev/null || true)"
fi

BASE="${VISION_BASE_URL:-http://127.0.0.1:8095}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
STATE_DIR="$RUNTIME_DIR/minimum-headroom-situation"
SESSION_KEY="${CLAUDE_SESSION_ID:-${MH_FACE_AGENT_ID:-${AGENT_ID:-pid-$$}}}"
SAFE_KEY="$(printf '%s' "$SESSION_KEY" | tr -c 'A-Za-z0-9_.-' '_')"
STATE_FILE="$STATE_DIR/watermark-$SAFE_KEY"

mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
headers="$(mktemp "$STATE_DIR/headers.XXXXXX")" || exit 0
body="$(mktemp "$STATE_DIR/body.XXXXXX")" || exit 0
cleanup() {
  rm -f "$headers" "$body"
}
trap cleanup EXIT

args=(-fsS -m 1.5 -D "$headers" -o "$body" --get --data-urlencode "format=text")
if [ -s "$STATE_FILE" ]; then
  since="$(cat "$STATE_FILE" 2>/dev/null || true)"
  if [ -n "$since" ]; then
    args+=(--data-urlencode "since=$since")
  fi
fi

curl "${args[@]}" "$BASE/situation" 2>/dev/null || exit 0
[ -s "$body" ] || exit 0

watermark="$(awk 'BEGIN { IGNORECASE=1 } /^X-Situation-Watermark:/ { value=$0; sub(/^[^:]*:[[:space:]]*/, "", value); sub(/\r$/, "", value); last=value } END { if (last != "") print last }' "$headers")"
if [ -n "$watermark" ]; then
  printf '%s\n' "$watermark" >"$STATE_FILE" 2>/dev/null || true
fi

cat "$body"

case "${MH_VISION_COMPANION:-0}" in
  1 | true | yes | on)
    companion_hook="$(dirname "$0")/vision-companion-context-hook.py"
    if [ -x "$companion_hook" ]; then
      printf '%s' "$HOOK_STDIN" | "$companion_hook" 2>/dev/null || true
    fi
    ;;
esac
