#!/usr/bin/env bash
# The whole setup on a throwaway Ubuntu 24.04 VM with systemd and cgroup v2 (CI job
# deploy:server, on the GitHub runner, which is discarded afterwards). Never run it on a machine
# you keep: it installs packages, creates the agent user and changes the firewall.
#   sudo DEPLOY_VM_TESTS=yes bash deploy/tests/vm-tests.sh
# Runs the setup twice (the second run must change nothing), starts Studio's PostgreSQL and
# Redis from the server Compose file, then runs the boundary checks as the agent user. The API
# group is skipped: Studio has no production images yet (the container tests cover the API checks
# against a stub). Every password here is a throwaway test value.
# shellcheck disable=SC2016 # single-quoted text run by another shell
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The setup script refuses a checkout others can write: run it from a root-owned copy.
SRC=/usr/local/src/agentic-studio
SETUP="$SRC/deploy/setup-server.sh"
# shellcheck source=deploy/tests/lib.sh
. "$REPO/deploy/tests/lib.sh"

[ "$(id -u)" = 0 ] || {
  echo "run as root on a throwaway VM" >&2
  exit 2
}
[ "${DEPLOY_VM_TESTS:-}" = yes ] || {
  echo "refusing: set DEPLOY_VM_TESTS=yes to confirm this is a throwaway VM" >&2
  exit 2
}

section "Runner preparation (test environment only)"
mkdir -p /usr/local/src && cp -a "$REPO" "$SRC" && chown -R root:root "$SRC" && chmod -R go-w "$SRC"
# The runner image may carry its own apt source for Docker; the setup script refuses a second one.
for file in /etc/apt/sources.list.d/*; do
  [ -f "$file" ] || continue
  if grep -q 'download\.docker\.com' "$file" && [ "$file" != /etc/apt/sources.list.d/docker.sources ]; then
    echo "removing the runner's $file"
    rm -f "$file"
  fi
done
# The runner image sets its own user's XDG directories in /etc/environment; the setup script
# refuses that (it would point the agent user's services at the runner user's directories).
pattern='^(XDG_[A-Z_]+|DOCKER_HOST|DOCKER_CONFIG)='
if grep -Eq "$pattern" /etc/environment; then
  grep -Eo "$pattern" /etc/environment | sed 's/^/removing from \/etc\/environment: /'
  sed -i -E "/$pattern/d" /etc/environment
fi
if command -v docker >/dev/null; then docker version --format 'existing system Docker {{.Server.Version}}' || true; fi

section "First run (every step)"
first="$(bash "$SETUP" 2>&1)"
status=$?
printf '%s\n' "$first" | sed 's/^/      | /'
if [ "$status" -eq 0 ]; then ok "first run succeeded"; else not_ok "first run failed (exit $status)"; fi

section "Second run (nothing to change)"
second="$(bash "$SETUP" 2>&1)"
status=$?
printf '%s\n' "$second" | sed 's/^/      | /'
if [ "$status" -eq 0 ]; then ok "second run succeeded"; else not_ok "second run failed (exit $status)"; fi
expect_line "second run changed nothing" "$second" '^Done: 0 change\(s\)\.$'
expect_line "rootless Docker reported unchanged" "$second" '^\[rootless\] unchanged'

uid="$(id -u agent)"
as_agent() {
  (cd / && runuser -u agent -- env -i HOME=/home/agent USER=agent LOGNAME=agent PATH=/usr/local/bin:/usr/bin:/bin \
    XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@")
}

section "State"
expect_false "agent user is not in the docker group" bash -c "id -nG agent | tr ' ' '\n' | grep -qx docker"
expect_true "linger is on for the agent user" bash -c '[ "$(loginctl show-user agent -p Linger --value)" = yes ]'
expect_true "rootless Docker runs as the agent user's service" as_agent systemctl --user is-active docker.service
expect_true "the worker service is enabled for the agent user" as_agent systemctl --user is-enabled agentic-studio-worker.service
expect_false "the worker is not started without its token" as_agent systemctl --user is-active agentic-studio-worker.service
expect_true "the firewall service is active" systemctl is-active agentic-studio-agent-firewall.service
expect_true "the firewall rule is in OUTPUT" iptables -w -C OUTPUT -m owner --uid-owner "$uid" -j AGENTIC-STUDIO-AGENT
expect_true "the system Docker daemon runs" systemctl is-active docker.service
systemctl show "user-$uid.slice" -p MemoryMax -p TasksMax -p CPUWeight | sed 's/^/      | /'
as_agent docker info --format 'rootless daemon: {{json .SecurityOptions}} cgroup v{{.CgroupVersion}} {{.CgroupDriver}}' |
  sed 's/^/      | /'

section "Studio's PostgreSQL and Redis from the server Compose file"
sed -i "s|^POSTGRES_PASSWORD=$|POSTGRES_PASSWORD=$(openssl rand -hex 16)|" /etc/agentic-studio/.env
sed -i "s|^REDIS_PASSWORD=$|REDIS_PASSWORD=$(openssl rand -hex 16)|" /etc/agentic-studio/.env
if agentic-studio-compose up -d --wait; then ok "postgres and redis are up"; else not_ok "the stack did not start"; fi
agentic-studio-compose ps | sed 's/^/      | /'
expect_false "no host port for PostgreSQL" bash -c "ss -ltnH | grep -q ':5432 '"
expect_false "no host port for Redis" bash -c "ss -ltnH | grep -q ':6379 '"
# Negative control: root reaches them on the container network, so the agent's refusal below
# comes from the boundary, not from a stopped service.
expect_true "root reaches PostgreSQL at its container address" timeout 3 bash -c 'exec 3<>/dev/tcp/172.31.250.10/5432'
expect_true "root reaches Redis at its container address" timeout 3 bash -c 'exec 3<>/dev/tcp/172.31.250.11/6379'
reply="$(timeout 5 bash -c 'exec 3<>/dev/tcp/172.31.250.11/6379; printf "PING\r\n" >&3; read -r -t 3 line <&3; printf "%s" "$line"')"
expect_line "Redis refuses an unauthenticated command" "$reply" 'NOAUTH'
expect_true "Redis answers with its password" \
  agentic-studio-compose exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping | grep -q PONG'
sed -n 's/^REDIS_PASSWORD=//p' /etc/agentic-studio/.env >/root/redis-password.test
expect_false "the Redis password is on no host command line" \
  bash -c "grep -qF -f /root/redis-password.test /proc/[0-9]*/cmdline"
