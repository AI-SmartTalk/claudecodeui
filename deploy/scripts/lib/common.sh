#!/usr/bin/env bash
# Output helpers and guards shared by bootstrap.sh and deploy.sh.
# Sourced, never executed directly.

log() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }
skip() { printf '  \033[0;90m·\033[0m %s\n' "$*"; }
warn() { printf '  \033[0;33m!\033[0m %s\n' "$*" >&2; }
die() {
  printf '\n\033[0;31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

require_root() {
  [[ ${EUID} -eq 0 ]] || die "This script must run as root."
}

require_env() {
  local name
  for name in "$@"; do
    [[ -n ${!name:-} ]] || die "Missing required variable: ${name}"
  done
}

# Loads a secrets file dropped by the CI. Values reach the script through the
# environment rather than argv, so they never surface in a process list.
# Deleting the file is the caller's job — it owns the EXIT trap.
load_env_file() {
  local file=$1
  [[ -f ${file} ]] || return 0
  set -a
  # shellcheck disable=SC1090
  . "${file}"
  set +a
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}
