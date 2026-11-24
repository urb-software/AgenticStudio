#!/usr/bin/env bash
# Server setup for AI Agent Studio (Issue #107; ADR 0002; docs/engineering/deployment.md).
#
# Sets up the two sides of the isolation boundary on one Ubuntu 24.04 LTS server:
#   - Studio's side: the system Docker daemon (root only) and Studio's Compose files and
#     configuration, readable by root only.
#   - The agent side: the agent user (never in the `docker` group, no passwordless sudo), its
#     rootless Docker daemon kept running without a login session, the agent worker as its
#     systemd user service, and resource limits for the user.
#   - The Preview side (ADR 0004): the Preview user, built the same way, with its own
#     rootless Docker daemon whose network namespace carries egress rules, a firewall of its own,
#     limits, the Preview proxy socket directory and the environment controller as its user service.
#
# Usage, as root, from a checkout of the repository:
#   sudo deploy/setup-server.sh                  # every step
#   sudo deploy/setup-server.sh --only node,worker
#   sudo deploy/setup-server.sh --list           # the steps and what each one changes
#
# Safe to run again: each step checks the current state first and reports `unchanged` or what
# it changed. It never writes a secret value: it creates the configuration files from templates
# with empty values and prints which value goes where. It refuses to continue if the agent user
# is in the `docker` group or can use sudo without a password.
# shellcheck disable=SC2016,SC2317 # single-quoted text run by another shell; steps called by name
set -Eeuo pipefail
umask 022

# --- Configuration (placeholders; override through the environment) ---------------------------
AGENT_USER="${AGENT_USER:-agent}"
# Fixed uid/gid for the agent user, outside the range ordinary users and images commonly use
# (1000, 10001); an existing agent user below 2000 is refused.
AGENT_UID="${AGENT_UID:-2001}"
# The uid/gid Studio's API and web containers run as (compose.server.app.yaml); it owns Studio's
# data directory. Never the agent user's uid.
STUDIO_CONTAINER_UID="${STUDIO_CONTAINER_UID:-10001}"
STUDIO_CONFIG_DIR="${STUDIO_CONFIG_DIR:-/etc/agentic-studio}"
STUDIO_STATE_DIR="${STUDIO_STATE_DIR:-/var/lib/agentic-studio}"
STUDIO_COMPOSE_DIR="${STUDIO_COMPOSE_DIR:-/opt/agentic-studio}"
WORKER_CODE_DIR="${WORKER_CODE_DIR:-/opt/agentic-studio-worker}"
# Node.js for the agent worker: the official binary tarball, checked against SHASUMS256.txt.
NODE_VERSION="${NODE_VERSION:-24.22.1}"
NODE_DIST_URL="${NODE_DIST_URL:-https://nodejs.org/dist}"
# SHA-256 of the official tarballs of NODE_VERSION, pinned here (from the release's
# SHASUMS256.txt). Changing NODE_VERSION needs both values changed with it.
NODE_SHA256_X64="${NODE_SHA256_X64:-6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6}"
NODE_SHA256_ARM64="${NODE_SHA256_ARM64:-dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e}"
# Studio's container network and its reverse proxy's fixed address (equal to the Compose files
# and studio.env.example). The agent user may reach only the proxy's worker port on it (the
# worker's STUDIO_API_URL); the API, PostgreSQL, Redis and everything else there are rejected.
STUDIO_NETWORK_SUBNET="${STUDIO_NETWORK_SUBNET:-172.31.250.0/24}"
STUDIO_PROXY_ADDRESS="${STUDIO_PROXY_ADDRESS:-172.31.250.20}"
STUDIO_PROXY_WORKER_PORT="${STUDIO_PROXY_WORKER_PORT:-8080}"
# Limits for everything the agent user runs (its user slice, rootless Docker included).
AGENT_MEMORY_MAX="${AGENT_MEMORY_MAX:-75%}"
AGENT_TASKS_MAX="${AGENT_TASKS_MAX:-4096}"
AGENT_CPU_WEIGHT="${AGENT_CPU_WEIGHT:-50}"
# The Preview user: runs the environment controller and the Previews' own rootless
# Docker daemon. Never the agent user's uid; an existing Preview user below 2000 is refused.
PREVIEW_USER="${PREVIEW_USER:-preview}"
PREVIEW_UID="${PREVIEW_UID:-2002}"
# The group the reverse proxy container joins to reach the Preview sockets in /run/preview-proxy
# (compose.server.preview.yaml, PREVIEW_PROXY_GID). The Preview user is not a member: the socket
# directory is setgid, so sockets created in it carry the group.
PREVIEW_PROXY_GID="${PREVIEW_PROXY_GID:-2003}"
PREVIEW_PROXY_GROUP="previewproxy"
PREVIEW_PROXY_DIR="/run/preview-proxy"
CONTROLLER_CODE_DIR="${CONTROLLER_CODE_DIR:-/opt/agentic-studio-controller}"
# Limits for everything the Preview user runs (its user slice, rootless Docker and builds included).
PREVIEW_MEMORY_MAX="${PREVIEW_MEMORY_MAX:-50%}"
PREVIEW_TASKS_MAX="${PREVIEW_TASKS_MAX:-4096}"
PREVIEW_CPU_WEIGHT="${PREVIEW_CPU_WEIGHT:-50}"
# The resolver the Previews' containers may reach (DNS only); empty: the first non-loopback IPv4
# nameserver of /run/systemd/resolve/resolv.conf, else /etc/resolv.conf.
PREVIEW_DNS="${PREVIEW_DNS:-}"
# Disk quota on the agent user's home filesystem, in GiB; empty sets none. Applied only where
# the filesystem has user quotas switched on (reported otherwise).
AGENT_DISK_QUOTA_GB="${AGENT_DISK_QUOTA_GB:-}"
# -------------------------------------------------------------------------------------------------

STEPS=(preflight packages node user preview-user logins layout worker controller guardrails firewall
  preview-firewall limits rootless preview-rootless preview-proxy-dir service controller-service)
SYSTEMD_STEPS=(firewall preview-firewall limits rootless preview-rootless preview-proxy-dir service controller-service)
DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
DOCKER_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  docker-ce-rootless-extras)
BASE_PACKAGES=(ca-certificates curl gnupg git xz-utils uidmap slirp4netns dbus-user-session
  fuse-overlayfs iptables acl quota socat util-linux iproute2)
FIREWALL_CHAIN="AGENTIC-STUDIO-AGENT"
PREVIEW_FIREWALL_CHAIN="AGENTIC-STUDIO-PREVIEW"
PREVIEW_EGRESS_SCRIPT="/usr/local/lib/agentic-studio/preview-egress-rules"
# Groups besides docker whose members can become root.
ROOT_EQUIVALENT_GROUPS="lxd incus-admin libvirt disk"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CHANGES=0

log() { printf '%s\n' "$*"; }
step_log() { printf '[%s] %s\n' "$CURRENT_STEP" "$*"; }
changed() {
  CHANGES=$((CHANGES + 1))
  step_log "changed: $*"
}
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}
trap 'printf "ERROR: %s failed at line %s (step %s).\n" "${BASH_COMMAND%% *}" "$LINENO" "${CURRENT_STEP:-none}" >&2' ERR

CURRENT_STEP=""

usage() {
  cat <<EOF
Usage: $0 [--only step[,step...]] [--list] [--help]
Steps, in order: ${STEPS[*]}
Steps that need systemd (PID 1) and cgroup v2: ${SYSTEMD_STEPS[*]}
EOF
}

