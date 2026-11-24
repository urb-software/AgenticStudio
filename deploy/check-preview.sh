#!/usr/bin/env bash
# Preview checks for AI Agent Studio (Issue #286; ADR 0004; security.md section 9).
#
# Run as the Preview user after every server change; installed by deploy/setup-server.sh as
# /usr/local/bin/agentic-studio-check-preview:
#   agentic-studio-check-preview                 # every check
#   agentic-studio-check-preview --skip internet # leave out a group (reported as SKIP)
#   agentic-studio-check-preview --claim         # also claim an operation (see below)
#
# Each check prints PASS, FAIL or SKIP and one line of detail; the last line is `RESULT: PASS`
# (exit 0), `RESULT: PASS WITH SKIPS` (exit 0, incomplete) or `RESULT: FAIL` (exit 1). Nothing
# secret is printed: the controller token is read from the controller's own .env and sent only to
# the Studio API, on standard input of curl.
#
# Must be refused: the system Docker socket, the agent's socket and data-root, the agent's home
# and worker .env, Studio's configuration and state, Studio's PostgreSQL, Redis, API and web.
# Must hold: no docker/sudo/proxy-group membership, a private home, linger; cgroup controllers
# `cpu memory pids` delegated and a slice limit that bites; the egress rules in place, and
# blocked from a Compose project network and from a build `RUN` step; the controller unit and
# files; the controller token works on the controller routes only.
#
# The token check does not claim an operation by default (a claim would hold a queued Preview
# operation until its lease runs out): it asks for the state of an operation that does not exist.
# `--claim` claims as well and expects 200 or 204; use it only while none is queued.
# shellcheck disable=SC2016,SC2317 # single-quoted text run by another shell; check_* called by name
set -uo pipefail

# --- Configuration (placeholders; override through the environment) ---------------------------
STUDIO_CONFIG_DIR="${STUDIO_CONFIG_DIR:-/etc/agentic-studio}"
STUDIO_STATE_DIR="${STUDIO_STATE_DIR:-/var/lib/agentic-studio}"
STUDIO_COMPOSE_DIR="${STUDIO_COMPOSE_DIR:-/opt/agentic-studio}"
SYSTEM_DOCKER_SOCKET="${SYSTEM_DOCKER_SOCKET:-/var/run/docker.sock}"
SYSTEM_CONTAINERD_SOCKET="${SYSTEM_CONTAINERD_SOCKET:-/run/containerd/containerd.sock}"
SYSTEM_DOCKER_DATA="${SYSTEM_DOCKER_DATA:-/var/lib/docker}"
STUDIO_POSTGRES_ADDRESS="${STUDIO_POSTGRES_ADDRESS:-172.31.250.10}"
STUDIO_REDIS_ADDRESS="${STUDIO_REDIS_ADDRESS:-172.31.250.11}"
STUDIO_API_ADDRESS="${STUDIO_API_ADDRESS:-172.31.250.12}"
STUDIO_WEB_ADDRESS="${STUDIO_WEB_ADDRESS:-172.31.250.13}"
STUDIO_PROXY_ADDRESS="${STUDIO_PROXY_ADDRESS:-172.31.250.20}"
STUDIO_PROXY_WORKER_PORT="${STUDIO_PROXY_WORKER_PORT:-8080}"
AGENT_USER="${AGENT_USER:-agent}"
PREVIEW_PROXY_GROUP="${PREVIEW_PROXY_GROUP:-previewproxy}"
PREVIEW_PROXY_DIR="${PREVIEW_PROXY_DIR:-/run/preview-proxy}"
EGRESS_SCRIPT="${EGRESS_SCRIPT:-/usr/local/lib/agentic-studio/preview-egress-rules}"
CONTROLLER_UNIT="${CONTROLLER_UNIT:-agentic-studio-controller.service}"
CONTROLLER_ENV_FILE="${CONTROLLER_ENV_FILE:-$HOME/.config/agentic-studio-controller/.env}"
CONTROLLER_MIN_FREE_GB="${CONTROLLER_MIN_FREE_GB:-2}"
CHECK_IMAGE="${CHECK_IMAGE:-busybox:1.37}"
INTERNET_IMAGE="${INTERNET_IMAGE:-alpine:3.22}"
INTERNET_URL="${INTERNET_URL:-https://example.com}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-3}"
# -------------------------------------------------------------------------------------------------

