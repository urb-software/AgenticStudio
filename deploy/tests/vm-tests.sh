#!/usr/bin/env bash
# The whole setup on a throwaway Ubuntu 24.04 VM with systemd and cgroup v2 (CI job
# deploy:server, on the GitHub runner, which is discarded afterwards). Never run it on a machine
# you keep: it installs packages, creates the agent user and changes the firewall.
#   sudo DEPLOY_VM_TESTS=yes bash deploy/tests/vm-tests.sh
# Runs the setup twice (the second run must change nothing), starts Studio's PostgreSQL and
# Redis from the server Compose file, builds the API and web production images (Issue #132) and
# starts the whole stack with them (migrations, API, web, reverse proxy), checks the login rate
# limit per client through the proxy, then runs every boundary check as the agent user, the `api`
# group included. Every password, key and token here is a throwaway test value; the domain is a
# reserved test name served with Caddy's internal CA.
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
expect_line "managed guardrails reported ok" "$second" '^\[guardrails\] ok '

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

section "Production images (apps/api/Dockerfile, apps/web/Dockerfile)"
API_IMAGE=agentic-studio/api:ci
WEB_IMAGE=agentic-studio/web:ci
build_image() {
  local log
  log="$(mktemp)"
  if docker build -f "$SRC/$1" -t "$2" "$SRC" >"$log" 2>&1; then
    ok "built $2 from $1"
  else
    not_ok "building $2 from $1 failed:"
    tail -n 80 "$log" | sed 's/^/      | /'
  fi
  rm -f "$log"
}
build_image apps/api/Dockerfile "$API_IMAGE"
build_image apps/web/Dockerfile "$WEB_IMAGE"
for image in "$API_IMAGE" "$WEB_IMAGE"; do
  expect_true "$image runs as 10001:10001" bash -c "[ \"\$(docker image inspect -f '{{.Config.User}}' $image)\" = 10001:10001 ]"
  found="$(docker run --rm --network none --user 10001:10001 --entrypoint sh "$image" -c \
    "find / -xdev \( -name .env -o -name '.env.*' \) ! -name '*.example' 2>/dev/null")"
  expect_line "$image holds no .env file" "${found:-none}" '^none$'
done

section "Studio's web, API and reverse proxy from the production images"
ENV_FILE=/etc/agentic-studio/.env
WORKER_ENV=/home/agent/.config/agentic-studio-worker/.env
DOMAIN=studio.example.test
# set_env <file> <name> <value>: replaces the variable's line (test values only).
set_env() {
  sed -i "/^$2=/d" "$1"
  printf '%s=%s\n' "$2" "$3" >>"$1"
}
POSTGRES_PASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$ENV_FILE")"
REDIS_PASSWORD="$(sed -n 's/^REDIS_PASSWORD=//p' "$ENV_FILE")"
OPERATOR_PASSWORD="$(openssl rand -hex 16)"
WORKER_TOKEN="$(openssl rand -hex 24)"
hash="$(printf '%s\n' "$OPERATOR_PASSWORD" | docker run --rm -i --network none "$API_IMAGE" node dist/platform/auth/hash-password.js | tail -n 1)"
expect_line "the API image hashes the operator password (auth:hash-password)" "$hash" '^\$argon2id\$'
set_env "$ENV_FILE" STUDIO_API_IMAGE "$API_IMAGE"
set_env "$ENV_FILE" STUDIO_WEB_IMAGE "$WEB_IMAGE"
set_env "$ENV_FILE" STUDIO_DOMAIN "$DOMAIN"
set_env "$ENV_FILE" STUDIO_TLS internal
set_env "$ENV_FILE" DATABASE_URL "postgresql://studio:$POSTGRES_PASSWORD@postgres:5432/agentic_studio"
set_env "$ENV_FILE" REDIS_URL "redis://:$REDIS_PASSWORD@redis:6379"
set_env "$ENV_FILE" STUDIO_OPERATOR_PASSWORD_HASH "'$hash'"
set_env "$ENV_FILE" STUDIO_SECRETS_KEY "$(openssl rand -base64 32)"
set_env "$ENV_FILE" STUDIO_WORKER_TOKEN "$WORKER_TOKEN"
# A value in .env that must not win: the Compose file fixes the trusted proxy.
set_env "$ENV_FILE" API_TRUSTED_PROXIES 172.31.250.1
as_agent sed -i "s|^STUDIO_WORKER_TOKEN=.*|STUDIO_WORKER_TOKEN=$WORKER_TOKEN|" "$WORKER_ENV"
expect_true "the worker reaches the API through the proxy's worker port" \
  grep -qx 'STUDIO_API_URL=http://172.31.250.20:8080' "$WORKER_ENV"

