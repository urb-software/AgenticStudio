#!/usr/bin/env bash
# The whole setup on a throwaway Ubuntu 24.04 VM with systemd and cgroup v2 (CI job
# deploy:server, on the GitHub runner, which is discarded afterwards). Never run it on a machine
# you keep: it installs packages, creates the agent user and changes the firewall.
#   sudo bash deploy/tests/vm-tests.sh
# Runs the setup twice (the second run must change nothing), starts Studio's PostgreSQL and
# Redis from the server Compose file, then runs the boundary checks as the agent user. The API
# group is skipped: Studio has no production images yet (the container tests cover the API checks
# against a stub). Every password here is a throwaway test value.
# shellcheck disable=SC2016 # single-quoted text run by another shell
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="$REPO/deploy/setup-server.sh"
# shellcheck source=deploy/tests/lib.sh
. "$REPO/deploy/tests/lib.sh"

[ "$(id -u)" = 0 ] || {
  echo "run as root on a throwaway VM" >&2
  exit 2
}
[ -n "${GITHUB_ACTIONS:-}" ] || [ "${DEPLOY_VM_TESTS:-}" = yes ] || {
  echo "refusing: set DEPLOY_VM_TESTS=yes to confirm this is a throwaway VM" >&2
  exit 2
}

section "Runner preparation (test environment only)"
# The runner image may carry its own apt source for Docker; the setup script refuses a second one.
for file in /etc/apt/sources.list.d/*; do
  [ -f "$file" ] || continue
  if grep -q 'download\.docker\.com' "$file" && [ "$file" != /etc/apt/sources.list.d/docker.sources ]; then
    echo "removing the runner's $file"
    rm -f "$file"
  fi
done
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
if agentic-studio-compose up -d --wait; then ok "postgres and redis are up"; else not_ok "the stack did not start"; fi
agentic-studio-compose ps | sed 's/^/      | /'
expect_false "no host port for PostgreSQL" bash -c "ss -ltnH | grep -q ':5432 '"
expect_false "no host port for Redis" bash -c "ss -ltnH | grep -q ':6379 '"
# Negative control: root reaches them on the container network, so the agent's refusal below
# comes from the boundary, not from a stopped service.
expect_true "root reaches PostgreSQL at its container address" timeout 3 bash -c 'exec 3<>/dev/tcp/172.31.250.10/5432'
expect_true "root reaches Redis at its container address" timeout 3 bash -c 'exec 3<>/dev/tcp/172.31.250.11/6379'

section "Boundary checks as the agent user"
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary --skip api 2>&1)"
status=$?
printf '%s\n' "$out" | sed 's/^/      | /'
if [ "$status" -eq 0 ]; then ok "boundary checks pass (API group skipped)"; else not_ok "boundary checks failed (exit $status)"; fi
for name in not-root not-in-docker-group studio-config-unreadable studio-data-unreadable secrets-unreachable \
  system-docker-unreachable sudo-needs-password studio-postgres-unreachable studio-redis-unreachable no-wsl-escape \
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

agentic-studio-compose down -v >/dev/null 2>&1
finish
