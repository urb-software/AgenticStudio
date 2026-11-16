#!/usr/bin/env bash
# Server setup for AI Agent Studio (Issue #107; ADR 0002; docs/engineering/deployment.md).
#
# Sets up the two sides of the isolation boundary on one Ubuntu 24.04 LTS server:
#   - Studio's side: the system Docker daemon (root only) and Studio's Compose files and
#     configuration, readable by root only.
#   - The agent side: the agent user (never in the `docker` group, no passwordless sudo), its
#     rootless Docker daemon kept running without a login session, the agent worker as its
#     systemd user service, and resource limits for the user.
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
# Disk quota on the agent user's home filesystem, in GiB; empty sets none. Applied only where
# the filesystem has user quotas switched on (reported otherwise).
AGENT_DISK_QUOTA_GB="${AGENT_DISK_QUOTA_GB:-}"
# -------------------------------------------------------------------------------------------------

STEPS=(preflight packages node user logins layout worker guardrails firewall limits rootless service)
SYSTEMD_STEPS=(firewall limits rootless service)
DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
DOCKER_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  docker-ce-rootless-extras)
BASE_PACKAGES=(ca-certificates curl gnupg git xz-utils uidmap slirp4netns dbus-user-session
  fuse-overlayfs iptables acl quota)
FIREWALL_CHAIN="AGENTIC-STUDIO-AGENT"
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
logins     The agent user gets no cron (/etc/cron.deny), no at (/etc/at.deny) and no SSH login
           (/etc/ssh/sshd_config.d/60-agentic-studio.conf, when sshd is installed); logind kills its
           session processes at logout (/etc/systemd/logind.conf.d/60-agentic-studio.conf).
layout     Root only: ${STUDIO_CONFIG_DIR} (0700, .env 0600 from deploy/studio.env.example),
           ${STUDIO_STATE_DIR} (0700; data/ and proxy/ owned by uid ${STUDIO_CONTAINER_UID}),
           ${STUDIO_COMPOSE_DIR} (0700, compose files 0600, Caddyfile 0644),
           /usr/local/sbin/agentic-studio-compose; /usr/local/bin/agentic-studio-check-boundary.
           Agent side, written as the agent user: ~/.config/agentic-studio-worker/.env (0600, from
           apps/agent-worker/.env.example) and ~/.local/share/agentic-studio-worker (0700).
worker     The agent worker's code from this checkout's HEAD into ${WORKER_CODE_DIR} (root-owned,
           world-readable, not writable by the agent user), installed and built there.
guardrails Studio's managed guardrails for Claude Code and Codex, from the worker's guardrails folder
           (${WORKER_CODE_DIR}/apps/agent-worker/guardrails, its managed-files.txt): root:root, files 0644,
           directories 0755 (/etc/claude-code/managed-settings.json, /etc/codex/managed_config.toml,
           /etc/codex/requirements.toml, /usr/local/lib/agentic-studio/guardrails/claude-guard.mjs).
firewall   /usr/local/sbin/agentic-studio-agent-firewall and agentic-studio-agent-firewall.service:
           rejects the agent user's traffic to ${STUDIO_NETWORK_SUBNET} except the reverse proxy's worker
           port (${STUDIO_PROXY_ADDRESS}:${STUDIO_PROXY_WORKER_PORT});
           a verify timer, and a drop-in binding user@<uid>.service to the firewall (fail closed).
limits     /etc/systemd/system/user-<uid>.slice.d/50-agentic-studio.conf (MemoryMax=${AGENT_MEMORY_MAX},
           TasksMax=${AGENT_TASKS_MAX}, CPUWeight=${AGENT_CPU_WEIGHT}), cgroup delegation for user managers,
           and a disk quota where available.
rootless   AppArmor profile for rootlesskit where Ubuntu restricts user namespaces, linger for the
           agent user, and its rootless Docker daemon as a systemd user service.
service    /etc/systemd/user/agentic-studio-worker.service, enabled for the agent user; started only
           once its worker token is filled in.
EOF
}

# --- Helpers --------------------------------------------------------------------------------------

has_systemd() { [ -d /run/systemd/system ] && [ "$(cat /proc/1/comm 2>/dev/null)" = systemd ]; }