GROUPS_ALL=(identity refused cgroup egress internet controller api)
SKIP=""
CLAIM=0
PASSED=0
FAILED=0
SKIPPED=0
WORK_DIR=""
LISTENER_PID=""
DOCKER_STATE=""

UID_NOW="$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$UID_NOW}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
export DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"
CHILD_PID_FILE="$XDG_RUNTIME_DIR/dockerd-rootless/child_pid"

pass() {
  PASSED=$((PASSED + 1))
  printf 'PASS  %-34s %s\n' "$1" "$2"
}
fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL  %-34s %s\n' "$1" "$2"
}
skip() {
  SKIPPED=$((SKIPPED + 1))
  printf 'SKIP  %-34s %s\n' "$1" "$2"
}

cleanup() {
  [ -z "$LISTENER_PID" ] || kill "$LISTENER_PID" 2>/dev/null
  [ -z "$DOCKER_STATE" ] || systemctl --user set-property --runtime docker.service "MemoryMax=$DOCKER_STATE" >/dev/null 2>&1
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
}
trap cleanup EXIT

can_connect() {
  timeout "$CONNECT_TIMEOUT" bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" 2>/dev/null
}

can_read() {
  if [ -d "$1" ]; then ls -A "$1" >/dev/null 2>&1; else head -c 1 "$1" >/dev/null 2>&1; fi
}

# A value from the controller's .env without printing it (last assignment wins; quotes removed).
controller_env_value() {
  [ -r "$CONTROLLER_ENV_FILE" ] || return 1
  local line value
  line="$(grep -E "^[[:space:]]*$1=" "$CONTROLLER_ENV_FILE" | tail -n 1)" || return 1
  value="${line#*=}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

rootless_up() { timeout 20 docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; }

egress_verify() {
  local pid
  pid="$(cat "$CHILD_PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  timeout 40 nsenter -U --preserve-credentials -n -t "$pid" "$EGRESS_SCRIPT" verify
}

# --- Checks ---------------------------------------------------------------------------------------

check_identity() {
  if [ "$UID_NOW" = 0 ]; then
    fail not-root "running as root: run the checks as the Preview user."
  else
    pass not-root "running as $(id -un) (uid $UID_NOW)"
  fi
  local groups
  groups="$(id -nG | tr ' ' '\n' | grep -Ex "docker|lxd|incus-admin|libvirt|disk|sudo|admin|wheel|$PREVIEW_PROXY_GROUP|$AGENT_USER" | tr '\n' ' ')"
  if [ -n "$groups" ]; then
    fail not-privileged "$(id -un) is in group(s): ${groups% }"
  else
    pass not-privileged "$(id -un) is in none of docker, lxd, incus-admin, libvirt, disk, sudo, $PREVIEW_PROXY_GROUP, $AGENT_USER"
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    pass sudo-needs-password "sudo is not installed"
  elif sudo -n true >/dev/null 2>&1; then
    fail sudo-needs-password "sudo -n true succeeded without a password"
  else
    pass sudo-needs-password "sudo -n true refused"
  fi
  local mode
  mode="$(stat -c '%a' "$HOME")"
  if [ "${mode: -1}" = 0 ]; then
    pass home-private "$HOME is $mode (no access for others)"
  else
    fail home-private "$HOME is $mode: others can enter it"
  fi
  if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ]; then
    pass linger "linger is on (the user's services run without a login session)"
  else
    fail linger "linger is off"
  fi
}

