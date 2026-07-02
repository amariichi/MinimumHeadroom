#!/usr/bin/env bash
set -uo pipefail

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
INFO_COUNT=0

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P)"
REPO_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." 2>/dev/null && pwd -P)"

status_line() {
  local status="$1"
  local label="$2"
  local detail="$3"

  printf '[%s] %s: %s\n' "$status" "$label" "$detail"

  case "$status" in
    PASS) ((PASS_COUNT += 1)) ;;
    WARN) ((WARN_COUNT += 1)) ;;
    FAIL) ((FAIL_COUNT += 1)) ;;
    INFO) ((INFO_COUNT += 1)) ;;
  esac
}

hint_line() {
  printf '       hint: %s\n' "$1"
}

detail_line() {
  printf '       %s\n' "$1"
}

first_line() {
  local output
  if command_path timeout >/dev/null; then
    output="$(timeout 5 "$@" 2>&1)"
  else
    output="$("$@" 2>&1)"
  fi
  output="${output%%$'\n'*}"
  if [[ -n "$output" ]]; then
    printf '%s' "$output"
  else
    printf 'version unavailable'
  fi
}

command_path() {
  local cmd="$1"
  command -v "$cmd" 2>/dev/null
}

tool_version() {
  local cmd="$1"
  case "$cmd" in
    node | npm | uv | jq | curl | git | claude | codex | agy)
      first_line "$cmd" --version
      ;;
    python3)
      first_line "$cmd" --version
      ;;
    tmux)
      first_line "$cmd" -V
      ;;
    *)
      first_line "$cmd" --version
      ;;
  esac
}

core_tool_hint() {
  local cmd="$1"
  case "$cmd" in
    node)
      printf 'Install Node.js 20+ (Node 24 recommended), then rerun ./scripts/setup.sh.'
      ;;
    npm)
      printf 'Install npm with Node.js 20+.'
      ;;
    uv)
      printf 'Install uv, then rerun ./scripts/setup.sh.'
      ;;
    python3)
      printf 'Install Python 3.10+.'
      ;;
    tmux)
      printf 'Install tmux with your OS package manager.'
      ;;
    jq | curl | git)
      printf 'Install %s with your OS package manager.' "$cmd"
      ;;
    *)
      printf 'Install %s and rerun this check.' "$cmd"
      ;;
  esac
}

check_core_tool() {
  local cmd="$1"
  local label="core tool ${cmd}"
  local version
  local major

  if ! command_path "$cmd" >/dev/null; then
    status_line FAIL "$label" "missing"
    hint_line "$(core_tool_hint "$cmd")"
    return
  fi

  version="$(tool_version "$cmd")"

  if [[ "$cmd" == "node" ]]; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
    if [[ "$major" =~ ^[0-9]+$ ]] && ((major < 20)); then
      status_line WARN "$label" "${version}; Node.js 20+ is required"
      hint_line 'Upgrade Node.js to 20+ (Node 24 recommended), then rerun ./scripts/setup.sh.'
      return
    fi
  fi

  status_line PASS "$label" "$version"
}

check_core_tools() {
  local tools=(node npm uv python3 tmux jq curl git)
  local tool

  for tool in "${tools[@]}"; do
    check_core_tool "$tool"
  done
}

check_repo_state() {
  if [[ -d "${REPO_ROOT}/node_modules" ]]; then
    status_line PASS 'repo node_modules' 'present'
  else
    status_line FAIL 'repo node_modules' 'missing'
    hint_line 'Run ./scripts/setup.sh from the repository root.'
  fi

  if [[ -d "${REPO_ROOT}/face-app/dist" ]]; then
    status_line PASS 'repo face-app/dist' 'present'
  else
    status_line FAIL 'repo face-app/dist' 'missing'
    hint_line 'Run ./scripts/setup.sh from the repository root, then rerun this check.'
  fi
}

agent_cli_hint() {
  local cmd="$1"
  case "$cmd" in
    claude)
      printf 'Install Claude Code if you plan to use Claude as an operator/helper agent.'
      ;;
    codex)
      printf 'Install Codex CLI if you plan to use Codex as an operator/helper agent.'
      ;;
    agy)
      printf 'Install Antigravity CLI if you plan to use agy as an operator/helper agent.'
      ;;
    *)
      printf 'Install %s if you plan to use it as an operator/helper agent.' "$cmd"
      ;;
  esac
}