agent_exists() { id -u "$AGENT_USER" >/dev/null 2>&1; }
agent_uid() { id -u "$AGENT_USER"; }
agent_home() { getent passwd "$AGENT_USER" | cut -d: -f6; }

# Runs a command as the agent user with a clean environment. Files in the agent user's home are
# only ever written this way, never by root, so a planted symlink cannot redirect a root write.
as_agent() {
  local uid home
  uid="$(agent_uid)"
  home="$(agent_home)"
  (cd / && runuser -u "$AGENT_USER" -- env -i HOME="$home" USER="$AGENT_USER" LOGNAME="$AGENT_USER" \
    SHELL=/bin/bash PATH=/usr/local/bin:/usr/bin:/bin XDG_RUNTIME_DIR="/run/user/$uid" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@")
}

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

# Installs a file from stdin when its content, owner or mode differ. Root-owned paths only.
install_content() {
  local dest="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat >"$tmp" || die "could not stage $dest."
  if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$tmp" "$dest" &&
    [ "$(stat -c '%U:%G %a' "$dest")" = "root:root $mode" ]; then
    rm -f "$tmp"
    return 1
  fi
  install -o root -g root -m "$mode" "$tmp" "$dest" || die "could not install $dest."
  rm -f "$tmp"
  changed "$dest"
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
  local uid
  uid="$(agent_uid)"
  systemctl start "user@$uid.service"
  for _ in $(seq 1 30); do
    [ -S "/run/user/$uid/bus" ] && return 0
    sleep 1
  done
  die "the agent user's systemd user manager did not start (no /run/user/$uid/bus)."
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
  # Rootless Docker needs a subordinate uid/gid range; useradd normally assigns one.
  local file start
  for file in /etc/subuid /etc/subgid; do
    [ -e "$file" ] || install -o root -g root -m 0644 /dev/null "$file"
    if ! grep -q "^$AGENT_USER:" "$file"; then
      start="$(awk -F: 'BEGIN { m = 100000 } { e = $2 + $3; if (e > m) m = e } END { print m }' "$file")"
      if [ "$file" = /etc/subuid ]; then
        usermod --add-subuids "$start-$((start + 65535))" "$AGENT_USER"
      else
        usermod --add-subgids "$start-$((start + 65535))" "$AGENT_USER"
      fi
      changed "$file range $start-$((start + 65535)) for '$AGENT_USER'"
    fi
  done
  local home mode
  home="$(agent_home)"
  [ -d "$home" ] || die "the agent user's home directory $home does not exist."
  mode="$(stat -c '%a' "$home")"
  if [ "${mode: -1}" != 0 ]; then
    chmod o-rwx "$home"
    changed "$home not accessible to other users"
  fi
  assert_agent_safe
  step_log "ok ('$AGENT_USER' is not in the docker group and has no passwordless sudo)"
}

# Adds the agent user to a deny list (one name per line), creating the file if needed.
deny_listed() {
  local file="$1"
  if [ -f "$file" ] && grep -qx "$AGENT_USER" "$file"; then return 0; fi
  [ ! -L "$file" ] || die "$file is a symbolic link; refusing to use it."
  [ -e "$file" ] || install -o root -g root -m 0644 /dev/null "$file"
  printf '%s\n' "$AGENT_USER" >>"$file"
  changed "'$AGENT_USER' in $file"
}

step_logins() {
  agent_exists || die "the agent user does not exist yet; run the user step first."
  # Nothing of the agent user may run outside its user manager, which is bound to the firewall.
  deny_listed /etc/cron.deny
  deny_listed /etc/at.deny
  local file
  for file in /etc/cron.allow /etc/at.allow; do
    if [ -f "$file" ] && grep -qx "$AGENT_USER" "$file"; then
      die "$file allows the agent user '$AGENT_USER'; remove it from there and run the script again."
    fi
  done
  if [ -x /usr/sbin/sshd ]; then
    install -d -m 0755 /etc/ssh/sshd_config.d
    local ssh_changed=0
    install_content /etc/ssh/sshd_config.d/60-agentic-studio.conf 644 <<EOF && ssh_changed=1
# Installed by deploy/setup-server.sh: the agent user never logs in over SSH.
DenyUsers $AGENT_USER
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
# Installed by deploy/setup-server.sh: when a session of the agent user ends (for example the
# operator's sudo -iu), its processes are killed; only its user manager keeps running.
[Login]
KillUserProcesses=yes
KillOnlyUsers=$AGENT_USER
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
  install_content /usr/local/sbin/agentic-studio-compose 700 <<EOF || true
#!/usr/bin/env bash
# Studio's Compose stack (installed by deploy/setup-server.sh). Root only. Adds the web and API
# file once STUDIO_API_IMAGE and STUDIO_WEB_IMAGE are set in $env.
set -euo pipefail
files=(-f "$STUDIO_COMPOSE_DIR/compose.yaml")
if grep -Eq '^STUDIO_API_IMAGE=.+' "$env" && grep -Eq '^STUDIO_WEB_IMAGE=.+' "$env"; then
  files+=(-f "$STUDIO_COMPOSE_DIR/compose.app.yaml")
fi
export STUDIO_ENV_FILE="$env" STUDIO_DATA_HOST_DIR="$STUDIO_STATE_DIR/data" STUDIO_PROXY_HOST_DIR="$STUDIO_STATE_DIR/proxy" STUDIO_CONTAINER_UID="$STUDIO_CONTAINER_UID"
exec docker compose --project-directory "$STUDIO_COMPOSE_DIR" --env-file "$env" "\${files[@]}" "\$@"
EOF
  install_content /usr/local/bin/agentic-studio-check-boundary 755 <"$SCRIPT_DIR/check-boundary.sh" || true

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
  step_log "ok"
}

step_worker() {
  command -v git >/dev/null || die "git is missing; run the packages step first."
  [ -x /usr/local/bin/pnpm ] || die "pnpm is missing; run the node step first."
  local commit
  commit="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)" ||
    die "$REPO_DIR is not a Git checkout; run the script from a clone of the repository."
  if [ -f "$WORKER_CODE_DIR/.source-commit" ] && [ "$(cat "$WORKER_CODE_DIR/.source-commit")" = "$commit" ] &&
    [ -f "$WORKER_CODE_DIR/apps/agent-worker/dist/main.js" ]; then
    step_log "unchanged (agent worker at ${commit:0:12})"
    return 0
  fi
  local staging="$WORKER_CODE_DIR.new"
  rm -rf "$staging"
  install -d -o root -g root -m 0755 "$staging"
  git -C "$REPO_DIR" archive --format=tar HEAD | tar -x -C "$staging" --no-same-owner
  # Dependency install scripts never run as root (--ignore-scripts); the worker needs none.
  (
    cd "$staging"
    export PATH="/usr/local/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
    # Copies, not hard links into root's pnpm store, so the code stands on its own.
    /usr/local/bin/pnpm install --frozen-lockfile --ignore-scripts --package-import-method copy \
      --filter '@agentic-studio/agent-worker...'
    /usr/local/bin/pnpm --filter @agentic-studio/contracts run build
    /usr/local/bin/pnpm --filter @agentic-studio/agent-worker run build
  )
  printf '%s\n' "$commit" >"$staging/.source-commit"
  chown -R root:root "$staging"
  chmod -R u+rwX,go+rX,go-w "$staging"
  if [ -d "$WORKER_CODE_DIR" ]; then
    rm -rf "$WORKER_CODE_DIR.old"
    mv "$WORKER_CODE_DIR" "$WORKER_CODE_DIR.old"
  fi
  mv "$staging" "$WORKER_CODE_DIR"
  rm -rf "$WORKER_CODE_DIR.old"
  changed "agent worker ${commit:0:12} built in $WORKER_CODE_DIR"
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
    [ -z "$rest" ] && [[ "$source" =~ ^[A-Za-z0-9._-]+$ ]] && [[ "$dest" == /* ]] && [[ "$dest" != *..* ]] ||
      die "malformed line in $manifest: $provider $source $dest $rest"
    [ -f "$dir/$source" ] && [ ! -L "$dir/$source" ] || die "$dir/$source is missing."
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
  step_log "ok ($count managed-files.txt entries in place, root:root 0644; run by /usr/local/bin/node from the node step)"
}

step_firewall() {
  local uid
  uid="$(agent_uid)"
  [[ "$STUDIO_PROXY_ADDRESS" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "STUDIO_PROXY_ADDRESS must be an IPv4 address."
  [[ "$STUDIO_PROXY_WORKER_PORT" =~ ^[0-9]{1,5}$ ]] || die "STUDIO_PROXY_WORKER_PORT must be a port number."
  install_content /usr/local/sbin/agentic-studio-agent-firewall 755 <<EOF || true
#!/usr/bin/env bash
# Keeps the agent user (uid $uid) away from Studio's container network $STUDIO_NETWORK_SUBNET:
# only the reverse proxy's worker port ($STUDIO_PROXY_ADDRESS:$STUDIO_PROXY_WORKER_PORT) is allowed
# there; the API, PostgreSQL, Redis and anything else are rejected. Installed by deploy/setup-server.sh; run by agentic-studio-agent-firewall.service
# (apply, which fails unless the rules are verified in place) and its verify timer.
set -euo pipefail
verify() {
  iptables -w -C OUTPUT -m owner --uid-owner $uid -j $FIREWALL_CHAIN &&
    iptables -w -C $FIREWALL_CHAIN -d $STUDIO_PROXY_ADDRESS/32 -p tcp --dport $STUDIO_PROXY_WORKER_PORT -j RETURN &&
    iptables -w -C $FIREWALL_CHAIN -d $STUDIO_NETWORK_SUBNET -p tcp -j REJECT --reject-with tcp-reset &&
    iptables -w -C $FIREWALL_CHAIN -d $STUDIO_NETWORK_SUBNET -j REJECT
}
case "\${1:-apply}" in
  apply)
    # The chain is replaced atomically, so a re-apply never leaves it empty.
    iptables-restore -w --noflush <<RULES
*filter
:$FIREWALL_CHAIN - [0:0]
-A $FIREWALL_CHAIN -d $STUDIO_PROXY_ADDRESS/32 -p tcp --dport $STUDIO_PROXY_WORKER_PORT -j RETURN
-A $FIREWALL_CHAIN -d $STUDIO_NETWORK_SUBNET -p tcp -j REJECT --reject-with tcp-reset
-A $FIREWALL_CHAIN -d $STUDIO_NETWORK_SUBNET -j REJECT
COMMIT
RULES
    iptables -w -C OUTPUT -m owner --uid-owner $uid -j $FIREWALL_CHAIN 2>/dev/null ||
      iptables -w -I OUTPUT 1 -m owner --uid-owner $uid -j $FIREWALL_CHAIN
    verify || { echo "agent firewall rules are not in place" >&2; exit 1; }
    ;;
  verify)
    verify 2>/dev/null || { echo "agent firewall rules are missing" >&2; exit 1; }
    ;;
  remove)
    while iptables -w -D OUTPUT -m owner --uid-owner $uid -j $FIREWALL_CHAIN 2>/dev/null; do :; done
    iptables -w -F $FIREWALL_CHAIN 2>/dev/null || true
    iptables -w -X $FIREWALL_CHAIN 2>/dev/null || true
    ;;
  *) echo "usage: \$0 apply|verify|remove" >&2; exit 2 ;;
esac
EOF
  local reload=0
  install_content /etc/systemd/system/agentic-studio-agent-firewall.service 644 <<EOF && reload=1
[Unit]
Description=Keep the agent user away from Studio's container network
Documentation=file://$WORKER_CODE_DIR/docs/engineering/deployment.md
After=network-pre.target
# Before any user manager (the agent user's lingering one included) starts; that manager
# requires and is bound to this unit (user@$uid.service.d/60-agentic-studio-firewall.conf).
Before=systemd-user-sessions.service network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/agentic-studio-agent-firewall apply
ExecStop=/usr/local/sbin/agentic-studio-agent-firewall remove

[Install]
WantedBy=multi-user.target
EOF
  # Rules flushed later by another tool: the timer stops the firewall unit, which stops the
  # agent side with it (fail closed). Starting user@<uid>.service or re-running the setup
  # restores both.
  install_content /etc/systemd/system/agentic-studio-agent-firewall-verify.service 644 <<'EOF' && reload=1
[Unit]
Description=Stop the agent side when its firewall rules are missing
After=agentic-studio-agent-firewall.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c '/usr/local/sbin/agentic-studio-agent-firewall verify || systemctl stop agentic-studio-agent-firewall.service'
EOF
  install_content /etc/systemd/system/agentic-studio-agent-firewall-verify.timer 644 <<'EOF' && reload=1
[Unit]
Description=Check the agent firewall rules every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
  # The agent user's manager (its services, rootless Docker and the worker) never runs without
  # the firewall: starting it starts the firewall first, and stopping or failing the firewall
  # stops it.
  install -d -m 0755 "/etc/systemd/system/user@$uid.service.d"
  install_content "/etc/systemd/system/user@$uid.service.d/60-agentic-studio-firewall.conf" 644 <<'EOF' && reload=1
# Installed by deploy/setup-server.sh: the agent side runs only with its firewall.
[Unit]
Requires=agentic-studio-agent-firewall.service
BindsTo=agentic-studio-agent-firewall.service
After=agentic-studio-agent-firewall.service
EOF
  [ "$reload" = 0 ] || systemctl daemon-reload
  systemctl enable --quiet agentic-studio-agent-firewall.service agentic-studio-agent-firewall-verify.timer
  # Re-applying is idempotent (atomic) and picks up a changed rule set.
  if systemctl is-active --quiet agentic-studio-agent-firewall.service; then
    /usr/local/sbin/agentic-studio-agent-firewall apply
  else
    systemctl start agentic-studio-agent-firewall.service
  fi
  systemctl start agentic-studio-agent-firewall-verify.timer
  step_log "ok (agent user -> $STUDIO_NETWORK_SUBNET rejected except $STUDIO_PROXY_ADDRESS:$STUDIO_PROXY_WORKER_PORT; the agent side is bound to it)"
}

step_rootless() {
  [ -x /usr/bin/dockerd-rootless-setuptool.sh ] || die "docker-ce-rootless-extras is missing; run the packages step first."
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

step_limits() {
  local uid reload=0
  uid="$(agent_uid)"
  install -d -m 0755 "/etc/systemd/system/user-$uid.slice.d" /etc/systemd/system/user@.service.d
  install_content "/etc/systemd/system/user-$uid.slice.d/50-agentic-studio.conf" 644 <<EOF && reload=1
# Installed by deploy/setup-server.sh: limits for everything the agent user '$AGENT_USER' runs.
[Slice]
MemoryMax=$AGENT_MEMORY_MAX
TasksMax=$AGENT_TASKS_MAX
CPUWeight=$AGENT_CPU_WEIGHT
EOF
  # Lets user managers hand cgroup controllers to rootless Docker, so container limits apply.
  local delegate=0
  install_content /etc/systemd/system/user@.service.d/50-agentic-studio-delegate.conf 644 <<'EOF' && delegate=1
# Installed by deploy/setup-server.sh (rootless Docker resource limits).
[Service]
Delegate=cpu cpuset io memory pids
EOF
  if [ "$reload" = 1 ] || [ "$delegate" = 1 ]; then
    systemctl daemon-reload
  fi
  # A running user manager takes new delegation only when it restarts (stops the agent user's
  # services, the worker and rootless Docker included; they start again with it).
  if [ "$delegate" = 1 ] && systemctl is-active --quiet "user@$uid.service"; then
    systemctl restart "user@$uid.service"
    step_log "restarted user@$uid.service for the new cgroup delegation"
  fi
  if [ "$reload" = 1 ]; then
    # Applies the limits to the running slice now as well (the drop-in keeps them across boots).
    if systemctl is-active --quiet "user-$uid.slice"; then
      systemctl set-property --runtime "user-$uid.slice" "MemoryMax=$AGENT_MEMORY_MAX" \
        "TasksMax=$AGENT_TASKS_MAX" "CPUWeight=$AGENT_CPU_WEIGHT"
    fi
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

step_service() {
  local unit=/etc/systemd/user/agentic-studio-worker.service home
  install -d -m 0755 /etc/systemd/user
  install_content "$unit" 644 < <(sed -e "s|@WORKER_CODE_DIR@|$WORKER_CODE_DIR|g" \
    -e "s|@NODE_BIN@|/usr/local/bin/node|g" "$SCRIPT_DIR/systemd/agentic-studio-worker.service") || true
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

next_steps() {
  local home
  home="$(agent_home 2>/dev/null || echo "~$AGENT_USER")"
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
    "step_$step"
  done
  CURRENT_STEP=final
  assert_agent_safe
  next_steps
}

main "$@"