check_refused() {
  local reached=() path
  if [ -e "$SYSTEM_DOCKER_SOCKET" ]; then
    command -v curl >/dev/null 2>&1 &&
      curl -fsS --max-time "$CONNECT_TIMEOUT" --unix-socket "$SYSTEM_DOCKER_SOCKET" http://localhost/_ping >/dev/null 2>&1 &&
      reached+=("curl --unix-socket")
    command -v docker >/dev/null 2>&1 &&
      timeout 10 docker -H "unix://$SYSTEM_DOCKER_SOCKET" version --format '{{.Server.Version}}' >/dev/null 2>&1 &&
      reached+=("docker -H")
  fi
  if [ "${#reached[@]}" -gt 0 ]; then
    fail system-docker-unreachable "$SYSTEM_DOCKER_SOCKET answered (${reached[*]})"
  else
    pass system-docker-unreachable "$SYSTEM_DOCKER_SOCKET refused or absent"
  fi
  if [ -S "$SYSTEM_CONTAINERD_SOCKET" ] && [ -w "$SYSTEM_CONTAINERD_SOCKET" ]; then
    fail system-containerd-unreachable "$SYSTEM_CONTAINERD_SOCKET is writable by $(id -un)"
  else
    pass system-containerd-unreachable "$SYSTEM_CONTAINERD_SOCKET refused or absent"
  fi

  # The agent side: its home, worker .env, rootless socket and data-root.
  local agent_uid agent_home socket
  if ! agent_uid="$(id -u "$AGENT_USER" 2>/dev/null)"; then
    fail agent-docker-unreachable "the agent user '$AGENT_USER' does not exist: run on the set-up server"
    fail agent-files-unreadable "the agent user '$AGENT_USER' does not exist: run on the set-up server"
  else
    agent_home="$(getent passwd "$AGENT_USER" | cut -d: -f6)"
    socket="/run/user/$agent_uid/docker.sock"
    reached=()
    if [ -e "$socket" ]; then
      command -v curl >/dev/null 2>&1 &&
        curl -fsS --max-time "$CONNECT_TIMEOUT" --unix-socket "$socket" http://localhost/_ping >/dev/null 2>&1 &&
        reached+=("curl --unix-socket")
      command -v docker >/dev/null 2>&1 &&
        timeout 10 docker -H "unix://$socket" version --format '{{.Server.Version}}' >/dev/null 2>&1 &&
        reached+=("docker -H")
    fi
    [ ! -w "$socket" ] || reached+=("writable")
    can_read "$agent_home/.local/share/docker" && reached+=("data-root listed")
    if [ "${#reached[@]}" -gt 0 ]; then
      fail agent-docker-unreachable "the agent's socket or data-root: ${reached[*]}"
    else
      pass agent-docker-unreachable "$socket and $agent_home/.local/share/docker refused"
    fi
    reached=()
    for path in "$agent_home" "$agent_home/.config/agentic-studio-worker" "$agent_home/.config/agentic-studio-worker/.env" \
      "$agent_home/.local/share/agentic-studio-worker"; do
      can_read "$path" && reached+=("$path")
    done
    if [ "${#reached[@]}" -gt 0 ]; then
      fail agent-files-unreadable "readable: ${reached[*]}"
    else
      pass agent-files-unreadable "the agent's home, worker .env and data directory refused"
    fi
  fi

  reached=()
  for path in "$STUDIO_CONFIG_DIR" "$STUDIO_CONFIG_DIR/.env" "$STUDIO_COMPOSE_DIR" "$STUDIO_STATE_DIR" "$STUDIO_STATE_DIR/data" \
    "$STUDIO_STATE_DIR/proxy" "$SYSTEM_DOCKER_DATA/volumes"; do
    can_read "$path" && reached+=("$path")
  done
  if [ ! -e "$STUDIO_CONFIG_DIR" ] || [ ! -e "$STUDIO_STATE_DIR" ]; then
    fail studio-files-unreadable "$STUDIO_CONFIG_DIR or $STUDIO_STATE_DIR not found: run on the set-up server"
  elif [ "${#reached[@]}" -gt 0 ]; then
    fail studio-files-unreadable "readable: ${reached[*]}"
  else
    pass studio-files-unreadable "Studio's configuration, Compose files, state and Docker volumes refused"
  fi

  # Studio's internal services, from the Preview user's own processes (its firewall).
  local target connected=()
  for target in "$STUDIO_POSTGRES_ADDRESS:5432" "$STUDIO_REDIS_ADDRESS:6379" "$STUDIO_API_ADDRESS:3001" "$STUDIO_WEB_ADDRESS:3000"; do
    can_connect "${target%:*}" "${target##*:}" && connected+=("$target")
  done
  if [ "${#connected[@]}" -gt 0 ]; then
    fail studio-network-unreachable "connected to ${connected[*]}"
  else
    pass studio-network-unreachable "PostgreSQL, Redis, API and web refused (only the proxy's port $STUDIO_PROXY_WORKER_PORT is open)"
  fi
}

