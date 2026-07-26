#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OFFLINE=0

usage() {
  cat <<'EOF'
Usage: ./scripts/check-interpreter-model-updates.sh [--offline]

Compare checked-in pinned revisions with current Hugging Face repository heads.
This command is read-only: it never downloads model weights, changes manifests,
or updates a checkout.

Options:
  --offline    Print the pinned revisions without contacting Hugging Face
  -h, --help   Show this help

An upstream difference is informational. Review release notes and compatibility
before deliberately updating a pin; do not replace matching Gemma main/mmproj/
assistant files independently.
EOF
}

while (($# > 0)); do
  case "$1" in
    --offline)
      OFFLINE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[check-interpreter-model-updates] unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

declare -a REPOSITORIES=(
  "nvidia/nemotron-3.5-asr-streaming-0.6b|f3d333391852ba876df169dcc9ba902d25b6ab0b|runtime"
  "Supertone/supertonic-3|724fb5abbf5502583fb520898d45929e62f02c0b|package-compatible"
  "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice|85e237c12c027371202489a0ec509ded67b5e4b5|runtime"
  "google/gemma-4-12B-it-qat-q4_0-gguf|29d097773436b69ff9feafd636ab4cf873786537|runtime-pair"
  "google/gemma-4-12B-it-qat-q4_0-unquantized-assistant|18934064dd4c5c6cc3621f6381e7d377fc8cb7bd|assistant-source"
)

if ((OFFLINE == 1)); then
  for record in "${REPOSITORIES[@]}"; do
    IFS='|' read -r repo pinned role <<<"$record"
    echo "[pinned] ${repo} ${pinned} (${role})"
  done
  echo "[note] Supertonic runtime intentionally uses the revision selected by supertonic==1.3.1, not an unreviewed repository head."
  exit 0
fi

command -v curl >/dev/null 2>&1 || {
  echo "[check-interpreter-model-updates] curl is required" >&2
  exit 2
}
command -v node >/dev/null 2>&1 || {
  echo "[check-interpreter-model-updates] node is required" >&2
  exit 2
}

updates=0
errors=0
for record in "${REPOSITORIES[@]}"; do
  IFS='|' read -r repo pinned role <<<"$record"
  if ! response="$(curl -fsS --max-time 20 "https://huggingface.co/api/models/${repo}")"; then
    echo "[error] unable to query ${repo}" >&2
    errors=$((errors + 1))
    continue
  fi
  remote="$(printf '%s' "$response" | node -e '
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      try {
        const value = JSON.parse(body);
        process.stdout.write(typeof value.sha === "string" ? value.sha : "");
      } catch {
        process.exitCode = 1;
      }
    });
  ')" || remote=""
  if [[ -z "$remote" ]]; then
    echo "[error] no repository SHA returned for ${repo}" >&2
    errors=$((errors + 1))
  elif [[ "$remote" == "$pinned" ]]; then
    echo "[current] ${repo} ${pinned} (${role})"
  else
    echo "[review] ${repo} pinned=${pinned} remote=${remote} (${role})"
    updates=$((updates + 1))
  fi
done

echo "[check-interpreter-model-updates] review=${updates} errors=${errors}"
echo "[note] Differences are not installed automatically."
((errors == 0))
