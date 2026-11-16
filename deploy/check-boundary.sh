#!/usr/bin/env bash
# Isolation boundary checks for AI Agent Studio (Issue #107; ADR 0002; security.md §9).
#
# Run as the agent user after every server change; installed by deploy/setup-server.sh as
# /usr/local/bin/agentic-studio-check-boundary:
#   agentic-studio-check-boundary              # every check
#   agentic-studio-check-boundary --skip api   # leave out a group (reported as SKIP)
#
# Each check prints PASS, FAIL or SKIP and one line of detail; the last line is
# `RESULT: PASS` (exit 0) or `RESULT: FAIL` (exit 1). Nothing secret is printed: the worker
# token is read from the worker's own .env and sent only to the Studio API.
#
# Must be refused: reading Studio's configuration and data, the secret store's master key or a
# deploy key; the system Docker socket; sudo without a password; Studio's PostgreSQL and Redis.
# Must work: rootless Docker (a container with resource limits, a Compose stack), the worker
# routes with the worker token; that token reaches nothing else on the API. Also: not WSL with
# interop or automount, cgroup v2 with limits on the agent user's slice.
# shellcheck disable=SC2016,SC2317 # single-quoted text run by another shell; check_* called by name
set -uo pipefail

# --- Configuration (placeholders; override through the environment) ---------------------------
STUDIO_CONFIG_DIR="${STUDIO_CONFIG_DIR:-/etc/agentic-studio}"
STUDIO_STATE_DIR="${STUDIO_STATE_DIR:-/var/lib/agentic-studio}"
STUDIO_COMPOSE_DIR="${STUDIO_COMPOSE_DIR:-/opt/agentic-studio}"
SYSTEM_DOCKER_SOCKET="${SYSTEM_DOCKER_SOCKET:-/var/run/docker.sock}"
SYSTEM_DOCKER_DATA="${SYSTEM_DOCKER_DATA:-/var/lib/docker}"
# Studio's PostgreSQL and Redis (equal to compose.server.yaml and studio.env.example).
STUDIO_POSTGRES_ADDRESS="${STUDIO_POSTGRES_ADDRESS:-172.31.250.10}"
STUDIO_REDIS_ADDRESS="${STUDIO_REDIS_ADDRESS:-172.31.250.11}"
WORKER_ENV_FILE="${WORKER_ENV_FILE:-$HOME/.config/agentic-studio-worker/.env}"
# A small public image for the rootless container checks.
CHECK_IMAGE="${CHECK_IMAGE:-busybox:1.37}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-3}"
# -------------------------------------------------------------------------------------------------

GROUPS_ALL=(identity studio-files docker-socket sudo studio-network host cgroup rootless api)
SKIP=""
PASSED=0
FAILED=0
SKIPPED=0
WORK_DIR=""

# Variables that must never reach the agent side (the worker refuses to start with them).
STUDIO_ONLY_VARS=(DATABASE_URL REDIS_URL STUDIO_SECRETS_KEY STUDIO_OPERATOR_PASSWORD_HASH POSTGRES_PASSWORD)

pass() {
  PASSED=$((PASSED + 1))
  printf 'PASS  %-28s %s\n' "$1" "$2"
}
fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL  %-28s %s\n' "$1" "$2"
}
skip() {
  SKIPPED=$((SKIPPED + 1))
  printf 'SKIP  %-28s %s\n' "$1" "$2"
}