check_cgroup() {
  if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    pass cgroup-v2 "unified cgroup hierarchy"
  else
    fail cgroup-v2 "no cgroup v2"
  fi
  local controllers missing=() name
  controllers="$(cat "/sys/fs/cgroup/user.slice/user-$UID_NOW.slice/user@$UID_NOW.service/cgroup.controllers" 2>/dev/null || true)"
  for name in cpu memory pids; do
    [[ " $controllers " == *" $name "* ]] || missing+=("$name")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    fail cgroup-delegation "the user manager's cgroup.controllers (${controllers:-unreadable}) lacks ${missing[*]}"
  else
    pass cgroup-delegation "the user manager's cgroup.controllers contains cpu memory pids"
  fi
  local slice memory tasks
  slice="user-$UID_NOW.slice"
  memory="$(systemctl show "$slice" -p MemoryMax --value 2>/dev/null)"
  tasks="$(systemctl show "$slice" -p TasksMax --value 2>/dev/null)"
  if [ -z "$memory" ] || [ "$memory" = infinity ] || [ -z "$tasks" ] || [ "$tasks" = infinity ]; then
    fail preview-user-limits "$slice: MemoryMax=${memory:-?} TasksMax=${tasks:-?}"
  else
    pass preview-user-limits "$slice: MemoryMax=$memory TasksMax=$tasks"
  fi
  # A limit that bites: a process that allocates without end under MemoryMax is killed, and the
  # scope reports the limits it was given.
  local limits status
  limits="$(timeout 60 systemd-run --user --scope --quiet -p MemoryMax=64M -p MemorySwapMax=0 -p TasksMax=20 -- \
    sh -c 'cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); echo "$(cat "$cg/memory.max") $(cat "$cg/pids.max")"' 2>/dev/null)"
  timeout 60 systemd-run --user --scope --quiet -p MemoryMax=64M -p MemorySwapMax=0 -- tail /dev/zero >/dev/null 2>&1
  status=$?
  if [ "$limits" = "67108864 20" ] && [ "$status" -ne 0 ]; then
    pass slice-limit-bites "a scope with MemoryMax=64M TasksMax=20 got them, and an unbounded allocation was killed (exit $status)"
  else
    fail slice-limit-bites "limits '${limits:-none}' (expected '67108864 20'), allocation exit $status (expected non-zero)"
  fi

  # The daemon's own unit can be bounded while it builds (the controller does it per build): a
  # build whose RUN step allocates above the limit fails and the daemon stays up (OOMPolicy=continue).
  if ! rootless_up; then
    fail docker-unit-memory-limit "no rootless daemon at $DOCKER_HOST"
    return
  fi
  local before pid_before pid_after build_status
  before="$(systemctl --user show docker.service -p MemoryMax --value 2>/dev/null)"
  pid_before="$(systemctl --user show docker.service -p MainPID --value 2>/dev/null)"
  WORK_DIR="${WORK_DIR:-$(mktemp -d)}"
  mkdir -p "$WORK_DIR/oom"
  printf 'FROM %s\nRUN tail /dev/zero\n' "$CHECK_IMAGE" >"$WORK_DIR/oom/Dockerfile"
  DOCKER_STATE="${before:-infinity}"
  systemctl --user set-property --runtime docker.service MemoryMax=512M >/dev/null 2>&1
  timeout 300 docker build --no-cache -q -t preview-check-oom:probe "$WORK_DIR/oom" >/dev/null 2>&1
  build_status=$?
  systemctl --user set-property --runtime docker.service "MemoryMax=$DOCKER_STATE" >/dev/null 2>&1
  DOCKER_STATE=""
  local up=1 _
  for _ in $(seq 1 15); do
    if [ "$(systemctl --user is-active docker.service 2>/dev/null)" = active ] && rootless_up; then
      up=0
      break
    fi
    sleep 1
  done
  pid_after="$(systemctl --user show docker.service -p MainPID --value 2>/dev/null)"
  if [ "$build_status" -ne 0 ] && [ "$up" = 0 ] && [ "$pid_before" = "$pid_after" ]; then
    pass docker-unit-memory-limit "a RUN step above MemoryMax=512M on docker.service failed; the daemon (pid $pid_after) stayed active"
  else
    fail docker-unit-memory-limit "build exit $build_status (expected non-zero), daemon up=$([ "$up" = 0 ] && echo yes || echo no), pid $pid_before -> $pid_after (expected unchanged)"
  fi
}

