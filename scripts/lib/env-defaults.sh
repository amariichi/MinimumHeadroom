#!/usr/bin/env bash

# Read the repository's persistent shell-style environment file as defaults
# without executing it. Callers may set values explicitly before invoking a
# launcher; those values always win, including an explicitly empty value.

mh_env_trim_field() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

mh_env_strip_matching_quotes() {
  local value="$1"
  if ((${#value} >= 2)); then
    if [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "$value"
}

mh_default_env_file() {
  if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    printf '%s/minimum-headroom.env' "$XDG_CONFIG_HOME"
  elif [[ -n "${HOME:-}" ]]; then
    printf '%s/.config/minimum-headroom.env' "$HOME"
  fi
}

mh_load_env_defaults() {
  local env_file="$1"
  local line key value

  [[ -n "$env_file" && -e "$env_file" ]] || return 0
  if [[ ! -r "$env_file" ]]; then
    echo "[minimum-headroom-env] config is not readable: ${env_file}" >&2
    return 2
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="$(mh_env_trim_field "$line")"
    [[ -z "$line" || "${line:0:1}" == "#" ]] && continue
    if [[ "$line" == export[[:space:]]* ]]; then
      line="$(mh_env_trim_field "${line#export}")"
    fi
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="$(mh_env_strip_matching_quotes "$(mh_env_trim_field "${BASH_REMATCH[2]}")")"
      if [[ -z "${!key+x}" ]]; then
        export "$key=$value"
      fi
    fi
  done < "$env_file"
}