cleanup() { [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"; }
trap cleanup EXIT

# Whether a TCP connection to host:port succeeds.
can_connect() {
  timeout "$CONNECT_TIMEOUT" bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$1" "$2" 2>/dev/null
}

# Whether the current user can list a directory or read a file.
can_read() {
  if [ -d "$1" ]; then ls -A "$1" >/dev/null 2>&1; else head -c 1 "$1" >/dev/null 2>&1; fi
}

# A value from the worker's .env without printing it (last assignment wins; quotes removed).
worker_env_value() {
  [ -r "$WORKER_ENV_FILE" ] || return 1
  local line value
  line="$(grep -E "^[[:space:]]*$1=" "$WORKER_ENV_FILE" | tail -n 1)" || return 1
  value="${line#*=}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf '%s' "$value"
}

# --- Checks ---------------------------------------------------------------------------------------

check_identity() {
  if [ "$(id -u)" = 0 ]; then
    fail not-root "running as root: run the checks as the agent user."
  else
    pass not-root "running as $(id -un) (uid $(id -u))"
  fi
  if id -nG | tr ' ' '\n' | grep -qx docker; then
    fail not-in-docker-group "$(id -un) is in the docker group (root-equivalent)"
  else
    pass not-in-docker-group "$(id -un) is not in the docker group"
  fi
}

check_studio_files() {
  # A missing directory proves nothing: the checks must run on the set-up server.
  local path readable=()
  for path in "$STUDIO_CONFIG_DIR" "$STUDIO_CONFIG_DIR/.env" "$STUDIO_COMPOSE_DIR"; do
    can_read "$path" && readable+=("$path")
  done
  if [ ! -e "$STUDIO_CONFIG_DIR" ] || [ ! -e "$STUDIO_COMPOSE_DIR" ]; then
    fail studio-config-unreadable "$STUDIO_CONFIG_DIR or $STUDIO_COMPOSE_DIR not found: run on the set-up server"
  elif [ "${#readable[@]}" -gt 0 ]; then
    fail studio-config-unreadable "readable: ${readable[*]}"
  else
    pass studio-config-unreadable "$STUDIO_CONFIG_DIR and $STUDIO_COMPOSE_DIR refused"
  fi

  readable=()
  for path in "$STUDIO_STATE_DIR" "$STUDIO_STATE_DIR/data" "$SYSTEM_DOCKER_DATA/volumes"; do
    can_read "$path" && readable+=("$path")
  done
  if [ ! -e "$STUDIO_STATE_DIR" ]; then
    fail studio-data-unreadable "$STUDIO_STATE_DIR not found: run on the set-up server"
  elif [ "${#readable[@]}" -gt 0 ]; then
    fail studio-data-unreadable "readable: ${readable[*]}"
  else
    pass studio-data-unreadable "$STUDIO_STATE_DIR and Docker volumes refused"
  fi

  # The secret store's master key lives only in Studio's .env; deploy keys only in Studio's
  # database and data directory. None may be readable, or present on the agent side.
  local leaks=() name
  can_read "$STUDIO_CONFIG_DIR/.env" && leaks+=("$STUDIO_CONFIG_DIR/.env")
  can_read "$STUDIO_STATE_DIR/data" && leaks+=("$STUDIO_STATE_DIR/data")
  for name in "${STUDIO_ONLY_VARS[@]}"; do
    [ -z "${!name:-}" ] || leaks+=("\$$name in this environment")
    if [ -r "$WORKER_ENV_FILE" ] && grep -Eq "^[[:space:]]*(export[[:space:]]+)?$name=" "$WORKER_ENV_FILE"; then
      leaks+=("$name in the worker's .env")
    fi
  done
  if [ "${#leaks[@]}" -gt 0 ]; then
    fail secrets-unreachable "${leaks[*]}"
  else
    pass secrets-unreachable "master key and deploy keys not readable; no Studio secret on the agent side"
  fi
}

check_docker_socket() {
  local reached=()
  if [ -S "$SYSTEM_DOCKER_SOCKET" ] || [ -e "$SYSTEM_DOCKER_SOCKET" ]; then
    if command -v curl >/dev/null 2>&1 &&
      curl -fsS --max-time "$CONNECT_TIMEOUT" --unix-socket "$SYSTEM_DOCKER_SOCKET" http://localhost/_ping >/dev/null 2>&1; then
      reached+=("curl --unix-socket")
    fi
    if command -v docker >/dev/null 2>&1 &&
      timeout 10 docker -H "unix://$SYSTEM_DOCKER_SOCKET" version --format '{{.Server.Version}}' >/dev/null 2>&1; then
      reached+=("docker -H")
    fi
  fi
  if [ "${#reached[@]}" -gt 0 ]; then
    fail system-docker-unreachable "$SYSTEM_DOCKER_SOCKET answered (${reached[*]})"
  elif [ -e "$SYSTEM_DOCKER_SOCKET" ]; then
    pass system-docker-unreachable "$SYSTEM_DOCKER_SOCKET refused"
  else
    pass system-docker-unreachable "$SYSTEM_DOCKER_SOCKET does not exist here"
  fi
}

check_sudo() {
  if ! command -v sudo >/dev/null 2>&1; then
    pass sudo-needs-password "sudo is not installed"
  elif sudo -n true >/dev/null 2>&1; then
    fail sudo-needs-password "sudo -n true succeeded without a password"
  else
    pass sudo-needs-password "sudo -n true refused"
  fi
}

check_studio_network() {
  local target reached=()
  for target in "127.0.0.1:5432" "$STUDIO_POSTGRES_ADDRESS:5432"; do
    can_connect "${target%:*}" "${target##*:}" && reached+=("$target")
  done
  if [ "${#reached[@]}" -gt 0 ]; then
    fail studio-postgres-unreachable "connected to ${reached[*]}"
  else
    pass studio-postgres-unreachable "127.0.0.1:5432 and $STUDIO_POSTGRES_ADDRESS:5432 refused"
  fi
  reached=()
  for target in "127.0.0.1:6379" "$STUDIO_REDIS_ADDRESS:6379"; do
    can_connect "${target%:*}" "${target##*:}" && reached+=("$target")
  done
  if [ "${#reached[@]}" -gt 0 ]; then
    fail studio-redis-unreachable "connected to ${reached[*]}"
  else
    pass studio-redis-unreachable "127.0.0.1:6379 and $STUDIO_REDIS_ADDRESS:6379 refused"
  fi
}

check_host() {
  # WSL with interop runs Windows programs as the Windows user; its drive mounts are writable.
  local problems=() entry mount
  for entry in /proc/sys/fs/binfmt_misc/WSLInterop /proc/sys/fs/binfmt_misc/WSLInterop-late; do
    [ -e "$entry" ] && grep -qx enabled "$entry" 2>/dev/null && problems+=("interop enabled ($entry)")
  done
  while read -r _ mount type _; do
    case "$type" in 9p | drvfs | virtiofs)
      if [ -w "$mount" ] || can_read "$mount"; then problems+=("Windows drive mounted at $mount"); fi
      ;;
    esac
  done </proc/mounts
  if [ "${#problems[@]}" -gt 0 ]; then
    fail no-wsl-escape "${problems[*]}"
  elif grep -qi microsoft /proc/version 2>/dev/null; then
    pass no-wsl-escape "WSL with interop and automount disabled"
  else
    pass no-wsl-escape "native Linux (no WSL interop, no Windows drive mount)"
  fi
}

check_cgroup() {
  if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    pass cgroup-v2 "unified cgroup hierarchy"
  else
    fail cgroup-v2 "no cgroup v2 (container resource limits would not apply)"
  fi
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    fail agent-user-limits "no systemd: the agent user's slice limits cannot apply"
    return
  fi
  local slice memory tasks
  slice="user-$(id -u).slice"
  memory="$(systemctl show "$slice" -p MemoryMax --value 2>/dev/null)"
  tasks="$(systemctl show "$slice" -p TasksMax --value 2>/dev/null)"
  if [ -z "$memory" ] || [ "$memory" = infinity ] || [ -z "$tasks" ] || [ "$tasks" = infinity ]; then
    fail agent-user-limits "$slice: MemoryMax=${memory:-?} TasksMax=${tasks:-?}"
  else
    pass agent-user-limits "$slice: MemoryMax=$memory TasksMax=$tasks"
  fi
}

check_rootless() {
  export DOCKER_HOST="${DOCKER_HOST:-unix://${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock}"
  if [ "$DOCKER_HOST" = "unix://$SYSTEM_DOCKER_SOCKET" ]; then
    fail rootless-docker "DOCKER_HOST points at the system Docker socket"
    return
  fi
  if ! command -v docker >/dev/null 2>&1; then
    fail rootless-docker "docker CLI not found"
    fail rootless-container-limits "not run: no rootless Docker"
    fail rootless-compose "not run: no rootless Docker"
    return
  fi
  local info
  info="$(timeout 20 docker info --format '{{json .SecurityOptions}} {{.CgroupVersion}} {{.CgroupDriver}}' 2>/dev/null)"
  if [ -z "$info" ]; then
    fail rootless-docker "no daemon answered at $DOCKER_HOST"
    fail rootless-container-limits "not run: no rootless Docker"
    fail rootless-compose "not run: no rootless Docker"
    return
  fi
  if [[ "$info" == *rootless* ]] && [[ "$info" == *" 2 systemd" ]]; then
    pass rootless-docker "rootless daemon, cgroup v2, systemd driver"
  else
    fail rootless-docker "expected a rootless daemon on cgroup v2 with the systemd driver, got: $info"
  fi

  local memory pids
  memory="$(timeout 180 docker run --rm --memory 64m --pids-limit 64 "$CHECK_IMAGE" \
    cat /sys/fs/cgroup/memory.max 2>/dev/null | tr -d '[:space:]')"
  pids="$(timeout 60 docker run --rm --pids-limit 64 "$CHECK_IMAGE" \
    cat /sys/fs/cgroup/pids.max 2>/dev/null | tr -d '[:space:]')"
  if [ "$memory" = 67108864 ] && [ "$pids" = 64 ]; then
    pass rootless-container-limits "a container started with --memory 64m --pids-limit 64 got them"
  else
    fail rootless-container-limits "memory.max=${memory:-none} pids.max=${pids:-none} (expected 67108864 and 64)"
  fi

  WORK_DIR="$(mktemp -d)"
  cat >"$WORK_DIR/compose.yaml" <<EOF
services:
  probe:
    image: $CHECK_IMAGE
    command: ['sleep', '300']
    healthcheck:
      test: ['CMD', 'true']
      interval: 2s
      retries: 5
EOF
  local project="boundary-check-$$"
  if timeout 180 docker compose -p "$project" -f "$WORK_DIR/compose.yaml" up -d --wait >/dev/null 2>&1 &&
    timeout 120 docker compose -p "$project" -f "$WORK_DIR/compose.yaml" down -v -t 1 >/dev/null 2>&1; then
    pass rootless-compose "a Compose stack started and stopped"
  else
    timeout 60 docker compose -p "$project" -f "$WORK_DIR/compose.yaml" down -v -t 1 >/dev/null 2>&1
    fail rootless-compose "the Compose stack did not start and stop"
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
  api="$(worker_env_value STUDIO_API_URL || true)"
  token="$(worker_env_value STUDIO_WORKER_TOKEN || true)"
  api="${api%/}"
  if [ -z "$api" ] || [ "${#token}" -lt 32 ]; then
    fail worker-token-works "STUDIO_API_URL or STUDIO_WORKER_TOKEN missing in $WORKER_ENV_FILE"
    fail worker-token-nothing-else "not run: no worker token"
    return
  fi
  # A read-only worker route: the states of an unknown Run (changes nothing).
  local body status
  body="{\"workerId\":\"$(random_uuid)\",\"runIds\":[\"$(random_uuid)\"]}"
  status="$(http_status POST "$api/api/worker/runs/states" "$token" "$body")"
  local without
  without="$(http_status POST "$api/api/worker/runs/states" "" "$body")"
  if [ "$status" = 200 ] && [ "$without" = 401 ]; then
    pass worker-token-works "worker route: 200 with the token, 401 without"
  else
    fail worker-token-works "worker route answered ${status:-no answer} with the token and ${without:-no answer} without (expected 200 and 401)"
  fi

  local route accepted=()
  for route in "GET /api/projects" "GET /api/runs" "GET /api/auth/session" "GET /api/providers"; do
    status="$(http_status "${route% *}" "$api${route#* }" "$token")"
    [ "$status" = 401 ] || accepted+=("$route -> ${status:-no answer}")
  done
  if [ "${#accepted[@]}" -gt 0 ]; then
    fail worker-token-nothing-else "not refused with 401: ${accepted[*]}"
  else
    pass worker-token-nothing-else "operator routes refuse the worker token (401)"
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
      -h | --help)
        echo "Usage: $0 [--skip group[,group...]]   groups: ${GROUPS_ALL[*]}"
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
  echo "Isolation boundary checks as $(id -un) on $(uname -sr)"
  for group in "${GROUPS_ALL[@]}"; do
    if [[ ",$SKIP," == *",$group,"* ]]; then
      skip "$group" "skipped on request (--skip)"
      continue
    fi
    "check_${group//-/_}"
  done
  if [ "$FAILED" -gt 0 ]; then
    echo "RESULT: FAIL ($PASSED passed, $FAILED failed, $SKIPPED skipped)"
    exit 1
  fi
  echo "RESULT: PASS ($PASSED passed, $SKIPPED skipped)"
}

main "$@"