# The probe run in a container and in a build step: prints OPEN or BLOCKED per target.
write_probe() {
  local dir="$1" host_ip="$2" port="$3"
  mkdir -p "$dir"
  {
    echo 'probe() { if nc -w 3 "$2" "$3" </dev/null >/dev/null 2>&1; then echo "OPEN $1"; else echo "BLOCKED $1"; fi; }'
    echo "probe proxy $STUDIO_PROXY_ADDRESS $STUDIO_PROXY_WORKER_PORT"
    echo "probe postgres $STUDIO_POSTGRES_ADDRESS 5432"
    echo "probe host-address $host_ip $port"
    echo "probe slirp-host 10.0.2.2 $port"
  } >"$dir/probe.sh"
  printf 'FROM %s\nCOPY probe.sh /probe.sh\nRUN sh /probe.sh\n' "$CHECK_IMAGE" >"$dir/Dockerfile"
  cat >"$dir/compose.yaml" <<EOF
services:
  probe:
    build: .
    command: ['sh', '/probe.sh']
    restart: 'no'
EOF
}

blocked_report() {
  # blocked_report <check name> <where> <output>: every target BLOCKED, none missing.
  local name="$1" where="$2" output="$3" target open=() missing=()
  for target in proxy postgres host-address slirp-host; do
    if grep -qx "OPEN $target" <<<"$output"; then
      open+=("$target")
    elif ! grep -qx "BLOCKED $target" <<<"$output"; then
      missing+=("$target")
    fi
  done
  if [ "${#open[@]}" -gt 0 ]; then
    fail "$name" "reachable from $where: ${open[*]}"
  elif [ "${#missing[@]}" -gt 0 ]; then
    fail "$name" "no result from $where for: ${missing[*]}"
  else
    pass "$name" "from $where the proxy, PostgreSQL, the host's address and 10.0.2.2 are blocked"
  fi
}

check_egress() {
  if [ -x "$EGRESS_SCRIPT" ] && [ "$(stat -c '%U:%G %a' "$EGRESS_SCRIPT")" = "root:root 755" ]; then
    pass egress-script-root-owned "$EGRESS_SCRIPT is root:root 755"
  else
    fail egress-script-root-owned "$EGRESS_SCRIPT is '$(stat -c '%U:%G %a' "$EGRESS_SCRIPT" 2>/dev/null || echo missing)', expected root:root 755"
  fi
  if ! rootless_up; then
    fail rootless-docker "no rootless daemon answered at $DOCKER_HOST"
    fail egress-rules-verify "not run: no rootless daemon"
    return
  fi
  local info
  info="$(timeout 20 docker info --format '{{json .SecurityOptions}} {{.CgroupVersion}} {{.CgroupDriver}}' 2>/dev/null)"
  if [[ "$info" == *rootless* ]] && [[ "$info" == *" 2 systemd" ]]; then
    pass rootless-docker "rootless daemon, cgroup v2, systemd driver"
  else
    fail rootless-docker "expected a rootless daemon on cgroup v2 with the systemd driver, got: $info"
  fi
  local dns configured
  dns="$(sed -n 's/^DNS_SERVER="\(.*\)"$/\1/p' "$EGRESS_SCRIPT" 2>/dev/null | head -n 1)"
  configured="$(tr -d ' \n' <"$HOME/.config/docker/daemon.json" 2>/dev/null)"
  if [ -n "$dns" ] && [ "$configured" = "{\"dns\":[\"$dns\"]}" ]; then
    pass daemon-dns "daemon.json names the resolver the egress rules allow ($dns)"
  else
    fail daemon-dns "daemon.json is '${configured:-missing}', the rules allow '${dns:-none}'"
  fi
  if egress_verify; then
    pass egress-rules-verify "verify passed inside the daemon's network namespace"
  else
    fail egress-rules-verify "verify failed (the egress rules are missing)"
  fi

  # A listener on the host (all addresses) stands in for a service on the host's address and on
  # its loopback (10.0.2.2 for a rootless container). The check itself reaches it: a positive control.
  local host_ip port
  host_ip="$(ip -4 route get 192.0.2.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }')"
  if [ -z "$host_ip" ] || ! command -v socat >/dev/null 2>&1; then
    fail egress-blocked-compose-network "no host address or no socat for the listener"
    fail egress-blocked-build-step "no host address or no socat for the listener"
    return
  fi
  for port in $(shuf -i 20000-29999 -n 20); do
    can_connect 127.0.0.1 "$port" || break
  done
  socat "TCP-LISTEN:$port,reuseaddr,fork" /dev/null 2>/dev/null &
  LISTENER_PID=$!
  sleep 1
  if ! can_connect "$host_ip" "$port"; then
    fail egress-blocked-compose-network "the control listener on $host_ip:$port is not reachable from the host itself"
    fail egress-blocked-build-step "the control listener on $host_ip:$port is not reachable from the host itself"
    return
  fi
  WORK_DIR="${WORK_DIR:-$(mktemp -d)}"
  write_probe "$WORK_DIR/probe" "$host_ip" "$port"
  local project="preview-check-$$" build run
  build="$(cd "$WORK_DIR/probe" && timeout 300 docker compose -p "$project" build --no-cache --progress plain 2>&1)"
  blocked_report egress-blocked-build-step "a build RUN step" "$(grep -Eo '(OPEN|BLOCKED) (proxy|postgres|host-address|slirp-host)$' <<<"$build")"
  run="$(cd "$WORK_DIR/probe" && timeout 120 docker compose -p "$project" run --rm -T probe 2>/dev/null)"
  blocked_report egress-blocked-compose-network "a Compose project network" "$run"
  (cd "$WORK_DIR/probe" && timeout 120 docker compose -p "$project" down -v -t 1 >/dev/null 2>&1)
}