if agentic-studio-compose up -d --wait; then
  ok "the whole stack is up (migrations, API, web, reverse proxy)"
else
  not_ok "the whole stack did not start"
  agentic-studio-compose logs --no-color --tail 60 migrate api web proxy 2>&1 | sed 's/^/      | /'
fi
agentic-studio-compose ps -a | sed 's/^/      | /'
migrate="$(agentic-studio-compose ps -a -q migrate)"
expect_true "the migrate service ran and exited 0" \
  bash -c "[ \"\$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' $migrate)\" = 'exited 0' ]"
expect_line "the migrations were applied" "$(docker logs "$migrate" 2>&1)" 'migrations? (have been successfully applied|found in prisma/migrations)'
for service in api web proxy; do
  container="$(agentic-studio-compose ps -q "$service")"
  expect_true "$service runs as 10001:10001" bash -c "[ \"\$(docker inspect -f '{{.Config.User}}' $container)\" = 10001:10001 ]"
  # docker top needs the PID column; the second column is the uid.
  uids="$(docker top "$container" -eo pid,uid | awk 'NR > 1 { print $2 }' | sort -u | tr '\n' ' ')"
  expect_line "every $service process runs as uid 10001" "$uids" '^10001 $'
  expect_true "$service has a read-only root filesystem" bash -c "[ \"\$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' $container)\" = true ]"
done
api="$(agentic-studio-compose ps -q api)"
expect_line "the API trusts X-Forwarded-For from the proxy only" \
  "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$api" | grep '^API_TRUSTED_PROXIES=')" '^API_TRUSTED_PROXIES=172\.31\.250\.20$'
ss -ltnH | sed 's/^/      | /'
expect_true "the proxy publishes port 443 on IPv4" bash -c "ss -ltnH | grep -Eq '0\.0\.0\.0:443 '"
expect_true "the proxy publishes port 80 on IPv4" bash -c "ss -ltnH | grep -Eq '0\.0\.0\.0:80 '"
expect_false "nothing on IPv6 port 443" bash -c "ss -ltnH | grep -Eq '\]:443 '"
expect_false "no host port for the API" bash -c "ss -ltnH | grep -q ':3001 '"
expect_false "no host port for the web app" bash -c "ss -ltnH | grep -q ':3000 '"

# The operator stands for a client from outside: the server's own address on its network
# interface, a different source address than the agent user's (the gateway of Studio's network).
HOST_IP="$(ip -4 route get 192.0.2.1 | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }')"
public() { curl -sk --max-time 10 --resolve "$DOMAIN:443:$HOST_IP" --resolve "$DOMAIN:80:$HOST_IP" "$@"; }
public_status() { public -o /dev/null -w '%{http_code}' "$@"; }
expect_line "https://$DOMAIN/api/health answers 200 through the proxy" "$(public_status "https://$DOMAIN/api/health")" '^200$'
expect_line "https://$DOMAIN/login (web) answers 200 through the proxy" "$(public_status "https://$DOMAIN/login")" '^200$'
expect_line "http://$DOMAIN redirects to https" "$(public_status "http://$DOMAIN/login")" '^30[18]$'