rm -f /root/redis-password.test

# No Studio images yet: a stand-in for the API's public health route on the published API port
# is the positive control (the real API answers there once the images exist, #130).
health_stub() {
  /usr/local/bin/node -e "require('node:http').createServer((q, r) => {
    r.writeHead(q.url === '/api/health' ? 200 : 404); r.end(); }).listen(3001, '127.0.0.1')" &
  HEALTH_PID=$!
  sleep 1
}

section "Boundary checks as the agent user"
health_stub
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary --skip api 2>&1)"
status=$?
printf '%s\n' "$out" | sed 's/^/      | /'
if [ "$status" -eq 0 ]; then ok "boundary checks pass (API group skipped)"; else not_ok "boundary checks failed (exit $status)"; fi
for name in not-root not-in-docker-group studio-config-unreadable studio-data-unreadable secrets-unreachable \
  system-docker-unreachable system-containerd-unreachable sudo-needs-password studio-stack-running \
  studio-postgres-unreachable studio-redis-unreachable no-wsl-escape \
  cgroup-v2 agent-user-limits rootless-docker rootless-container-limits rootless-compose; do
  expect_line "PASS $name" "$out" "^PASS  $name "
done

section "Breaking the boundary is caught"
usermod -aG docker agent
expect_fail "the setup script refuses the agent user in the docker group" "is in the docker group" bash "$SETUP" --only preflight
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary --skip rootless,api 2>&1)"
expect_line "docker group -> FAIL not-in-docker-group" "$out" '^FAIL  not-in-docker-group '
expect_line "docker group -> FAIL system-docker-unreachable" "$out" '^FAIL  system-docker-unreachable '
gpasswd -d agent docker >/dev/null

/usr/local/sbin/agentic-studio-agent-firewall remove
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary --skip rootless,api 2>&1)"
expect_line "no firewall rule -> FAIL studio-postgres-unreachable" "$out" '^FAIL  studio-postgres-unreachable '
/usr/local/sbin/agentic-studio-agent-firewall apply
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary --skip rootless,api 2>&1)"
expect_line "firewall rule back -> PASS studio-postgres-unreachable" "$out" '^PASS  studio-postgres-unreachable '

kill "$HEALTH_PID"
wait "$HEALTH_PID" 2>/dev/null
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary --skip rootless,api 2>&1)"
expect_line "Studio not answering -> FAIL studio-stack-running" "$out" '^FAIL  studio-stack-running '
expect_line "... and the run fails" "$(tail -n 1 <<<"$out")" '^RESULT: FAIL '

section "The agent side never runs without its firewall"
agent_side_down() {
  ! systemctl is-active --quiet "user@$uid.service" && ! pgrep -u agent >/dev/null
}
wait_for() {
  local _
  for _ in $(seq 1 30); do "$@" && return 0; sleep 1; done
  return 1
}
agent_side_up() {
  systemctl is-active --quiet "user@$uid.service" && as_agent systemctl --user is-active --quiet docker.service
}

systemctl stop agentic-studio-agent-firewall.service
expect_true "firewall stopped -> the agent user's manager and every agent process stop" wait_for agent_side_down

firewall=/usr/local/sbin/agentic-studio-agent-firewall
cp -p "$firewall" "$firewall.test-backup"
printf '#!/bin/sh\nexit 1\n' >"$firewall"
expect_false "firewall failing -> the agent user's manager cannot start" systemctl start "user@$uid.service"
expect_true "... and nothing of the agent side runs" agent_side_down
mv "$firewall.test-backup" "$firewall"

expect_true "starting the agent side starts its firewall first" systemctl start "user@$uid.service"
expect_true "... the firewall is active" systemctl is-active --quiet agentic-studio-agent-firewall.service
expect_true "... rootless Docker is back" wait_for agent_side_up

# Rules flushed behind systemd's back: the verify timer's service stops the agent side.
"$firewall" remove
systemctl start agentic-studio-agent-firewall-verify.service
expect_false "rules missing -> the verify run stops the firewall unit" \
  systemctl is-active --quiet agentic-studio-agent-firewall.service
expect_true "... and the agent side with it" wait_for agent_side_down
expect_true "the verify timer is active" systemctl is-active --quiet agentic-studio-agent-firewall-verify.timer
systemctl start "user@$uid.service"
expect_true "restarting the agent side restores the rules" "$firewall" verify

agentic-studio-compose down -v >/dev/null 2>&1
finish
