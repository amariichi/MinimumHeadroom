#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${FACE_WS_URL:=ws://127.0.0.1:8765/ws}"

exec env FACE_WS_URL="$FACE_WS_URL" node mcp-server/dist/index.js