check_internet() {
  if ! rootless_up; then
    fail internet-https "no rootless daemon at $DOCKER_HOST"
    return
  fi
  if timeout 180 docker run --rm "$INTERNET_IMAGE" wget -q -T 15 -O /dev/null "$INTERNET_URL" >/dev/null 2>&1; then
    pass internet-https "a container reached $INTERNET_URL"
  else
    fail internet-https "a container did not reach $INTERNET_URL (egress to the internet is expected to work)"
  fi
}

check_controller() {
  if [ "$(systemctl --user is-enabled "$CONTROLLER_UNIT" 2>/dev/null)" = enabled ]; then
    pass controller-unit-enabled "$CONTROLLER_UNIT is enabled"
  else
    fail controller-unit-enabled "$CONTROLLER_UNIT is not enabled"
  fi
  local stat_env data_dir
  stat_env="$(stat -c '%U:%G %a' "$CONTROLLER_ENV_FILE" 2>/dev/null || echo missing)"
  if [ "$stat_env" = "$(id -un):$(id -gn) 600" ]; then
    pass controller-env-file "$CONTROLLER_ENV_FILE is $stat_env"
  else
    fail controller-env-file "$CONTROLLER_ENV_FILE is '$stat_env', expected $(id -un):$(id -gn) 600"
  fi
  data_dir="$(controller_env_value STUDIO_CONTROLLER_DATA_DIR || true)"
  if [ -n "$data_dir" ] && [ "$(stat -c '%U %a' "$data_dir" 2>/dev/null)" = "$(id -un) 700" ]; then
    pass controller-data-dir "$data_dir is 700"
  else
    fail controller-data-dir "'${data_dir:-unset}' is not a 700 directory of $(id -un)"
  fi

  # The settings production insists on: left at their defaults or unset in the .env, and the unit's
  # own values; the controller refuses anything else in production.
  local problems=() name value default environment
  for pair in STUDIO_CONTROLLER_ENVIRONMENT=production STUDIO_CONTROLLER_RUNTIME=docker STUDIO_CONTROLLER_ROOTLESS=true \
    STUDIO_CONTROLLER_EGRESS_RULES_BIN="$EGRESS_SCRIPT"; do
    name="${pair%%=*}"
    default="${pair#*=}"
    value="$(controller_env_value "$name" || true)"
    [ -z "$value" ] || [ "$value" = "$default" ] || problems+=("$name=$value in the .env")
  done
  for name in HOME XDG_RUNTIME_DIR DOCKER_HOST STUDIO_WORKER_TOKEN DATABASE_URL REDIS_URL STUDIO_SECRETS_KEY; do
    ! grep -Eq "^[[:space:]]*(export[[:space:]]+)?$name=" "$CONTROLLER_ENV_FILE" 2>/dev/null || problems+=("$name in the .env")
  done
  environment="$(systemctl --user show "$CONTROLLER_UNIT" -p Environment --value 2>/dev/null)"
  [[ " $environment " == *" STUDIO_CONTROLLER_ENVIRONMENT=production "* ]] || problems+=("the unit does not set STUDIO_CONTROLLER_ENVIRONMENT=production")
  [[ " $environment " == *" DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock "* ]] || problems+=("the unit's DOCKER_HOST is not unix://$XDG_RUNTIME_DIR/docker.sock")
  [ "$(systemctl --user show "$CONTROLLER_UNIT" -p RestrictNamespaces --value 2>/dev/null)" = no ] || problems+=("RestrictNamespaces is set")
  [ "$(systemctl --user show "$CONTROLLER_UNIT" -p NoNewPrivileges --value 2>/dev/null)" = yes ] || problems+=("NoNewPrivileges is not yes")
  [ "$(systemctl --user show "$CONTROLLER_UNIT" -p KillMode --value 2>/dev/null)" = mixed ] || problems+=("KillMode is not mixed")
  local pid
  pid="$(systemctl --user show "$CONTROLLER_UNIT" -p MainPID --value 2>/dev/null)"
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    local running
    running="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null || true)"
    grep -qx 'STUDIO_CONTROLLER_ENVIRONMENT=production' <<<"$running" || problems+=("the running controller's STUDIO_CONTROLLER_ENVIRONMENT is not production")
    grep -qx "DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock" <<<"$running" || problems+=("the running controller's DOCKER_HOST is not the rootless socket")
  fi
  if [ "${#problems[@]}" -gt 0 ]; then
    fail controller-settings "${problems[*]:0:4}"
  else
    pass controller-settings "production, the rootless DOCKER_HOST, no RestrictNamespaces, NoNewPrivileges, KillMode=mixed"
  fi

  local dir_stat
  dir_stat="$(stat -c '%U:%G %a' "$PREVIEW_PROXY_DIR" 2>/dev/null || echo missing)"
  if [ "$dir_stat" = "$(id -un):$PREVIEW_PROXY_GROUP 2750" ]; then
    pass preview-proxy-dir "$PREVIEW_PROXY_DIR is $dir_stat"
  else
    fail preview-proxy-dir "$PREVIEW_PROXY_DIR is '$dir_stat', expected $(id -un):$PREVIEW_PROXY_GROUP 2750"
  fi

  local free
  free="$([ -n "$data_dir" ] && df -BG --output=avail "$data_dir" 2>/dev/null | tail -n 1 | tr -dc '0-9')"
  if [ -n "$free" ] && [ "$free" -ge "$CONTROLLER_MIN_FREE_GB" ]; then
    pass controller-free-disk "${free} GiB free where the controller builds (at least $CONTROLLER_MIN_FREE_GB)"
  else
    fail controller-free-disk "${free:-unknown} GiB free where the controller builds, at least $CONTROLLER_MIN_FREE_GB needed"
  fi

  if ! grep -Eq '^[[:space:]]*STUDIO_CONTROLLER_TOKEN=.{32,}' "$CONTROLLER_ENV_FILE" 2>/dev/null; then
    skip controller-active "STUDIO_CONTROLLER_TOKEN is not set yet (the controller starts once it is)"
  elif [ "$(systemctl --user is-active "$CONTROLLER_UNIT" 2>/dev/null)" = active ]; then
    pass controller-active "$CONTROLLER_UNIT is active"
  else
    fail controller-active "$CONTROLLER_UNIT is $(systemctl --user is-active "$CONTROLLER_UNIT" 2>/dev/null)"
  fi
}