section "Login rate limit: one bucket per client through the proxy"
login_body() { printf '{"password":"%s"}' "$1"; }
agent_login() {
  as_agent curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
    -H "Origin: https://$DOMAIN" -H 'Content-Type: application/json' "$@" \
    --data "$(login_body wrong-password-for-test)" http://172.31.250.20:8080/api/auth/login
}
codes=""
for _ in 1 2 3 4 5; do codes+="$(agent_login) "; done
expect_line "the agent user's 5 failed logins get 401" "$codes" '^401 401 401 401 401 $'
expect_line "its 6th gets 429 (its own bucket is full)" "$(agent_login)" '^429$'
expect_line "a forged X-Forwarded-For does not give it a fresh bucket" \
  "$(agent_login -H 'X-Forwarded-For: 198.51.100.7')" '^429$'
operator_login() {
  public -o /dev/null -w '%{http_code}' -X POST -H "Origin: https://$DOMAIN" \
    -H 'Content-Type: application/json' --data "$(login_body "$1")" "https://$DOMAIN/api/auth/login"
}
expect_line "the operator's failed login still gets 401, not 429" "$(operator_login wrong-password-for-test)" '^401$'
expect_line "the operator still signs in" "$(operator_login "$OPERATOR_PASSWORD")" '^200$'
cookie="$(public -D - -o /dev/null -X POST -H "Origin: https://$DOMAIN" -H 'Content-Type: application/json' \
  --data "$(login_body "$OPERATOR_PASSWORD")" "https://$DOMAIN/api/auth/login" | grep -i '^set-cookie:' | tr '[:upper:]' '[:lower:]')"
expect_line "the session cookie is Secure (https origin)" "$cookie" '; *secure'
expect_line "the session cookie is HttpOnly" "$cookie" '; *httponly'

section "Boundary checks as the agent user (every group, the API against the real stack)"
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary 2>&1)"
status=$?
printf '%s\n' "$out" | sed 's/^/      | /'
if [ "$status" -eq 0 ]; then ok "boundary checks pass"; else not_ok "boundary checks failed (exit $status)"; fi
expect_line "nothing skipped: RESULT: PASS" "$(tail -n 1 <<<"$out")" '^RESULT: PASS \('
expect_false "no SKIP line" grep -q '^SKIP' <<<"$out"
for name in not-root not-in-docker-group processes-in-user-manager no-studio-container-as-agent \
  studio-config-unreadable studio-data-unreadable secrets-unreachable \
  system-docker-unreachable system-containerd-unreachable sudo-needs-password studio-stack-running \
  studio-postgres-unreachable studio-redis-unreachable studio-app-direct-unreachable no-wsl-escape \
  cgroup-v2 agent-user-limits rootless-docker rootless-container-limits rootless-compose \
  worker-token-works worker-token-nothing-else managed-guardrails managed-guardrails-locked; do
  expect_line "PASS $name" "$out" "^PASS  $name "
done

section "Managed guardrails (Issue #134): the agent user cannot write or replace them"
for file in /etc/claude-code/managed-settings.json /etc/codex/managed_config.toml /etc/codex/requirements.toml \
  /usr/local/lib/agentic-studio/guardrails/claude-guard.mjs; do
  expect_stat "$file" root:root 644
  expect_false "agent user cannot write $file" as_agent sh -c "echo '# planted' >> '$file'"
  expect_false "agent user cannot replace $file" as_agent sh -c "printf '{}' > '$file.agent' && mv -f '$file.agent' '$file'"
  expect_false "agent user cannot remove $file" as_agent rm -f "$file"
done
expect_false "agent user cannot add a Claude Code managed drop-in" as_agent mkdir /etc/claude-code/managed-settings.d
expect_false "agent user cannot add a file next to the guard script" \
  as_agent touch /usr/local/lib/agentic-studio/guardrails/planted.mjs
