#!/usr/bin/env bash
# Regenerate CLAUDE.md / AGENTS.md / GEMINI.md from voice-first-rules.md.
#
# Each output file is the same body, prefixed with a one-line CLI-specific
# notice so the user can tell which file is which when grepping.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$HERE/voice-first-rules.md"

if [[ ! -f "$SRC" ]]; then
  echo "[regenerate-rules] source not found: $SRC" >&2
  exit 1
fi

write_for() {
  local cli="$1" out="$2"
  {
    printf '<!-- Auto-generated from tools/voice-first-rules.md. Do not edit directly. -->\n'
    printf '<!-- Target CLI: %s -->\n\n' "$cli"
    cat "$SRC"
  } > "$out"
  echo "[regenerate-rules] wrote $out"
}

write_for "Claude Code (claude)"            "$ROOT/CLAUDE.md"
write_for "Codex CLI (codex)"               "$ROOT/AGENTS.md"
write_for "Antigravity CLI (agy / Gemini)"  "$ROOT/GEMINI.md"