check_agent_clis() {
  local clis=(claude codex agy)
  local missing=()
  local found=0
  local cli
  local version

  for cli in "${clis[@]}"; do
    if command_path "$cli" >/dev/null; then
      version="$(tool_version "$cli")"
      status_line PASS "agent CLI ${cli}" "$version"
      ((found += 1))
    else
      missing+=("$cli")
    fi
  done

  if ((found == 0)); then
    status_line FAIL 'agent CLIs' 'none of claude, codex, or agy are available'
    hint_line 'Install at least one supported coding-agent CLI before launching helpers.'
    return
  fi

  for cli in "${missing[@]}"; do
    status_line WARN "agent CLI ${cli}" 'missing'
    hint_line "$(agent_cli_hint "$cli")"
  done
}

trim_value() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

check_config() {
  local config="${HOME:-}/.config/minimum-headroom.env"
  local line
  local value
  local found=0

  if [[ ! -f "$config" ]]; then
    status_line FAIL 'config MH_FACE_AUTH_TOKEN' "${config} is missing"
    hint_line 'Create ~/.config/minimum-headroom.env with a non-empty MH_FACE_AUTH_TOKEN; never commit the token.'
    return
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?MH_FACE_AUTH_TOKEN[[:space:]]*= ]] || continue

    value="${line#*=}"
    value="$(trim_value "$value")"
    if [[ -n "$value" ]]; then
      found=1
      break
    fi
  done < "$config"

  if ((found == 1)); then
    status_line PASS 'config MH_FACE_AUTH_TOKEN' "${config} defines a non-empty token"
  else
    status_line FAIL 'config MH_FACE_AUTH_TOKEN' "${config} exists but the token is empty or missing"
    hint_line 'Set MH_FACE_AUTH_TOKEN to a long random value; the value is intentionally not printed here.'
  fi
}