# HTTP status of a request; never prints the token.
http_status() {
  local method="$1" url="$2" auth="$3" body="${4:-}"
  local args=(-s -o /dev/null -w '%{http_code}' --max-time 10 -X "$method")
  [ -z "$auth" ] || args+=(-H @-)
  [ -z "$body" ] || args+=(-H 'Content-Type: application/json' --data "$body")
  if [ -n "$auth" ]; then
    printf 'Authorization: Bearer %s\n' "$auth" | curl "${args[@]}" "$url" 2>/dev/null
  else
    curl "${args[@]}" "$url" 2>/dev/null
  fi
}

random_uuid() { cat /proc/sys/kernel/random/uuid; }

check_api() {
  local api token
  api="$(controller_env_value STUDIO_API_URL || true)"
  token="$(controller_env_value STUDIO_CONTROLLER_TOKEN || true)"
  api="${api%/}"
  if [ -z "$api" ] || [ "${#token}" -lt 32 ]; then
    fail controller-token-works "STUDIO_API_URL or STUDIO_CONTROLLER_TOKEN missing in $CONTROLLER_ENV_FILE"
    fail controller-token-nothing-else "not run: no controller token"
    return
  fi
  local body status without
  body="{\"controllerId\":\"$(random_uuid)\",\"state\":\"succeeded\"}"
  # The state of an operation that does not exist: any answer but 401 shows the token is accepted.
  status="$(http_status POST "$api/api/controller/operations/$(random_uuid)/state" "$token" "$body")"
  without="$(http_status POST "$api/api/controller/operations/$(random_uuid)/state" "" "$body")"
  if [[ "$status" =~ ^(400|404|409)$ ]] && [ "$without" = 401 ]; then
    pass controller-token-works "controller route: $status with the token (not 401), 401 without"
  else
    fail controller-token-works "controller route answered ${status:-no answer} with the token and ${without:-no answer} without (expected 400, 404 or 409, and 401)"
  fi
  if [ "$CLAIM" = 1 ]; then
    status="$(http_status POST "$api/api/controller/operations/claim" "$token" "{\"controllerId\":\"$(random_uuid)\"}")"
    if [ "$status" = 200 ] || [ "$status" = 204 ]; then
      pass controller-token-claim "the claim route answered $status"
    else
      fail controller-token-claim "the claim route answered ${status:-no answer} (expected 200 or 204)"
    fi
  else
    skip controller-token-claim "not claiming an operation (use --claim while none is queued)"
  fi

  local accepted=() route
  status="$(http_status POST "$api/api/worker/runs/states" "$token" "{\"workerId\":\"$(random_uuid)\",\"runIds\":[\"$(random_uuid)\"]}")"
  [ "$status" = 401 ] || accepted+=("POST /api/worker/runs/states -> ${status:-no answer}")
  for route in "GET /api/projects" "GET /api/runs" "GET /api/auth/session" "GET /api/providers"; do
    status="$(http_status "${route% *}" "$api${route#* }" "$token")"
    [ "$status" = 401 ] || accepted+=("$route -> ${status:-no answer}")
  done
  status="$(http_status POST "$api/api/projects" "$token" '{"name":"preview-check"}')"
  [ "$status" = 401 ] || [ "$status" = 403 ] || accepted+=("POST /api/projects -> ${status:-no answer}")
  if [ "${#accepted[@]}" -gt 0 ]; then
    fail controller-token-nothing-else "not refused with 401: ${accepted[*]}"
  else
    pass controller-token-nothing-else "worker and operator routes refuse the controller token"
  fi
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --skip)
        [ $# -ge 2 ] || {
          echo "--skip needs a group list (${GROUPS_ALL[*]})" >&2
          exit 2
        }
        SKIP="$2"
        shift 2
        ;;
      --claim)
        CLAIM=1
        shift
        ;;
      -h | --help)
        echo "Usage: $0 [--skip group[,group...]] [--claim]   groups: ${GROUPS_ALL[*]}"
        exit 0
        ;;
      *)
        echo "unknown argument '$1' (see --help)" >&2
        exit 2
        ;;
    esac
  done
  local group
  IFS=',' read -r -a skipped <<<"$SKIP"
  for group in "${skipped[@]}"; do
    [[ " ${GROUPS_ALL[*]} " == *" $group "* ]] || {
      echo "unknown group '$group' (groups: ${GROUPS_ALL[*]})" >&2
      exit 2
    }
  done
  echo "Preview checks as $(id -un) on $(uname -sr)"
  for group in "${GROUPS_ALL[@]}"; do
    if [[ ",$SKIP," == *",$group,"* ]]; then
      skip "$group" "skipped on request (--skip)"
      continue
    fi
    "check_$group"
  done
  if [ "$FAILED" -gt 0 ]; then
    echo "RESULT: FAIL ($PASSED passed, $FAILED failed, $SKIPPED skipped)"
    exit 1
  fi
  if [ "$SKIPPED" -gt 0 ]; then
    echo "RESULT: PASS WITH SKIPS ($PASSED passed, $SKIPPED skipped: not a complete server check)"
  else
    echo "RESULT: PASS ($PASSED passed)"
  fi
}

main "$@"
