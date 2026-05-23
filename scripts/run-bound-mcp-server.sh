#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${FACE_WS_URL:=ws://127.0.0.1:8765/ws}"
: "${MCP_TOOL_NAME_STYLE:=dot}"
: "${MH_FACE_ENV_FILE:=$HOME/.config/minimum-headroom.env}"

read_proc_env_var() {
  local pid="$1"
  local key="$2"
  if [[ -z "$pid" || ! -r "/proc/${pid}/environ" ]]; then
    return 1
  fi
  tr '\0' '\n' <"/proc/${pid}/environ" | awk -F= -v key="$key" '
    $1 == key {
      sub(/^[^=]*=/, "")
      print
      found = 1
      exit
    }
    END { exit found ? 0 : 1 }
  '
}

read_parent_pid() {
  local pid="$1"
  if [[ -z "$pid" || ! -r "/proc/${pid}/status" ]]; then
    return 1
  fi
  awk '/^PPid:/ { print $2; found = 1; exit } END { exit found ? 0 : 1 }' "/proc/${pid}/status"
}

inherit_from_parent_chain() {
  local key="$1"
  local pid="${PPID:-}"
  local depth=0
  while [[ -n "$pid" && "$pid" != "0" && "$depth" -lt 8 ]]; do
    if value="$(read_proc_env_var "$pid" "$key" 2>/dev/null)" && [[ -n "$value" ]]; then
      printf '%s\n' "$value"
      return 0
    fi
    pid="$(read_parent_pid "$pid" 2>/dev/null || true)"
    depth=$((depth + 1))
  done
  return 1
}

read_env_file_var() {
  local file="$1"
  local key="$2"
  if [[ -z "$file" || ! -r "$file" ]]; then
    return 1
  fi
  awk -v key="$key" '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function unquote(value) {
      value = trim(value)
      if (value ~ /^"([^"\\]|\\.)*"$/) {
        value = substr(value, 2, length(value) - 2)
        gsub(/\\"/, "\"", value)
        gsub(/\\\\/, "\\", value)
      } else if (value ~ /^'\''[^'\'']*'\''$/) {
        value = substr(value, 2, length(value) - 2)
      }
      return value
    }
    {
      line = $0
      sub(/\r$/, "", line)
      line = trim(line)
      if (line == "" || line ~ /^#/) {
        next
      }
      sub(/^export[[:space:]]+/, "", line)
      equals = index(line, "=")
      if (equals <= 1) {
        next
      }
      name = trim(substr(line, 1, equals - 1))
      if (name != key) {
        next
      }
      print unquote(substr(line, equals + 1))
      found = 1
      exit
    }
    END { exit found ? 0 : 1 }
  ' "$file"
}

if [[ -z "${MH_FACE_AGENT_ID:-}" ]]; then
  if value="$(inherit_from_parent_chain MH_FACE_AGENT_ID 2>/dev/null)" && [[ -n "$value" ]]; then
    export MH_FACE_AGENT_ID="$value"
  fi
fi

if [[ -z "${MH_FACE_AGENT_LABEL:-}" ]]; then
  if value="$(inherit_from_parent_chain MH_FACE_AGENT_LABEL 2>/dev/null)" && [[ -n "$value" ]]; then
    export MH_FACE_AGENT_LABEL="$value"
  elif [[ -n "${MH_FACE_AGENT_ID:-}" ]]; then
    export MH_FACE_AGENT_LABEL="$MH_FACE_AGENT_ID"
  fi
fi

if [[ -z "${MH_FACE_AUTH_TOKEN:-}" ]]; then
  if value="$(inherit_from_parent_chain MH_FACE_AUTH_TOKEN 2>/dev/null)" && [[ -n "$value" ]]; then
    export MH_FACE_AUTH_TOKEN="$value"
  elif value="$(read_env_file_var "$MH_FACE_ENV_FILE" MH_FACE_AUTH_TOKEN 2>/dev/null)" && [[ -n "$value" ]]; then
    export MH_FACE_AUTH_TOKEN="$value"
  fi
fi

NODE_BIN="${MH_NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
# Last-resort fallbacks: nvm default symlink (covers most nvm users) and the
# distro-managed /usr/bin/node. Anything more exotic should be passed via
# MH_NODE_BIN explicitly.
if [[ -z "$NODE_BIN" && -x "$HOME/.nvm/versions/node/default/bin/node" ]]; then
  NODE_BIN="$HOME/.nvm/versions/node/default/bin/node"
fi
if [[ -z "$NODE_BIN" && -x "/usr/bin/node" ]]; then
  NODE_BIN="/usr/bin/node"
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "[run-bound-mcp-server] node not found; set MH_NODE_BIN=/path/to/node" >&2
  exit 127
fi

env_args=(
  "FACE_WS_URL=$FACE_WS_URL"
  "MCP_TOOL_NAME_STYLE=$MCP_TOOL_NAME_STYLE"
)
if [[ -n "${FACE_HTTP_BASE_URL:-}" ]]; then
  env_args+=("FACE_HTTP_BASE_URL=$FACE_HTTP_BASE_URL")
fi
if [[ -n "${MH_FACE_AUTH_TOKEN:-}" ]]; then
  env_args+=("MH_FACE_AUTH_TOKEN=$MH_FACE_AUTH_TOKEN")
fi
if [[ -n "${MH_FACE_AGENT_ID:-}" ]]; then
  env_args+=("MH_FACE_AGENT_ID=$MH_FACE_AGENT_ID")
fi
if [[ -n "${MH_FACE_AGENT_LABEL:-}" ]]; then
  env_args+=("MH_FACE_AGENT_LABEL=$MH_FACE_AGENT_LABEL")
fi

exec env "${env_args[@]}" "$NODE_BIN" mcp-server/dist/index.js