print_codex_apparmor_fix() {
  local codex_cmd="$1"
  local codex_real
  local version_dir
  local releases_dir
  local bundled_glob
  local bundled_current

  codex_real="$(readlink -f "$codex_cmd" 2>/dev/null)"
  if [[ -z "$codex_real" ]]; then
    codex_real="$codex_cmd"
  fi

  if [[ "$codex_real" == */releases/*/bin/* ]]; then
    version_dir="${codex_real%/bin/*}"
    releases_dir="${version_dir%/*}"
    bundled_glob="${releases_dir}/*/codex-resources/bwrap"
    bundled_current="${version_dir}/codex-resources/bwrap"
  else
    version_dir="$(dirname -- "$(dirname -- "$codex_real")")"
    releases_dir="${version_dir%/*}"
    bundled_glob="${releases_dir}/releases/*/codex-resources/bwrap"
    bundled_current="${version_dir}/codex-resources/bwrap"
  fi

  detail_line "resolved codex: ${codex_real}"
  detail_line "current bundled bwrap: ${bundled_current}"
  detail_line "AppArmor attachment glob: ${bundled_glob}"
  detail_line 'copy/paste profile installer:'
  cat <<PROFILE
       cat >/tmp/codex-bwrap <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile codex-bundled-bwrap ${bundled_glob} flags=(unconfined) {
  userns,
}

profile codex-system-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
EOF
       sudo install -m 0644 /tmp/codex-bwrap /etc/apparmor.d/codex-bwrap
       sudo systemctl reload apparmor
       ./scripts/doctor.sh
PROFILE
}

check_codex_sandbox() {
  local codex_cmd
  local output
  local rc
  local restrict_value
  local detail
  local token='__mh_userns_ok__'

  codex_cmd="$(command_path codex || true)"
  if [[ -z "$codex_cmd" ]]; then
    status_line WARN 'codex sandbox' 'skipped because codex CLI is missing'
    hint_line 'Install Codex CLI to verify sandboxed command execution.'
    return
  fi

  if ! command_path timeout >/dev/null; then
    status_line FAIL 'codex sandbox' 'cannot run bounded sandbox check because timeout is missing'
    hint_line 'Install coreutils so doctor can run `timeout 15 codex sandbox -- echo ...` safely.'
    return
  fi

  output="$(timeout 15 codex sandbox -- echo "$token" 2>&1)"
  rc=$?

  if [[ "$output" == *"$token"* ]]; then
    status_line PASS 'codex sandbox' 'sandboxed command executed successfully'
    return
  fi

  restrict_value="$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null)"
  detail='sandboxed command failed'
  if [[ "$restrict_value" == '1' ]]; then
    detail+='; kernel.apparmor_restrict_unprivileged_userns=1'
  elif [[ -n "$restrict_value" ]]; then
    detail+="; kernel.apparmor_restrict_unprivileged_userns=${restrict_value}"
  fi

  status_line FAIL 'codex sandbox' "${detail}"
  hint_line 'Ubuntu 24.04+ can restrict unprivileged user namespaces through AppArmor, which breaks Codex bundled bwrap with errors such as "bwrap: loopback: Failed RTM_NEWADDR".'
  hint_line 'Install the AppArmor profile below, reload AppArmor, then rerun doctor. Until fixed, helpers can still run unsandboxed with `-s danger-full-access`.'
  detail_line "codex sandbox exit code: ${rc}"
  if [[ -n "$output" ]]; then
    detail_line "codex sandbox output: ${output//$'\n'/ | }"
  fi
  print_codex_apparmor_fix "$codex_cmd"
}

check_gpu() {
  local gpu_info
  local first_gpu
  local gpu_count
  local name
  local vram

  if ! command_path nvidia-smi >/dev/null; then
    status_line WARN 'GPU' 'nvidia-smi not found; vision/diffusiongemma and realtime ASR need a GPU, TTS/ASR can run CPU'
    hint_line 'Install NVIDIA drivers for GPU workloads, or use only CPU-friendly TTS/ASR paths.'
    return
  fi

  gpu_info="$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null)"
  if [[ -z "$gpu_info" ]]; then
    status_line WARN 'GPU' 'nvidia-smi is present but no GPU details were returned'
    hint_line 'Check the NVIDIA driver and GPU visibility for vision/diffusiongemma and realtime ASR.'
    return
  fi

  first_gpu="${gpu_info%%$'\n'*}"
  gpu_count="$(printf '%s\n' "$gpu_info" | sed '/^[[:space:]]*$/d' | wc -l | tr -d '[:space:]')"
  name="${first_gpu%,*}"
  vram="${first_gpu##*,}"
  name="$(trim_value "$name")"
  vram="$(trim_value "$vram")"
  if [[ "$gpu_count" == '1' ]]; then
    status_line PASS 'GPU' "${name} (${vram} MiB VRAM)"
  else
    status_line PASS 'GPU' "${name} (${vram} MiB VRAM); ${gpu_count} GPUs visible"
  fi
}

port_listening() {
  local ss_output="$1"
  local port="$2"
  grep -Eq "(^|[[:space:]])[^[:space:]]+:${port}[[:space:]]" <<<"$ss_output"
}

check_stack_ports() {
  local ss_output

  if ! command_path ss >/dev/null; then
    status_line INFO 'stack ports' 'ss is missing; skipping listening-port checks'
    return
  fi

  ss_output="$(ss -ltnH 2>/dev/null)"

  if port_listening "$ss_output" 8765; then
    status_line PASS 'stack face-app :8765' 'listening; service appears to be running'
  else
    status_line INFO 'stack face-app :8765' 'not listening'
  fi

  if port_listening "$ss_output" 8095; then
    status_line PASS 'stack vision-worker :8095' 'listening; service appears to be running'
  else
    status_line INFO 'stack vision-worker :8095' 'not listening'
  fi

  if port_listening "$ss_output" 8096; then
    status_line PASS 'stack m12 alert speaker :8096' 'listening; service appears to be running'
  else
    status_line INFO 'stack m12 alert speaker :8096' 'not listening'
  fi
}

main() {
  check_core_tools
  check_repo_state
  check_agent_clis
  check_codex_sandbox
  check_config
  check_gpu
  check_stack_ports

  printf '\nSummary: %d PASS, %d WARN, %d FAIL' "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
  if ((INFO_COUNT > 0)); then
    printf ', %d INFO' "$INFO_COUNT"
  fi
  printf '\n'

  if ((FAIL_COUNT > 0)); then
    exit 1
  fi
}

main "$@"
