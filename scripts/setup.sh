#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[setup] root: $ROOT_DIR"

echo "[setup] checking Node.js"
node --version

echo "[setup] checking uv"
uv --version

echo "[setup] syncing Python deps for tts-worker"
uv sync --project tts-worker

echo "[setup] done"