list_steps() {
  cat <<EOF
preflight  Checks: root, Ubuntu 24.04, a root-only checkout, and the agent user (if it exists) is not in the docker group
           and has no passwordless sudo. Changes nothing.
packages   Base packages (${BASE_PACKAGES[*]}), Docker's official apt repository
           (/etc/apt/keyrings/docker.asc, /etc/apt/sources.list.d/docker.sources, key fingerprint
           checked) and ${DOCKER_PACKAGES[*]}; enables the system Docker daemon.
node       Node.js ${NODE_VERSION} into /usr/local (root-owned), pinned SHA-256 verified; corepack enabled.
user       Creates the agent user '${AGENT_USER}' with uid/gid ${AGENT_UID} (home directory, own group, no password, no sudo)
           with a subordinate uid/gid range; checks it again afterwards.
preview-user  Creates the Preview user '${PREVIEW_USER}' (uid/gid ${PREVIEW_UID}) the same way, and the group
           '${PREVIEW_PROXY_GROUP}' (gid ${PREVIEW_PROXY_GID}) for the reverse proxy; the Preview user is in no root-equivalent
           group, not in the proxy group, and shares no group with the agent user.
logins     The agent and Preview users get no cron (/etc/cron.deny), no at (/etc/at.deny) and no SSH login
           (/etc/ssh/sshd_config.d/60-agentic-studio.conf, when sshd is installed); logind kills their
           session processes at logout (/etc/systemd/logind.conf.d/60-agentic-studio.conf).
layout     Root only: ${STUDIO_CONFIG_DIR} (0700, .env 0600 from deploy/studio.env.example),
           ${STUDIO_STATE_DIR} (0700; data/ and proxy/ owned by uid ${STUDIO_CONTAINER_UID}),
           ${STUDIO_COMPOSE_DIR} (0700, compose files 0600, Caddyfiles 0644),
           /usr/local/sbin/agentic-studio-compose; /usr/local/bin/agentic-studio-check-boundary.
           Agent side, written as the agent user: ~/.config/agentic-studio-worker/.env (0600, from
           apps/agent-worker/.env.example) and ~/.local/share/agentic-studio-worker (0700).
           Preview side, written as the Preview user: ~/.config/agentic-studio-controller/.env (0600, from
           apps/environment-controller/.env.example, empty token) and ~/.local/share/agentic-studio-controller (0700);
           /usr/local/bin/agentic-studio-check-preview.
worker     The agent worker's code from this checkout's HEAD into ${WORKER_CODE_DIR} (root-owned,
           world-readable, not writable by the agent user), installed and built there.
controller The environment controller's code from this checkout's HEAD into ${CONTROLLER_CODE_DIR} (root-owned,
           world-readable, not writable by the Preview user), installed and built there.
guardrails Studio's managed guardrails for Claude Code and Codex, from the worker's guardrails folder
           (${WORKER_CODE_DIR}/apps/agent-worker/guardrails, its managed-files.txt): root:root, files 0644,
           directories 0755 (/etc/claude-code/managed-settings.json, /etc/codex/managed_config.toml,
           /etc/codex/requirements.toml, /usr/local/lib/agentic-studio/guardrails/claude-guard.mjs).
           Refuses while /etc/claude-code/managed-settings.d, /etc/claude-code/managed-mcp.json or
           /etc/codex/config.toml exists (the CLIs would merge them into the policy).
firewall   /usr/local/sbin/agentic-studio-agent-firewall and agentic-studio-agent-firewall.service:
           rejects the agent user's traffic to ${STUDIO_NETWORK_SUBNET} except the reverse proxy's worker
           port (${STUDIO_PROXY_ADDRESS}:${STUDIO_PROXY_WORKER_PORT});
           a verify timer, and a drop-in binding user@<uid>.service to the firewall (fail closed).
preview-firewall  The same for the Preview user (agentic-studio-preview-firewall.service, chain ${PREVIEW_FIREWALL_CHAIN}).
limits     /etc/systemd/system/user-<uid>.slice.d/50-agentic-studio.conf (MemoryMax=${AGENT_MEMORY_MAX},
           TasksMax=${AGENT_TASKS_MAX}, CPUWeight=${AGENT_CPU_WEIGHT}), cgroup delegation for user managers,
           and a disk quota where available. The same for the Preview user (MemoryMax=${PREVIEW_MEMORY_MAX},
           TasksMax=${PREVIEW_TASKS_MAX}, CPUWeight=${PREVIEW_CPU_WEIGHT}).
rootless   AppArmor profile for rootlesskit where Ubuntu restricts user namespaces, linger for the
           agent user, and its rootless Docker daemon as a systemd user service.
preview-rootless  The Preview user's rootless Docker daemon (linger, systemd user service), its daemon.json
           (dns), ${PREVIEW_EGRESS_SCRIPT} (root-owned) and the docker.service drop-in that applies the
           egress rules in the daemon's network namespace at every start.
preview-proxy-dir  /etc/tmpfiles.d/agentic-studio-preview-proxy.conf: ${PREVIEW_PROXY_DIR} (setgid 2750,
           ${PREVIEW_USER}:${PREVIEW_PROXY_GROUP}) at every boot; created now as well.
service    /etc/systemd/user/agentic-studio-worker.service, enabled for the agent user; started only
           once its worker token is filled in.
controller-service  /etc/systemd/user/agentic-studio-controller.service, enabled for the Preview user (ConditionUser);
           started only once its STUDIO_CONTROLLER_TOKEN is filled in.
EOF
}

# --- Helpers --------------------------------------------------------------------------------------

has_systemd() { [ -d /run/systemd/system ] && [ "$(cat /proc/1/comm 2>/dev/null)" = systemd ]; }

agent_exists() { id -u "$AGENT_USER" >/dev/null 2>&1; }
agent_uid() { id -u "$AGENT_USER"; }
agent_home() { getent passwd "$AGENT_USER" | cut -d: -f6; }

preview_exists() { id -u "$PREVIEW_USER" >/dev/null 2>&1; }
preview_uid() { id -u "$PREVIEW_USER"; }
preview_home() { getent passwd "$PREVIEW_USER" | cut -d: -f6; }

