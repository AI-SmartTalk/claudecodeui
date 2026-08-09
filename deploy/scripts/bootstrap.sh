#!/usr/bin/env bash
#
# Provisions the host: packages, Docker, Tailscale, firewall, directory layout.
# It knows nothing about the application — deploy.sh owns that half.
#
# Every step inspects the current state before acting, so replaying the script
# on an already-provisioned machine is a no-op. Nothing here is ever done by
# hand on the VPS.
#
# Inputs (via /run/cloudcli-bootstrap.env, written by the CI and deleted on exit):
#   TAILSCALE_AUTHKEY    required on the first run only
#   TAILSCALE_HOSTNAME   optional, defaults to "cloudcli"
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

INSTALL_DIR=${INSTALL_DIR:-/opt/cloudcli}
EPHEMERAL_ENV=/run/cloudcli-bootstrap.env

require_root
trap 'rm -f "${EPHEMERAL_ENV}"' EXIT
load_env_file "${EPHEMERAL_ENV}"

TAILSCALE_HOSTNAME=${TAILSCALE_HOSTNAME:-cloudcli}

export DEBIAN_FRONTEND=noninteractive

install_base_packages() {
  log "Base packages"
  # ufw is deliberately absent: it is installed by configure_firewall only when
  # the host is ours to harden.
  local wanted=(ca-certificates curl gnupg unattended-upgrades)
  local missing=()
  local pkg
  for pkg in "${wanted[@]}"; do
    dpkg -s "${pkg}" >/dev/null 2>&1 || missing+=("${pkg}")
  done

  if [[ ${#missing[@]} -eq 0 ]]; then
    skip "already installed: ${wanted[*]}"
  else
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends "${missing[@]}"
    ok "installed: ${missing[*]}"
  fi

  # Security updates land on their own; this box holds an agent with a shell.
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  ok "unattended security upgrades enabled"
}

install_docker() {
  log "Docker engine"
  if has_command docker && docker compose version >/dev/null 2>&1; then
    skip "docker $(docker --version | awk '{print $3}' | tr -d ,) with compose plugin"
  else
    curl -fsSL https://get.docker.com | sh
    ok "docker installed"
  fi

  systemctl enable --now docker >/dev/null 2>&1
  ok "docker service enabled at boot"
}

install_tailscale() {
  log "Tailscale"
  if ! has_command tailscale; then
    curl -fsSL https://tailscale.com/install.sh | sh
    ok "tailscale installed"
  else
    skip "tailscale already installed"
  fi

  systemctl enable --now tailscaled >/dev/null 2>&1

  # `tailscale status` exits non-zero when logged out or stopped, which is
  # exactly the condition that warrants spending the auth key.
  if tailscale status >/dev/null 2>&1; then
    skip "already joined the tailnet as $(tailscale status --json 2>/dev/null | grep -o '"DNSName":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "${TAILSCALE_HOSTNAME}")"
    return
  fi

  [[ -n ${TAILSCALE_AUTHKEY:-} ]] || die \
    "Host is not on the tailnet and TAILSCALE_AUTHKEY was not provided. Add the TAILSCALE_AUTHKEY secret and rerun."

  # --accept-dns=false keeps the server's resolver untouched; overwriting
  # /etc/resolv.conf on a headless box breaks DNS with no easy way back in.
  tailscale up \
    --authkey="${TAILSCALE_AUTHKEY}" \
    --hostname="${TAILSCALE_HOSTNAME}" \
    --accept-dns=false \
    --ssh=false
  ok "joined the tailnet as ${TAILSCALE_HOSTNAME}"
}

configure_firewall() {
  log "Firewall"

  # Opt-in because flipping a host's default policy is only safe when the host
  # is ours alone: a shared box may publish ports this script knows nothing
  # about. CloudCLI does not depend on it — it binds to loopback and is reached
  # through Tailscale, so the firewall hardens the machine, not the app.
  if [[ ${MANAGE_FIREWALL:-false} != "true" ]]; then
    skip "not managed (set the MANAGE_FIREWALL variable to \"true\" on a dedicated host)"
    return 0
  fi

  dpkg -s ufw >/dev/null 2>&1 || apt-get install -y -qq --no-install-recommends ufw

  # Order matters: SSH is allowed before the policy flips to deny, otherwise
  # enabling UFW locks the deployment out of its own machine.
  ufw --force default deny incoming >/dev/null
  ufw --force default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null
  ufw allow in on tailscale0 >/dev/null
  ufw --force enable >/dev/null
  ok "incoming denied except SSH and the tailnet interface"
}

create_layout() {
  log "Directory layout"
  install -d -m 750 "${INSTALL_DIR}" "${INSTALL_DIR}/scripts"
  ok "${INSTALL_DIR} ready"
}

install_base_packages
install_docker
install_tailscale
configure_firewall
create_layout

log "Host provisioned"