# Negative case: a changed file is caught by the boundary check, and the setup step restores it.
ONLY_GUARDRAILS=(--skip 'identity,processes,studio-files,docker-socket,sudo,studio-network,host,cgroup,rootless,api')
printf '\n' >>/etc/claude-code/managed-settings.json
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary "${ONLY_GUARDRAILS[@]}" 2>&1)"
expect_line "changed managed settings -> FAIL managed-guardrails" "$out" '^FAIL  managed-guardrails .*managed-settings\.json differs'
out="$(bash "$SETUP" --only guardrails 2>&1)"
expect_line "the guardrails step reinstalls it" "$out" '^\[guardrails\] changed: /etc/claude-code/managed-settings\.json'
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary "${ONLY_GUARDRAILS[@]}" 2>&1)"
expect_line "reinstalled -> PASS managed-guardrails" "$out" '^PASS  managed-guardrails '
# Review L1 of #136: a drop-in the CLI would merge into the managed policy is caught.
mkdir /etc/claude-code/managed-settings.d
echo '{"permissions":{"allow":["Bash(sudo:*)"]}}' >/etc/claude-code/managed-settings.d/50-foreign.json
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary "${ONLY_GUARDRAILS[@]}" 2>&1)"
expect_line "a managed-settings.d drop-in -> FAIL managed-guardrails" "$out" '^FAIL  managed-guardrails .*managed-settings\.d must not exist'
rm -rf /etc/claude-code/managed-settings.d
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary "${ONLY_GUARDRAILS[@]}" 2>&1)"
expect_line "removed -> PASS managed-guardrails" "$out" '^PASS  managed-guardrails '

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
expect_line "no firewall rule -> FAIL studio-app-direct-unreachable" "$out" '^FAIL  studio-app-direct-unreachable '
/usr/local/sbin/agentic-studio-agent-firewall apply
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary --skip rootless,api 2>&1)"
expect_line "firewall rule back -> PASS studio-postgres-unreachable" "$out" '^PASS  studio-postgres-unreachable '
expect_line "firewall rule back -> PASS studio-app-direct-unreachable" "$out" '^PASS  studio-app-direct-unreachable '

agentic-studio-compose stop api >/dev/null 2>&1
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary --skip rootless,api 2>&1)"
expect_line "API stopped -> FAIL studio-stack-running" "$out" '^FAIL  studio-stack-running '
expect_line "... and the run fails" "$(tail -n 1 <<<"$out")" '^RESULT: FAIL '

section "Nothing of the agent user runs outside its user manager"
expect_true "agent user has uid and gid 2001" bash -c '[ "$(id -u agent):$(id -g agent)" = 2001:2001 ]'
expect_true "logind kills the agent user's session processes" \
  bash -c 'busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillOnlyUsers | grep -q "\"agent\""'
if command -v crontab >/dev/null; then
  expect_fail "cron refuses the agent user" "not allowed" bash -c "echo '* * * * * true' | runuser -u agent -- crontab -"
else
  expect_true "agent user is in /etc/cron.deny (no cron installed)" grep -qx agent /etc/cron.deny
fi
expect_true "agent user is in /etc/at.deny" grep -qx agent /etc/at.deny
if [ -x /usr/sbin/sshd ]; then
  expect_true "sshd denies the agent user" \
    bash -c "/usr/sbin/sshd -T -C user=agent,host=client.invalid,addr=192.0.2.1 | grep -qix 'denyusers agent'"
fi
ONLY_PROCESSES=(--skip 'identity,studio-files,docker-socket,sudo,studio-network,host,cgroup,rootless,api')
systemd-run --quiet --uid=agent --unit=agent-stray-test sleep 300
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary "${ONLY_PROCESSES[@]}" 2>&1)"
expect_line "a system service as the agent user -> FAIL processes-in-user-manager" "$out" '^FAIL  processes-in-user-manager '
systemctl stop agent-stray-test.service
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary "${ONLY_PROCESSES[@]}" 2>&1)"
expect_line "stopped -> PASS processes-in-user-manager" "$out" '^PASS  processes-in-user-manager '
docker run -d --quiet --name agent-uid-test --user 2001:2001 busybox:1.37 sleep 300 >/dev/null
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary "${ONLY_PROCESSES[@]}" 2>&1)"
expect_line "a system container as the agent's uid -> FAIL no-studio-container-as-agent" "$out" '^FAIL  no-studio-container-as-agent '
docker rm -f agent-uid-test >/dev/null
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary "${ONLY_PROCESSES[@]}" 2>&1)"
expect_line "removed -> PASS no-studio-container-as-agent" "$out" '^PASS  no-studio-container-as-agent '

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