# Runs a command as a user (the agent user or the Preview user) with a clean environment. Files
# in their homes are only ever written this way, never by root, so a planted symlink cannot
# redirect a root write.
as_user() {
  local user="$1" uid home
  shift
  uid="$(id -u "$user")"
  home="$(getent passwd "$user" | cut -d: -f6)"
  (cd / && runuser -u "$user" -- env -i HOME="$home" USER="$user" LOGNAME="$user" \
    SHELL=/bin/bash PATH=/usr/local/bin:/usr/bin:/bin XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@")
}
as_agent() { as_user "$AGENT_USER" "$@"; }
as_preview() { as_user "$PREVIEW_USER" "$@"; }

# The agent user must never be in the docker group or able to use sudo without a password.
assert_agent_safe() {
  agent_exists || return 0
  [ "$(agent_uid)" != 0 ] || die "the agent user '$AGENT_USER' has uid 0."
  [ "$(agent_uid)" -ge 2000 ] ||
    die "the agent user '$AGENT_USER' has uid $(agent_uid), below 2000, where ordinary users and container images commonly run. Use a dedicated user with a uid of 2000 or more (AGENT_UID, default 2001)."
  [ "$(agent_uid)" != "$STUDIO_CONTAINER_UID" ] ||
    die "the agent user's uid equals STUDIO_CONTAINER_UID ($STUDIO_CONTAINER_UID), the uid of Studio's containers."
  if id -nG "$AGENT_USER" | tr ' ' '\n' | grep -qx docker; then
    die "the agent user '$AGENT_USER' is in the docker group: that is root-equivalent access to the system Docker daemon. Remove it (gpasswd -d $AGENT_USER docker) and run the script again."
  fi
  local group
  for group in $ROOT_EQUIVALENT_GROUPS; do
    if id -nG "$AGENT_USER" | tr ' ' '\n' | grep -qx "$group"; then
      die "the agent user '$AGENT_USER' is in the $group group, which is root-equivalent. Remove it (gpasswd -d $AGENT_USER $group) and run the script again."
    fi
  done
  if id -nG "$AGENT_USER" | tr ' ' '\n' | grep -qx "$PREVIEW_PROXY_GROUP"; then
    die "the agent user '$AGENT_USER' is in the $PREVIEW_PROXY_GROUP group: it could reach the Preview sockets and skip the Preview password. Remove it (gpasswd -d $AGENT_USER $PREVIEW_PROXY_GROUP) and run the script again."
  fi
  if command -v sudo >/dev/null 2>&1; then
    if sudo -n -l -U "$AGENT_USER" 2>/dev/null | grep -Eq 'NOPASSWD|!authenticate'; then
      die "the agent user '$AGENT_USER' has passwordless sudo rules (sudo -l -U $AGENT_USER). Remove them and run the script again."
    fi
    if (cd / && runuser -u "$AGENT_USER" -- sudo -n true) >/dev/null 2>&1; then
      die "the agent user '$AGENT_USER' can use sudo without a password. Remove that and run the script again."
    fi
  fi
  if id -nG "$AGENT_USER" | tr ' ' '\n' | grep -Eqx 'sudo|admin|wheel'; then
    log "WARNING: the agent user '$AGENT_USER' is in an administrator group (sudo/admin/wheel). It needs no sudo at all."
  fi
}

# The Preview settings, checked before anything else (they end up in file names, unit files and
# firewall rules), whether or not the Preview user exists yet.
validate_preview_settings() {
  if ! [[ "$PREVIEW_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || [ "$PREVIEW_USER" = root ] || [ "$PREVIEW_USER" = "$AGENT_USER" ]; then
    die "PREVIEW_USER '$PREVIEW_USER' is not a valid ordinary user name, or equals the agent user."
  fi
  if ! [[ "$PREVIEW_UID" =~ ^[0-9]+$ ]] || [ "$PREVIEW_UID" -lt 2000 ]; then
    die "PREVIEW_UID must be a number of 2000 or more (below 2000 ordinary users and container images commonly run)."
  fi
  [ "$PREVIEW_UID" != "$AGENT_UID" ] || die "PREVIEW_UID ($PREVIEW_UID) must differ from the agent user's uid (AGENT_UID)."
  if agent_exists && [ "$PREVIEW_UID" = "$(agent_uid)" ]; then
    die "PREVIEW_UID ($PREVIEW_UID) must differ from the agent user's uid."
  fi
  [ "$PREVIEW_UID" != "$STUDIO_CONTAINER_UID" ] || die "PREVIEW_UID equals STUDIO_CONTAINER_UID ($STUDIO_CONTAINER_UID), the uid of Studio's containers."
  local taken
  taken="$(getent passwd "$PREVIEW_UID" | cut -d: -f1 || true)"
  if [ -n "$taken" ] && [ "$taken" != "$PREVIEW_USER" ]; then
    die "uid $PREVIEW_UID is already taken by the user '$taken' (PREVIEW_UID)."
  fi
  taken="$(getent group "$PREVIEW_UID" | cut -d: -f1 || true)"
  if [ -n "$taken" ] && [ "$taken" != "$PREVIEW_USER" ]; then
    die "gid $PREVIEW_UID is already taken by the group '$taken' (PREVIEW_UID)."
  fi
  if ! [[ "$PREVIEW_PROXY_GID" =~ ^[0-9]+$ ]] || [ "$PREVIEW_PROXY_GID" -lt 2000 ]; then
    die "PREVIEW_PROXY_GID must be a number of 2000 or more."
  fi
  local gid
  for gid in "$AGENT_UID" "$PREVIEW_UID" "$STUDIO_CONTAINER_UID"; do
    [ "$PREVIEW_PROXY_GID" != "$gid" ] || die "PREVIEW_PROXY_GID ($PREVIEW_PROXY_GID) must differ from the agent, Preview and Studio container ids."
  done
  local holder own
  holder="$(getent group "$PREVIEW_PROXY_GID" | cut -d: -f1 || true)"
  if [ -n "$holder" ] && [ "$holder" != "$PREVIEW_PROXY_GROUP" ]; then
    die "gid $PREVIEW_PROXY_GID is already taken by the group '$holder' (PREVIEW_PROXY_GID); the Preview proxy group is '$PREVIEW_PROXY_GROUP'."
  fi
  own="$(getent group "$PREVIEW_PROXY_GROUP" | cut -d: -f3 || true)"
  if [ -n "$own" ] && [ "$own" != "$PREVIEW_PROXY_GID" ]; then
    die "the group '$PREVIEW_PROXY_GROUP' exists with gid $own, not PREVIEW_PROXY_GID ($PREVIEW_PROXY_GID)."
  fi
  [[ "$PREVIEW_MEMORY_MAX" =~ ^[0-9]+(%|[KMGT])?$ ]] || die "PREVIEW_MEMORY_MAX must be a number with an optional %, K, M, G or T."
  [[ "$PREVIEW_TASKS_MAX" =~ ^[0-9]+$ ]] || die "PREVIEW_TASKS_MAX must be a number."
  [[ "$PREVIEW_CPU_WEIGHT" =~ ^[0-9]+$ ]] || die "PREVIEW_CPU_WEIGHT must be a number."
  [[ "$CONTROLLER_CODE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "CONTROLLER_CODE_DIR must be an absolute path of plain characters."
  [ -z "$PREVIEW_DNS" ] || [[ "$PREVIEW_DNS" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "PREVIEW_DNS must be an IPv4 address."
}

# The Preview user must never be in the docker group, a root-equivalent group or sudo, nor in the
# proxy group, and shares no group with the agent user (neither can reach the other's files).
assert_preview_safe() {
  preview_exists || return 0
  local uid group
  uid="$(preview_uid)"
  [ "$uid" != 0 ] || die "the Preview user '$PREVIEW_USER' has uid 0."
  [ "$uid" -ge 2000 ] ||
    die "the Preview user '$PREVIEW_USER' has uid $uid, below 2000, where ordinary users and container images commonly run. Use a dedicated user with a uid of 2000 or more (PREVIEW_UID, default 2002)."
  [ "$uid" != "$STUDIO_CONTAINER_UID" ] || die "the Preview user's uid equals STUDIO_CONTAINER_UID ($STUDIO_CONTAINER_UID)."
  if agent_exists && [ "$uid" = "$(agent_uid)" ]; then die "the Preview user '$PREVIEW_USER' has the agent user's uid."; fi
  for group in docker $ROOT_EQUIVALENT_GROUPS sudo admin wheel "$PREVIEW_PROXY_GROUP"; do
    if id -nG "$PREVIEW_USER" | tr ' ' '\n' | grep -qx "$group"; then
      die "the Preview user '$PREVIEW_USER' is in the $group group, which it must not be (root-equivalent access, or access to the proxy's sockets without the setgid directory). Remove it (gpasswd -d $PREVIEW_USER $group) and run the script again."
    fi
  done
  if command -v sudo >/dev/null 2>&1; then
    if sudo -n -l -U "$PREVIEW_USER" 2>/dev/null | grep -Eq 'NOPASSWD|!authenticate'; then
      die "the Preview user '$PREVIEW_USER' has passwordless sudo rules (sudo -l -U $PREVIEW_USER). Remove them and run the script again."
    fi
    if (cd / && runuser -u "$PREVIEW_USER" -- sudo -n true) >/dev/null 2>&1; then
      die "the Preview user '$PREVIEW_USER' can use sudo without a password. Remove that and run the script again."
    fi
  fi
  if agent_exists; then
    local shared
    shared="$(comm -12 <(id -nG "$AGENT_USER" | tr ' ' '\n' | sort) <(id -nG "$PREVIEW_USER" | tr ' ' '\n' | sort) | tr '\n' ' ')"
    [ -z "$shared" ] || die "the agent user and the Preview user share the group(s) ${shared% }: they must have no group in common."
  fi
}

# Installs a file from stdin when its content, owner or mode differ. Root-owned paths only.
install_content() {
  local dest="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat >"$tmp" || die "could not stage $dest."
  [ -s "$tmp" ] || die "refusing to install empty content as $dest."
  if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$tmp" "$dest" &&
    [ "$(stat -c '%U:%G %a' "$dest")" = "root:root $mode" ]; then
    rm -f "$tmp"
    return 1
  fi
  install -o root -g root -m "$mode" "$tmp" "$dest" || die "could not install $dest."
  rm -f "$tmp"
  changed "$dest"
}

# install_template <dest> <mode> <source> <sed expression>...: installs the source with the
# expressions applied; a failing sed or an empty result stops the script.
install_template() {
  local dest="$1" mode="$2" source="$3" expressions=() content
  shift 3
  for content in "$@"; do expressions+=(-e "$content"); done
  content="$(sed "${expressions[@]}" "$source")" || die "could not render $source."
  [ -n "$content" ] || die "rendering $source gave nothing."
  install_content "$dest" "$mode" <<<"$content"
}

# A root-owned directory with an exact mode.
ensure_root_dir() {
  local dir="$1" mode="$2"
  [ ! -L "$dir" ] || die "$dir is a symbolic link; refusing to use it."
  if [ -d "$dir" ] && [ "$(stat -c '%U:%G %a' "$dir")" = "root:root $mode" ]; then return 0; fi
  install -d -o root -g root -m "$mode" "$dir"
  changed "$dir (root:root $mode)"
}

# Starts the agent user's manager if it is down (for example stopped with its firewall); its
# drop-in starts the firewall first. Then waits for its bus.
wait_for_user_bus() {
  local user="${1:-$AGENT_USER}" uid
  uid="$(id -u "$user")"
  systemctl start "user@$uid.service"
  for _ in $(seq 1 30); do
    [ -S "/run/user/$uid/bus" ] && return 0
    sleep 1
  done
  die "the systemd user manager of '$user' did not start (no /run/user/$uid/bus)."
}

# --- Steps ----------------------------------------------------------------------------------------

step_preflight() {
  [ "$(id -u)" = 0 ] || die "run as root (sudo $0)."
  [ -r /etc/os-release ] || die "cannot read /etc/os-release; only Ubuntu 24.04 LTS is supported."
  local id version
  # shellcheck source=/dev/null
  id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  # shellcheck source=/dev/null
  version="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
  if [ "$id" != ubuntu ] || [ "$version" != 24.04 ]; then
    die "unsupported distribution '${id:-unknown} ${version:-}': only Ubuntu 24.04 LTS is supported."
  fi
  case "$(uname -m)" in x86_64 | aarch64) ;; *) die "unsupported architecture $(uname -m)." ;; esac
  if ! [[ "$AGENT_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || [ "$AGENT_USER" = root ]; then
    die "AGENT_USER '$AGENT_USER' is not a valid ordinary user name."
  fi
  # Per-user directories set globally (pam_env reads /etc/environment for user managers too) would
  # point the agent user's services, rootless Docker included, at another user's directories.
  local global
  global="$(grep -Eo '^[[:space:]]*(export[[:space:]]+)?(XDG_[A-Z_]+|DOCKER_HOST|DOCKER_CONFIG)=' /etc/environment 2>/dev/null |
    sed -E 's/^[[:space:]]*(export[[:space:]]+)?//; s/=$//' | tr '\n' ' ' || true)"
  [ -z "$global" ] || die "/etc/environment sets per-user variables for every user (${global% }); remove those lines and run the script again."

  if grep -qi microsoft /proc/version 2>/dev/null; then
    log "WARNING: this looks like WSL. WSL with default settings is not an isolation boundary (ADR 0002); the target is native Linux."
  fi
  assert_agent_safe
  validate_preview_settings
  assert_preview_safe
  # Root runs code from this checkout (the worker build, the installed check script), so only
  # root may be able to change it.
  local writable
  writable="$(find "$REPO_DIR" -xdev \( ! -user root -o -perm /022 \) ! -type l -print -quit 2>/dev/null || true)"
  [ -z "$writable" ] || die "the checkout $REPO_DIR must be owned by root and writable by root only (found: $writable). Clone it as root, e.g. into /usr/local/src/agentic-studio."
  # Its parents too: whoever can write one could swap the checkout between the check and the build.
  local dir="$REPO_DIR"
  while [ "$dir" != / ]; do
    dir="$(dirname "$dir")"
    if [ "$(stat -c %U "$dir")" != root ] || [ $((8#$(stat -c %a "$dir") & 8#022)) -ne 0 ]; then
      die "$dir (a parent of the checkout) must be owned by root and writable by root only."
    fi
  done
  step_log "ok"
}

step_packages() {
  export DEBIAN_FRONTEND=noninteractive
  local missing=() pkg
  for pkg in "${BASE_PACKAGES[@]}"; do
    dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    apt-get update -q
    apt-get install -y -q --no-install-recommends "${missing[@]}"
    changed "installed ${missing[*]}"
  fi

  # Docker's official repository, with its signing key's fingerprint checked. Another source for
  # the same repository would make apt refuse the conflicting Signed-By values.
  local other
  other="$(grep -ls 'download\.docker\.com' /etc/apt/sources.list /etc/apt/sources.list.d/* |
    grep -vx /etc/apt/sources.list.d/docker.sources || true)"
  [ -z "$other" ] || die "another apt source for Docker exists ($other); remove it and run the script again."
  install -d -m 0755 /etc/apt/keyrings
  local key fingerprint
  key="$(mktemp)"
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$key"
  fingerprint="$(gpg --batch --with-colons --show-keys "$key" | awk -F: '$1 == "fpr" { print $10; exit }')"
  [ "$fingerprint" = "$DOCKER_GPG_FINGERPRINT" ] ||
    die "Docker's apt signing key has an unexpected fingerprint ($fingerprint)."
  install_content /etc/apt/keyrings/docker.asc 644 <"$key" || true
  rm -f "$key"
  local codename arch repo_changed=0
  # shellcheck source=/dev/null
  codename="$(. /etc/os-release && printf '%s' "$VERSION_CODENAME")"
  arch="$(dpkg --print-architecture)"
  install_content /etc/apt/sources.list.d/docker.sources 644 <<EOF && repo_changed=1
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $codename
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  missing=()
  for pkg in "${DOCKER_PACKAGES[@]}"; do
    dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -gt 0 ] || [ "$repo_changed" = 1 ]; then
    apt-get update -q
    if [ "${#missing[@]}" -gt 0 ]; then
      apt-get install -y -q "${missing[@]}"
      changed "installed ${missing[*]}"
    fi
  fi
  if has_systemd && ! systemctl is-enabled --quiet docker.service; then
    systemctl enable --now docker.service
    changed "enabled the system Docker daemon"
  fi
  step_log "ok"
}

step_node() {
  local current=""
  [ -x /usr/local/bin/node ] && current="$(/usr/local/bin/node --version 2>/dev/null || true)"
  if [ "$current" = "v$NODE_VERSION" ]; then
    step_log "unchanged (Node.js $current)"
  else
    local arch tarball tmp expected
    case "$(uname -m)" in
      x86_64) arch=x64 expected="$NODE_SHA256_X64" ;;
      aarch64) arch=arm64 expected="$NODE_SHA256_ARM64" ;;
    esac
    [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "no pinned SHA-256 for Node.js $NODE_VERSION ($arch)."
    tarball="node-v${NODE_VERSION}-linux-${arch}.tar.xz"
    tmp="$(mktemp -d)"
    curl -fsSL "$NODE_DIST_URL/v$NODE_VERSION/$tarball" -o "$tmp/$tarball"
    printf '%s  %s\n' "$expected" "$tmp/$tarball" | sha256sum -c --status - ||
      die "$tarball does not match its pinned SHA-256 (NODE_SHA256_${arch^^})."
    tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1 --no-same-owner \
      --wildcards "node-v${NODE_VERSION}-linux-${arch}/"{bin,include,lib,share}
    rm -rf "$tmp"
    changed "Node.js v$NODE_VERSION in /usr/local (was ${current:-none})"
  fi
  # pnpm through corepack, at the version in the repository's packageManager field.
  if [[ "$(readlink -f /usr/local/bin/pnpm 2>/dev/null)" != */corepack/* ]]; then
    rm -f /usr/local/bin/pnpm /usr/local/bin/pnpx
    /usr/local/bin/corepack enable --install-directory /usr/local/bin pnpm
    changed "corepack shim for pnpm in /usr/local/bin"
  fi
}

# Rootless Docker needs a subordinate uid/gid range; useradd normally assigns one.
ensure_subids() {
  local user="$1" file start
  for file in /etc/subuid /etc/subgid; do
    [ -e "$file" ] || install -o root -g root -m 0644 /dev/null "$file"
    if ! grep -q "^$user:" "$file"; then
      start="$(awk -F: 'BEGIN { m = 100000 } { e = $2 + $3; if (e > m) m = e } END { print m }' "$file")"
      if [ "$file" = /etc/subuid ]; then
        usermod --add-subuids "$start-$((start + 65535))" "$user"
      else
        usermod --add-subgids "$start-$((start + 65535))" "$user"
      fi
      changed "$file range $start-$((start + 65535)) for '$user'"
    fi
  done
}

# The user's home directory must not be accessible to other users.
ensure_private_home() {
  local user="$1" home mode
  home="$(getent passwd "$user" | cut -d: -f6)"
  [ -d "$home" ] || die "the home directory $home of '$user' does not exist."
  mode="$(stat -c '%a' "$home")"
  if [ "${mode: -1}" != 0 ]; then
    chmod o-rwx "$home"
    changed "$home not accessible to other users"
  fi
}

step_user() {
  if ! agent_exists; then
    if ! [[ "$AGENT_UID" =~ ^[0-9]+$ ]] || [ "$AGENT_UID" -lt 2000 ]; then
      die "AGENT_UID must be a number of 2000 or more."
    fi
    ! getent passwd "$AGENT_UID" >/dev/null || die "uid $AGENT_UID is already taken (AGENT_UID)."
    ! getent group "$AGENT_UID" >/dev/null || die "gid $AGENT_UID is already taken (AGENT_UID)."
    groupadd --gid "$AGENT_UID" "$AGENT_USER"
    useradd --create-home --uid "$AGENT_UID" --gid "$AGENT_UID" --shell /bin/bash "$AGENT_USER"
    changed "created the agent user '$AGENT_USER' with uid/gid $AGENT_UID (no password, no sudo)"
  fi
  ensure_subids "$AGENT_USER"
  ensure_private_home "$AGENT_USER"
  assert_agent_safe
  step_log "ok ('$AGENT_USER' is not in the docker group and has no passwordless sudo)"
}

step_preview_user() {
  agent_exists || die "the agent user does not exist yet; run the user step first."
  if ! getent group "$PREVIEW_PROXY_GROUP" >/dev/null; then
    groupadd --gid "$PREVIEW_PROXY_GID" "$PREVIEW_PROXY_GROUP"
    changed "created the group '$PREVIEW_PROXY_GROUP' with gid $PREVIEW_PROXY_GID (the reverse proxy's access to the Preview sockets)"
  fi
  if ! preview_exists; then
    ! getent passwd "$PREVIEW_UID" >/dev/null || die "uid $PREVIEW_UID is already taken (PREVIEW_UID)."
    ! getent group "$PREVIEW_UID" >/dev/null || die "gid $PREVIEW_UID is already taken (PREVIEW_UID)."
    groupadd --gid "$PREVIEW_UID" "$PREVIEW_USER"
    useradd --create-home --uid "$PREVIEW_UID" --gid "$PREVIEW_UID" --shell /bin/bash "$PREVIEW_USER"
    changed "created the Preview user '$PREVIEW_USER' with uid/gid $PREVIEW_UID (no password, no sudo)"
  fi
  ensure_subids "$PREVIEW_USER"
  ensure_private_home "$PREVIEW_USER"
  assert_preview_safe
  step_log "ok ('$PREVIEW_USER' is in no root-equivalent group, not in '$PREVIEW_PROXY_GROUP', shares no group with '$AGENT_USER')"
}

# Adds the agent user to a deny list (one name per line), creating the file if needed.
deny_listed() {
  local file="$1" user="${2:-$AGENT_USER}"
  if [ -f "$file" ] && grep -qx "$user" "$file"; then return 0; fi
  [ ! -L "$file" ] || die "$file is a symbolic link; refusing to use it."
  [ -e "$file" ] || install -o root -g root -m 0644 /dev/null "$file"
  printf '%s\n' "$user" >>"$file"
  changed "'$user' in $file"
}

step_logins() {
  agent_exists || die "the agent user does not exist yet; run the user step first."
  # Nothing of the agent user may run outside its user manager, which is bound to the firewall.
  preview_exists || die "the Preview user does not exist yet; run the preview-user step first."
  local user
  for user in "$AGENT_USER" "$PREVIEW_USER"; do
    deny_listed /etc/cron.deny "$user"
    deny_listed /etc/at.deny "$user"
  done
  local file
  for file in /etc/cron.allow /etc/at.allow; do
    for user in "$AGENT_USER" "$PREVIEW_USER"; do
      if [ -f "$file" ] && grep -qx "$user" "$file"; then
        die "$file allows the user '$user'; remove it from there and run the script again."
      fi
    done
  done
  if [ -x /usr/sbin/sshd ]; then
    install -d -m 0755 /etc/ssh/sshd_config.d
    local ssh_changed=0
    install_content /etc/ssh/sshd_config.d/60-agentic-studio.conf 644 <<EOF && ssh_changed=1
# Installed by deploy/setup-server.sh: the agent and Preview users never log in over SSH.
DenyUsers $AGENT_USER $PREVIEW_USER
EOF
    # sshd -t needs its privilege separation directory, which exists only while sshd runs when
    # it is socket-activated (Ubuntu 24.04).
    [ -d /run/sshd ] || install -d -m 0755 /run/sshd
    /usr/sbin/sshd -t || die "sshd rejects its configuration (/etc/ssh/sshd_config.d/60-agentic-studio.conf)."
    if [ "$ssh_changed" = 1 ] && has_systemd && systemctl is-active --quiet ssh.service; then
      systemctl reload ssh.service
    fi
  else
    step_log "no sshd installed (no SSH login to deny)"
  fi
  install -d -m 0755 /etc/systemd/logind.conf.d
  if install_content /etc/systemd/logind.conf.d/60-agentic-studio.conf 644 <<EOF; then
# Installed by deploy/setup-server.sh: when a session of the agent or Preview user ends (for
# example the operator's sudo -iu), its processes are killed; only its user manager keeps running.
[Login]
KillUserProcesses=yes
KillOnlyUsers=$AGENT_USER $PREVIEW_USER
EOF
    if has_systemd; then systemctl kill --signal=HUP systemd-logind.service; fi
  fi
  step_log "ok (no cron, at or SSH for '$AGENT_USER'; its session processes end at logout)"
}

step_layout() {
  agent_exists || die "the agent user does not exist yet; run the user step first."
  ensure_root_dir "$STUDIO_CONFIG_DIR" 700
  ensure_root_dir "$STUDIO_STATE_DIR" 700
  # The API container (uid STUDIO_CONTAINER_UID) writes Studio's data directory; the reverse
  # proxy (the same uid) its certificates and ACME account.
  local data owner="$STUDIO_CONTAINER_UID:$STUDIO_CONTAINER_UID"
  for data in "$STUDIO_STATE_DIR/data" "$STUDIO_STATE_DIR/proxy"; do
    [ ! -L "$data" ] || die "$data is a symbolic link; refusing to use it."
    if ! [ -d "$data" ] || [ "$(stat -c '%u:%g %a' "$data")" != "$owner 700" ]; then
      install -d -o "$STUDIO_CONTAINER_UID" -g "$STUDIO_CONTAINER_UID" -m 0700 "$data"
      changed "$data ($owner 700)"
    fi
  done
  ensure_root_dir "$STUDIO_COMPOSE_DIR" 700

  local env="$STUDIO_CONFIG_DIR/.env"
  [ ! -L "$env" ] || die "$env is a symbolic link; refusing to use it."
  if [ ! -e "$env" ]; then
    install -o root -g root -m 0600 "$SCRIPT_DIR/studio.env.example" "$env"
    changed "$env from deploy/studio.env.example (no values: fill it in)"
  elif [ "$(stat -c '%U:%G %a' "$env")" != "root:root 600" ]; then
    chown root:root "$env" && chmod 0600 "$env"
    changed "$env is root:root 600"
  fi
  install_content "$STUDIO_COMPOSE_DIR/compose.yaml" 600 <"$SCRIPT_DIR/compose.server.yaml" || true
  install_content "$STUDIO_COMPOSE_DIR/compose.app.yaml" 600 <"$SCRIPT_DIR/compose.server.app.yaml" || true
  # Readable by the proxy container's uid (bind-mounted); the directory keeps it from everyone else.
  install_content "$STUDIO_COMPOSE_DIR/Caddyfile" 644 <"$SCRIPT_DIR/Caddyfile" || true
  install_content "$STUDIO_COMPOSE_DIR/Caddyfile.preview" 644 <"$SCRIPT_DIR/Caddyfile.preview" || true
  install_content "$STUDIO_COMPOSE_DIR/compose.preview.yaml" 600 <"$SCRIPT_DIR/compose.server.preview.yaml" || true
  install_content /usr/local/sbin/agentic-studio-compose 700 <<EOF || true
#!/usr/bin/env bash
# Studio's Compose stack (installed by deploy/setup-server.sh). Root only. Adds the web and API
# file once STUDIO_API_IMAGE and STUDIO_WEB_IMAGE are set in $env, and the Preview site once
# STUDIO_PREVIEW_DOMAIN is set as well.
set -euo pipefail
files=(-f "$STUDIO_COMPOSE_DIR/compose.yaml")
if grep -Eq '^STUDIO_API_IMAGE=.+' "$env" && grep -Eq '^STUDIO_WEB_IMAGE=.+' "$env"; then
  files+=(-f "$STUDIO_COMPOSE_DIR/compose.app.yaml")
  if grep -Eq '^STUDIO_PREVIEW_DOMAIN=.+' "$env"; then
    files+=(-f "$STUDIO_COMPOSE_DIR/compose.preview.yaml")
  fi
fi
export STUDIO_ENV_FILE="$env" STUDIO_DATA_HOST_DIR="$STUDIO_STATE_DIR/data" STUDIO_PROXY_HOST_DIR="$STUDIO_STATE_DIR/proxy" STUDIO_CONTAINER_UID="$STUDIO_CONTAINER_UID"
exec docker compose --project-directory "$STUDIO_COMPOSE_DIR" --env-file "$env" "\${files[@]}" "\$@"
EOF
  install_content /usr/local/bin/agentic-studio-check-boundary 755 <"$SCRIPT_DIR/check-boundary.sh" || true
  install_content /usr/local/bin/agentic-studio-check-preview 755 <"$SCRIPT_DIR/check-preview.sh" || true

  # The agent side, written as the agent user.
  local home worker_env
  home="$(agent_home)"
  worker_env="$home/.config/agentic-studio-worker/.env"
  as_agent mkdir -p "$home/.config" "$home/.local/share"
  if ! as_agent test -d "$home/.config/agentic-studio-worker" ||
    ! as_agent test -d "$home/.local/share/agentic-studio-worker"; then
    as_agent install -d -m 0700 "$home/.config/agentic-studio-worker" "$home/.local/share/agentic-studio-worker"
    changed "agent side directories ~/.config/agentic-studio-worker and ~/.local/share/agentic-studio-worker"
  fi
  as_agent chmod 0700 "$home/.config/agentic-studio-worker" "$home/.local/share/agentic-studio-worker"
  if ! as_agent test -e "$worker_env"; then
    sed -e "s|^STUDIO_WORKER_DATA_DIR=.*|STUDIO_WORKER_DATA_DIR=$home/.local/share/agentic-studio-worker|" \
      -e "s|^STUDIO_API_URL=.*|STUDIO_API_URL=http://$STUDIO_PROXY_ADDRESS:$STUDIO_PROXY_WORKER_PORT|" \
      "$REPO_DIR/apps/agent-worker/.env.example" |
      as_agent sh -c 'umask 077 && cat > "$1"' sh "$worker_env"
    changed "$worker_env from apps/agent-worker/.env.example (no token: fill it in)"
  fi
  if [ "$(as_agent stat -c '%a' "$worker_env")" != 600 ]; then
    as_agent chmod 0600 "$worker_env"
    changed "$worker_env is 0600"
  fi

  # The Preview side, written as the Preview user.
  preview_exists || die "the Preview user does not exist yet; run the preview-user step first."
  local phome controller_env
  phome="$(preview_home)"
  controller_env="$phome/.config/agentic-studio-controller/.env"
  as_preview mkdir -p "$phome/.config" "$phome/.local/share"
  if ! as_preview test -d "$phome/.config/agentic-studio-controller" ||
    ! as_preview test -d "$phome/.local/share/agentic-studio-controller"; then
    as_preview install -d -m 0700 "$phome/.config/agentic-studio-controller" "$phome/.local/share/agentic-studio-controller"
    changed "Preview side directories ~/.config/agentic-studio-controller and ~/.local/share/agentic-studio-controller"
  fi
  as_preview chmod 0700 "$phome/.config/agentic-studio-controller" "$phome/.local/share/agentic-studio-controller"
  if ! as_preview test -e "$controller_env"; then
    sed -e "s|^STUDIO_CONTROLLER_DATA_DIR=.*|STUDIO_CONTROLLER_DATA_DIR=$phome/.local/share/agentic-studio-controller|" \
      -e "s|^STUDIO_API_URL=.*|STUDIO_API_URL=http://$STUDIO_PROXY_ADDRESS:$STUDIO_PROXY_WORKER_PORT|" \
      -e "s|^STUDIO_CONTROLLER_PROXY_GID=.*|STUDIO_CONTROLLER_PROXY_GID=$PREVIEW_PROXY_GID|" \
      "$REPO_DIR/apps/environment-controller/.env.example" |
      as_preview sh -c 'umask 077 && cat > "$1"' sh "$controller_env"
    changed "$controller_env from apps/environment-controller/.env.example (no token: fill it in)"
  fi
  if [ "$(as_preview stat -c '%a' "$controller_env")" != 600 ]; then
    as_preview chmod 0600 "$controller_env"
    changed "$controller_env is 0600"
  fi
  step_log "ok"
}

# Builds one app's code from this checkout's HEAD into a root-owned directory.
#   build_code <label> <dir> <package> <main.js relative to dir> <workspace package to build>...
build_code() {
  local label="$1" dir="$2" package="$3" main="$4" built
  shift 4
  command -v git >/dev/null || die "git is missing; run the packages step first."
  [ -x /usr/local/bin/pnpm ] || die "pnpm is missing; run the node step first."
  local commit
  commit="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)" ||
    die "$REPO_DIR is not a Git checkout; run the script from a clone of the repository."
  if [ -f "$dir/.source-commit" ] && [ "$(cat "$dir/.source-commit")" = "$commit" ] &&
    [ -f "$dir/$main" ]; then
    step_log "unchanged ($label at ${commit:0:12})"
    return 0
  fi
  local staging="$dir.new"
  rm -rf "$staging"
  install -d -o root -g root -m 0755 "$staging"
  git -C "$REPO_DIR" archive --format=tar HEAD | tar -x -C "$staging" --no-same-owner
  # Dependency install scripts never run as root (--ignore-scripts); the apps need none.
  (
    cd "$staging"
    export PATH="/usr/local/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
    # Copies, not hard links into root's pnpm store, so the code stands on its own.
    /usr/local/bin/pnpm install --frozen-lockfile --ignore-scripts --package-import-method copy \
      --filter "$package..."
    for built in "$@"; do
      /usr/local/bin/pnpm --filter "@agentic-studio/$built" run build
    done
  )
  printf '%s\n' "$commit" >"$staging/.source-commit"
  chown -R root:root "$staging"
  chmod -R u+rwX,go+rX,go-w "$staging"
  if [ -d "$dir" ]; then
    rm -rf "$dir.old"
    mv "$dir" "$dir.old"
  fi
  mv "$staging" "$dir"
  rm -rf "$dir.old"
  changed "$label ${commit:0:12} built in $dir"
}

step_worker() {
  build_code "agent worker" "$WORKER_CODE_DIR" '@agentic-studio/agent-worker' apps/agent-worker/dist/main.js \
    contracts agent-worker
}

step_controller() {
  build_code "environment controller" "$CONTROLLER_CODE_DIR" '@agentic-studio/environment-controller' \
    apps/environment-controller/dist/main.js contracts compose-validation environment-controller
}

# Directories the guardrails step creates stop below these existing system directories.
SYSTEM_DIRS=" / /etc /usr /usr/local /usr/local/lib "

step_guardrails() {
  # The worker's own copies: the agent worker compares the installed files with exactly these.
  local dir="$WORKER_CODE_DIR/apps/agent-worker/guardrails"
  local manifest="$dir/managed-files.txt"
  [ -f "$manifest" ] || die "$manifest is missing; run the worker step first."
  local provider source dest rest count=0 parent dirs
  while read -r provider source dest rest; do
    case "$provider" in '' | '#'*) continue ;; esac
    if [ -n "$rest" ] || ! [[ "$source" =~ ^[A-Za-z0-9._-]+$ ]] || [[ "$dest" != /* ]] || [[ "$dest" == *..* ]]; then
      die "malformed line in $manifest: $provider $source $dest $rest"
    fi
    if [ "$source" = absent ]; then
      # A managed input the CLI would merge into Studio's policy (review L1 of #136). Not Studio's:
      # the operator removes it after looking at it.
      if [ -e "$dest" ] || [ -L "$dest" ]; then
        die "$dest exists: the provider CLI would merge it into Studio's managed guardrails. Review and remove it, then run the step again."
      fi
      continue
    fi
    if [ ! -f "$dir/$source" ] || [ -L "$dir/$source" ]; then die "$dir/$source is missing."; fi
    # Every directory from the first one below a system directory down to the file's own.
    dirs=()
    parent="$(dirname "$dest")"
    while [[ "$SYSTEM_DIRS" != *" $parent "* ]]; do
      dirs=("$parent" "${dirs[@]}")
      parent="$(dirname "$parent")"
    done
    for parent in "${dirs[@]}"; do ensure_root_dir "$parent" 755; done
    [ ! -L "$dest" ] || rm -f "$dest"
    install_content "$dest" 644 <"$dir/$source" || true
    count=$((count + 1))
  done <"$manifest"
  [ "$count" -gt 0 ] || die "$manifest lists no file."
  step_log "ok ($count managed-files.txt entries in place, root:root 0644; run by /usr/bin/env -i and /usr/local/bin/node)"
}

# The firewall for one user: <role> (agent or preview), <label> for texts, the user's uid, the
# iptables chain.
install_user_firewall() {
  local role="$1" label="$2" uid="$3" chain="$4"
  local script="/usr/local/sbin/agentic-studio-$role-firewall" unit="agentic-studio-$role-firewall"
  [[ "$STUDIO_PROXY_ADDRESS" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "STUDIO_PROXY_ADDRESS must be an IPv4 address."
  [[ "$STUDIO_PROXY_WORKER_PORT" =~ ^[0-9]{1,5}$ ]] || die "STUDIO_PROXY_WORKER_PORT must be a port number."
  install_content "$script" 755 <<EOF || true
#!/usr/bin/env bash
# Keeps the $label (uid $uid) away from Studio's container network $STUDIO_NETWORK_SUBNET:
# only the reverse proxy's worker port ($STUDIO_PROXY_ADDRESS:$STUDIO_PROXY_WORKER_PORT) is allowed
# there; the API, PostgreSQL, Redis and anything else are rejected. Installed by deploy/setup-server.sh; run by $unit.service
# (apply, which fails unless the rules are verified in place) and its verify timer.
set -euo pipefail
verify() {
  iptables -w -C OUTPUT -m owner --uid-owner $uid -j $chain &&
    iptables -w -C $chain -d $STUDIO_PROXY_ADDRESS/32 -p tcp --dport $STUDIO_PROXY_WORKER_PORT -j RETURN &&
    iptables -w -C $chain -d $STUDIO_NETWORK_SUBNET -p tcp -j REJECT --reject-with tcp-reset &&
    iptables -w -C $chain -d $STUDIO_NETWORK_SUBNET -j REJECT
}
case "\${1:-apply}" in
  apply)
    # The chain is replaced atomically, so a re-apply never leaves it empty.
    iptables-restore -w --noflush <<RULES
*filter
:$chain - [0:0]
-A $chain -d $STUDIO_PROXY_ADDRESS/32 -p tcp --dport $STUDIO_PROXY_WORKER_PORT -j RETURN
-A $chain -d $STUDIO_NETWORK_SUBNET -p tcp -j REJECT --reject-with tcp-reset
-A $chain -d $STUDIO_NETWORK_SUBNET -j REJECT
COMMIT
RULES
    iptables -w -C OUTPUT -m owner --uid-owner $uid -j $chain 2>/dev/null ||
      iptables -w -I OUTPUT 1 -m owner --uid-owner $uid -j $chain
    verify || { echo "$role firewall rules are not in place" >&2; exit 1; }
    ;;
  verify)
    verify 2>/dev/null || { echo "$role firewall rules are missing" >&2; exit 1; }
    ;;
  remove)
    while iptables -w -D OUTPUT -m owner --uid-owner $uid -j $chain 2>/dev/null; do :; done
    iptables -w -F $chain 2>/dev/null || true
    iptables -w -X $chain 2>/dev/null || true
    ;;
  *) echo "usage: \$0 apply|verify|remove" >&2; exit 2 ;;
esac
EOF
  local reload=0
  install_content "/etc/systemd/system/$unit.service" 644 <<EOF && reload=1
[Unit]
Description=Keep the $label away from Studio's container network
Documentation=file://$WORKER_CODE_DIR/docs/engineering/deployment.md
After=network-pre.target
# Before any user manager (the $label's lingering one included) starts; that manager
# requires and is bound to this unit (user@$uid.service.d/60-agentic-studio-firewall.conf).
Before=systemd-user-sessions.service network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$script apply
ExecStop=$script remove

[Install]
WantedBy=multi-user.target
EOF
  # Rules flushed later by another tool: the timer stops the firewall unit, which stops the
  # agent side with it (fail closed). Starting user@<uid>.service or re-running the setup
  # restores both.
  install_content "/etc/systemd/system/$unit-verify.service" 644 <<EOF && reload=1
[Unit]
Description=Stop the $role side when its firewall rules are missing
After=$unit.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c '$script verify || systemctl stop $unit.service'
EOF
  install_content "/etc/systemd/system/$unit-verify.timer" 644 <<EOF && reload=1
[Unit]
Description=Check the $role firewall rules every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
  # The user's manager (its services, rootless Docker and the worker or controller) never runs without
  # the firewall: starting it starts the firewall first, and stopping or failing the firewall
  # stops it.
  install -d -m 0755 "/etc/systemd/system/user@$uid.service.d"
  install_content "/etc/systemd/system/user@$uid.service.d/60-agentic-studio-firewall.conf" 644 <<EOF && reload=1
# Installed by deploy/setup-server.sh: the $role side runs only with its firewall.
[Unit]
Requires=$unit.service
BindsTo=$unit.service
After=$unit.service
EOF
  [ "$reload" = 0 ] || systemctl daemon-reload
  systemctl enable --quiet "$unit.service" "$unit-verify.timer"
  # Re-applying is idempotent (atomic) and picks up a changed rule set.
  if systemctl is-active --quiet "$unit.service"; then
    "$script" apply
  else
    systemctl start "$unit.service"
  fi
  systemctl start "$unit-verify.timer"
  step_log "ok ($role user -> $STUDIO_NETWORK_SUBNET rejected except $STUDIO_PROXY_ADDRESS:$STUDIO_PROXY_WORKER_PORT; the $role side is bound to it)"
}

step_firewall() { install_user_firewall agent "agent user" "$(agent_uid)" "$FIREWALL_CHAIN"; }

step_preview_firewall() {
  preview_exists || die "the Preview user does not exist yet; run the preview-user step first."
  install_user_firewall preview "Preview user" "$(preview_uid)" "$PREVIEW_FIREWALL_CHAIN"
}

# Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor; rootlesskit needs a
# profile that allows them (Docker's rootless documentation).
ensure_rootlesskit_apparmor() {
  # Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor; rootlesskit needs a
  # profile that allows them (Docker's rootless documentation).
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] &&
    ! grep -rlqs '/usr/bin/rootlesskit' /etc/apparmor.d --include='*rootlesskit*'; then
    install_content /etc/apparmor.d/usr.bin.rootlesskit 644 <<'EOF' || true
# Installed by deploy/setup-server.sh: lets rootlesskit (rootless Docker) create user namespaces.
abi <abi/4.0>,
include <tunables/global>

/usr/bin/rootlesskit flags=(unconfined) {
  userns,

  include if exists <local/usr.bin.rootlesskit>
}
EOF
    apparmor_parser -r /etc/apparmor.d/usr.bin.rootlesskit
  fi
}

step_rootless() {
  [ -x /usr/bin/dockerd-rootless-setuptool.sh ] || die "docker-ce-rootless-extras is missing; run the packages step first."
  ensure_rootlesskit_apparmor
  if [ "$(loginctl show-user "$AGENT_USER" -p Linger --value 2>/dev/null)" != yes ]; then
    loginctl enable-linger "$AGENT_USER"
    changed "linger for '$AGENT_USER' (its user services run without a login session)"
  fi
  wait_for_user_bus
  if as_agent systemctl --user is-active --quiet docker.service; then
    step_log "unchanged (rootless Docker running for '$AGENT_USER')"
  else
    if ! as_agent dockerd-rootless-setuptool.sh install; then
      journalctl _SYSTEMD_USER_UNIT=docker.service _UID="$(agent_uid)" -n 40 --no-pager >&2 || true
      die "rootless Docker did not start for '$AGENT_USER' (its log is above)."
    fi
    as_agent systemctl --user enable --now docker.service
    changed "rootless Docker for '$AGENT_USER' as its systemd user service"
  fi
}

# Limits for everything one user runs: its user slice.
apply_user_limits() {
  local user="$1" memory="$2" tasks="$3" cpu="$4" uid reload=0
  uid="$(id -u "$user")"
  install -d -m 0755 "/etc/systemd/system/user-$uid.slice.d"
  install_content "/etc/systemd/system/user-$uid.slice.d/50-agentic-studio.conf" 644 <<EOF && reload=1
# Installed by deploy/setup-server.sh: limits for everything the user '$user' runs.
[Slice]
MemoryMax=$memory
TasksMax=$tasks
CPUWeight=$cpu
EOF
  if [ "$reload" = 1 ]; then
    systemctl daemon-reload
    # Applies the limits to the running slice now as well (the drop-in keeps them across boots).
    if systemctl is-active --quiet "user-$uid.slice"; then
      systemctl set-property --runtime "user-$uid.slice" "MemoryMax=$memory" \
        "TasksMax=$tasks" "CPUWeight=$cpu"
    fi
  fi
}

step_limits() {
  local delegate=0 user
  preview_exists || die "the Preview user does not exist yet; run the preview-user step first."
  install -d -m 0755 /etc/systemd/system/user@.service.d
  apply_user_limits "$AGENT_USER" "$AGENT_MEMORY_MAX" "$AGENT_TASKS_MAX" "$AGENT_CPU_WEIGHT"
  apply_user_limits "$PREVIEW_USER" "$PREVIEW_MEMORY_MAX" "$PREVIEW_TASKS_MAX" "$PREVIEW_CPU_WEIGHT"
  # Lets user managers hand cgroup controllers to rootless Docker, so container limits apply.
  install_content /etc/systemd/system/user@.service.d/50-agentic-studio-delegate.conf 644 <<'EOF' && delegate=1
# Installed by deploy/setup-server.sh (rootless Docker resource limits).
[Service]
Delegate=cpu cpuset io memory pids
EOF
  if [ "$delegate" = 1 ]; then
    systemctl daemon-reload
  fi
  # A running user manager takes new delegation only when it restarts (stops the user's
  # services, rootless Docker and the worker or controller included; they start again with it).
  if [ "$delegate" = 1 ]; then
    for user in "$AGENT_USER" "$PREVIEW_USER"; do
      if systemctl is-active --quiet "user@$(id -u "$user").service"; then
        systemctl restart "user@$(id -u "$user").service"
        step_log "restarted user@$(id -u "$user").service for the new cgroup delegation"
      fi
    done
  fi
  if [ -z "$AGENT_DISK_QUOTA_GB" ]; then
    step_log "no disk quota (AGENT_DISK_QUOTA_GB is empty)"
  else
    [[ "$AGENT_DISK_QUOTA_GB" =~ ^[0-9]+$ ]] || die "AGENT_DISK_QUOTA_GB must be a whole number of GiB."
    local mount blocks current
    mount="$(df --output=target "$(agent_home)" | tail -n 1)"
    if quotaon -pu "$mount" 2>/dev/null | grep -q 'is on'; then
      blocks=$((AGENT_DISK_QUOTA_GB * 1024 * 1024))
      current="$(quota -u -w "$AGENT_USER" 2>/dev/null | awk 'NR > 2 { print $4; exit }')"
      if [ "$current" != "$blocks" ]; then
        setquota -u "$AGENT_USER" "$blocks" "$blocks" 0 0 "$mount"
        changed "disk quota ${AGENT_DISK_QUOTA_GB} GiB for '$AGENT_USER' on $mount"
      fi
    else
      step_log "WARNING: user quotas are not switched on for $mount; no disk quota set (deployment.md, \"Disk quota\")."
    fi
  fi
  step_log "ok"
}

# The resolver the Previews' containers may reach: PREVIEW_DNS, else the first non-loopback IPv4
# nameserver of systemd-resolved's file, else of /etc/resolv.conf.
preview_dns() {
  if [ -n "$PREVIEW_DNS" ]; then
    printf '%s' "$PREVIEW_DNS"
    return 0
  fi
  local file ns
  for file in /run/systemd/resolve/resolv.conf /etc/resolv.conf; do
    [ -r "$file" ] || continue
    ns="$(awk '$1 == "nameserver" && $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $2 !~ /^127\./ { print $2; exit }' "$file")"
    if [ -n "$ns" ]; then
      printf '%s' "$ns"
      return 0
    fi
  done
  die "no non-loopback IPv4 nameserver in /run/systemd/resolve/resolv.conf or /etc/resolv.conf; set PREVIEW_DNS."
}

# Runs the egress rules script's verify inside the Preview daemon's network namespace, as the
# Preview user, the way the controller does.
preview_egress_verify() {
  local uid pid
  uid="$(preview_uid)"
  pid="$(cat "/run/user/$uid/dockerd-rootless/child_pid" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  as_preview nsenter -U --preserve-credentials -n -t "$pid" "$PREVIEW_EGRESS_SCRIPT" verify
}

step_preview_rootless() {
  [ -x /usr/bin/dockerd-rootless-setuptool.sh ] || die "docker-ce-rootless-extras is missing; run the packages step first."
  preview_exists || die "the Preview user does not exist yet; run the preview-user step first."
  ensure_rootlesskit_apparmor
  local dns home uid restart=0 unit_dir daemon_json dropin want have
  dns="$(preview_dns)" || exit 1
  home="$(preview_home)"
  uid="$(preview_uid)"
  if [ "$(loginctl show-user "$PREVIEW_USER" -p Linger --value 2>/dev/null)" != yes ]; then
    loginctl enable-linger "$PREVIEW_USER"
    changed "linger for '$PREVIEW_USER' (its user services run without a login session)"
  fi
  wait_for_user_bus "$PREVIEW_USER"

  # The egress rules script is root-owned: the controller refuses it otherwise, and the Preview
  # user cannot change what its own containers are held to.
  ensure_root_dir /usr/local/lib/agentic-studio 755
  install_template "$PREVIEW_EGRESS_SCRIPT" 755 "$SCRIPT_DIR/preview-egress-rules.sh" "s|@PREVIEW_DNS@|$dns|g" || true

  unit_dir="$home/.config/systemd/user/docker.service.d"
  daemon_json="$home/.config/docker/daemon.json"
  dropin="$unit_dir/60-agentic-studio-egress.conf"
  as_preview mkdir -p "$home/.config/docker" "$unit_dir"
  want="{\"dns\":[\"$dns\"]}"
  have="$(as_preview cat "$daemon_json" 2>/dev/null || true)"
  if [ "$have" != "$want" ]; then
    printf '%s\n' "$want" | as_preview sh -c 'umask 022 && cat > "$1"' sh "$daemon_json"
    changed "$daemon_json (the resolver the egress rules allow)"
    restart=1
  fi
  want="# Installed by deploy/setup-server.sh: the egress rules are applied in the daemon's network
# namespace at every start, and the daemon does not start without them. The controller bounds
# the Preview user's app.slice per build, and the kernel may pick the daemon instead of the build:
# the daemon must then not stay stopped (Restart=always stays; OOMPolicy=continue keeps the
# daemon's other processes). The controller requires the daemon and is stopped with it, and an
# automatic restart of the daemon does not bring it back, so every start of the daemon also
# starts the controller (no-op when it runs; its ExecCondition holds it back without a token).
[Service]
ExecStartPost=$PREVIEW_EGRESS_SCRIPT apply
ExecStartPost=-/usr/bin/systemctl --user --no-block start agentic-studio-controller.service
OOMPolicy=continue"
  have="$(as_preview cat "$dropin" 2>/dev/null || true)"
  if [ "$have" != "$want" ]; then
    printf '%s\n' "$want" | as_preview sh -c 'umask 022 && cat > "$1"' sh "$dropin"
    changed "$dropin"
    restart=1
  fi
  as_preview systemctl --user daemon-reload

  if as_preview systemctl --user is-active --quiet docker.service; then
    if [ "$restart" = 1 ]; then
      as_preview systemctl --user restart docker.service
      step_log "restarted the Preview user's rootless Docker with the new settings"
    else
      step_log "unchanged (rootless Docker running for '$PREVIEW_USER')"
    fi
  else
    if ! as_preview dockerd-rootless-setuptool.sh install; then
      journalctl _SYSTEMD_USER_UNIT=docker.service _UID="$uid" -n 40 --no-pager >&2 || true
      die "rootless Docker did not start for '$PREVIEW_USER' (its log is above)."
    fi
    as_preview systemctl --user enable --now docker.service
    changed "rootless Docker for '$PREVIEW_USER' as its systemd user service"
  fi
  # The rules are re-applied every run (atomic, same rules), then read back as the controller does.
  as_preview "$PREVIEW_EGRESS_SCRIPT" apply
  preview_egress_verify || die "the Preview egress rules are not in place after applying them."
  step_log "ok (egress rules in place in the Preview daemon's network namespace)"
}

step_preview_proxy_dir() {
  preview_exists || die "the Preview user does not exist yet; run the preview-user step first."
  getent group "$PREVIEW_PROXY_GROUP" >/dev/null || die "the group '$PREVIEW_PROXY_GROUP' does not exist; run the preview-user step first."
  install -d -m 0755 /etc/tmpfiles.d
  install_content /etc/tmpfiles.d/agentic-studio-preview-proxy.conf 644 <<EOF || true
# Installed by deploy/setup-server.sh: the directory of the Preview sockets, created at every boot
# (before any user manager starts). Setgid, so a socket the Preview user creates in it belongs to
# the proxy group without the Preview user being a member of that group.
d $PREVIEW_PROXY_DIR 2750 $PREVIEW_USER $PREVIEW_PROXY_GROUP -
EOF
  local before
  before="$(stat -c '%U:%G %a' "$PREVIEW_PROXY_DIR" 2>/dev/null || echo none)"
  systemd-tmpfiles --create /etc/tmpfiles.d/agentic-studio-preview-proxy.conf
  [ "$(stat -c '%U:%G %a' "$PREVIEW_PROXY_DIR")" = "$PREVIEW_USER:$PREVIEW_PROXY_GROUP 2750" ] ||
    die "$PREVIEW_PROXY_DIR is not $PREVIEW_USER:$PREVIEW_PROXY_GROUP 2750 after systemd-tmpfiles."
  [ "$before" = "$PREVIEW_USER:$PREVIEW_PROXY_GROUP 2750" ] || changed "$PREVIEW_PROXY_DIR ($PREVIEW_USER:$PREVIEW_PROXY_GROUP 2750)"
  step_log "ok"
}

step_service() {
  local unit=/etc/systemd/user/agentic-studio-worker.service home
  install -d -m 0755 /etc/systemd/user
  install_template "$unit" 644 "$SCRIPT_DIR/systemd/agentic-studio-worker.service" \
    "s|@WORKER_CODE_DIR@|$WORKER_CODE_DIR|g" "s|@NODE_BIN@|/usr/local/bin/node|g" || true
  wait_for_user_bus
  as_agent systemctl --user daemon-reload
  if ! as_agent systemctl --user is-enabled --quiet agentic-studio-worker.service; then
    as_agent systemctl --user enable agentic-studio-worker.service
    changed "enabled agentic-studio-worker.service for '$AGENT_USER'"
  fi
  home="$(agent_home)"
  if as_agent grep -Eq '^STUDIO_WORKER_TOKEN=.{32,}' "$home/.config/agentic-studio-worker/.env"; then
    as_agent systemctl --user restart agentic-studio-worker.service
    step_log "ok (agent worker restarted)"
  else
    step_log "ok (agent worker enabled, not started: its STUDIO_WORKER_TOKEN is empty)"
  fi
}

step_controller_service() {
  local unit=/etc/systemd/user/agentic-studio-controller.service home
  preview_exists || die "the Preview user does not exist yet; run the preview-user step first."
  install -d -m 0755 /etc/systemd/user
  install_template "$unit" 644 "$SCRIPT_DIR/systemd/agentic-studio-controller.service" \
    "s|@CONTROLLER_CODE_DIR@|$CONTROLLER_CODE_DIR|g" "s|@NODE_BIN@|/usr/local/bin/node|g" \
    "s|@PREVIEW_USER@|$PREVIEW_USER|g" || true
  wait_for_user_bus "$PREVIEW_USER"
  as_preview systemctl --user daemon-reload
  if ! as_preview systemctl --user is-enabled --quiet agentic-studio-controller.service; then
    as_preview systemctl --user enable agentic-studio-controller.service
    changed "enabled agentic-studio-controller.service for '$PREVIEW_USER'"
  fi
  home="$(preview_home)"
  if as_preview grep -Eq '^STUDIO_CONTROLLER_TOKEN=.{32,}' "$home/.config/agentic-studio-controller/.env"; then
    as_preview systemctl --user restart agentic-studio-controller.service
    step_log "ok (environment controller restarted)"
  else
    step_log "ok (environment controller enabled, not started: its STUDIO_CONTROLLER_TOKEN is empty)"
  fi
}

next_steps() {
  local home phome
  home="$(agent_home 2>/dev/null || echo "~$AGENT_USER")"
  phome="$(preview_home 2>/dev/null || echo "~$PREVIEW_USER")"
  cat <<EOF

Done: $CHANGES change(s).

The script wrote no secret. Remaining manual steps (docs/engineering/deployment.md, "Manual steps"):
  1. As root, fill in $STUDIO_CONFIG_DIR/.env (root, 0600):
       POSTGRES_PASSWORD and DATABASE_URL (database), REDIS_PASSWORD and REDIS_URL (Redis),
       STUDIO_OPERATOR_PASSWORD_HASH (operator
       password hash), STUDIO_SECRETS_KEY (secret store master key; back it up off the server),
       STUDIO_WORKER_TOKEN (worker token); STUDIO_API_IMAGE and STUDIO_WEB_IMAGE (the production
       images), STUDIO_DOMAIN and STUDIO_TLS (the reverse proxy).
  2. As the agent user, fill in $home/.config/agentic-studio-worker/.env (0600):
       STUDIO_WORKER_TOKEN (the same worker token), STUDIO_AGENT_GIT_NAME and STUDIO_AGENT_GIT_EMAIL,
       STUDIO_AGENT_GITHUB_TOKEN (the Agent account's token, limited to the managed repositories).
       Leave CLAUDE_CODE_ENABLED and CODEX_CLI_ENABLED false until the operator enables a provider.
  3. As the agent user: install each provider CLI with its official installer and log it in
     interactively (subscription login); configure the agent user's Git credentials.
  4. As root: start Studio's stack (migrations run first): agentic-studio-compose up -d --wait
     then the worker (as the agent user, e.g. sudo -iu $AGENT_USER with XDG_RUNTIME_DIR=/run/user/<uid>):
       systemctl --user restart agentic-studio-worker
  5. As the agent user: agentic-studio-check-boundary   (must end with RESULT: PASS)
  Previews (docs/engineering/deployment.md, "Previews: the Preview user and the controller"):
  6. As root, put a new token (openssl rand -base64 32, never the worker token) into
     $STUDIO_CONFIG_DIR/.env as STUDIO_CONTROLLER_TOKEN, and the same value into
     $phome/.config/agentic-studio-controller/.env (Preview user, 0600) as STUDIO_CONTROLLER_TOKEN.
     Then: agentic-studio-compose up -d --wait, and run this script again with --only controller-service
     (the controller starts only once its token is set).
  7. As the Preview user (sudo -iu $PREVIEW_USER): agentic-studio-check-preview   (must end with RESULT: PASS)
EOF
}

main() {
  local only=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --only)
        [ $# -ge 2 ] || die "--only needs a step list."
        only="$2"
        shift 2
        ;;
      --only=*)
        only="${1#--only=}"
        shift
        ;;
      --list)
        list_steps
        exit 0
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "unknown argument '$1' (see --help)." ;;
    esac
  done
  local selected=("${STEPS[@]}") step
  if [ -n "$only" ]; then
    IFS=',' read -r -a selected <<<"$only"
    for step in "${selected[@]}"; do
      [[ " ${STEPS[*]} " == *" $step "* ]] || die "unknown step '$step' (steps: ${STEPS[*]})."
    done
  fi
  # The refusal checks always run first, whatever the selection.
  CURRENT_STEP=preflight
  step_preflight
  for step in "${STEPS[@]}"; do
    [ "$step" != preflight ] || continue
    [[ " ${selected[*]} " == *" $step "* ]] || continue
    if [[ " ${SYSTEMD_STEPS[*]} " == *" $step "* ]]; then
      has_systemd || die "step '$step' needs systemd as PID 1."
      [ -f /sys/fs/cgroup/cgroup.controllers ] || die "step '$step' needs cgroup v2 (unified hierarchy)."
    fi
    CURRENT_STEP="$step"
    "step_${step//-/_}"
  done
  CURRENT_STEP=final
  assert_agent_safe
  assert_preview_safe
  next_steps
}

main "$@"
