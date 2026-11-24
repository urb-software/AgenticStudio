#!/usr/bin/env bash
# The whole setup on a throwaway Ubuntu 24.04 VM with systemd and cgroup v2 (CI job
# deploy:server, on the GitHub runner, which is discarded afterwards). Never run it on a machine
# you keep: it installs packages, creates the agent user and changes the firewall.
#   sudo DEPLOY_VM_TESTS=yes bash deploy/tests/vm-tests.sh
# Runs the setup twice (the second run must change nothing), starts Studio's PostgreSQL and
# Redis from the server Compose file, builds the API and web production images (Issue #132) and
# starts the whole stack with them (migrations, API, web, reverse proxy), checks the login rate
# limit per client through the proxy, then runs every boundary check as the agent user, the `api`
# group included. The Preview side is covered too: its checks as the Preview user, a
# third user refused both users' sockets and data-roots, and one real build by the controller in
# the Preview user's rootless daemon, served through the proxy. Every password, key and token here is a throwaway test value; the domain is a
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
expect_line "Preview rootless Docker reported unchanged" "$second" '^\[preview-rootless\] unchanged'
expect_line "managed guardrails reported ok" "$second" '^\[guardrails\] ok '

uid="$(id -u agent)"
as_agent() {
  (cd / && runuser -u agent -- env -i HOME=/home/agent USER=agent LOGNAME=agent PATH=/usr/local/bin:/usr/bin:/bin \
    XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@")
}

puid="$(id -u preview)"
as_preview() {
  (cd / && runuser -u preview -- env -i HOME=/home/preview USER=preview LOGNAME=preview PATH=/usr/local/bin:/usr/bin:/bin \
    XDG_RUNTIME_DIR="/run/user/$puid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$puid/bus" "$@")
}
check_preview() { as_preview /usr/local/bin/agentic-studio-check-preview "$@" 2>&1; }

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
expect_true "Preview user has uid and gid 2002" bash -c '[ "$(id -u preview):$(id -g preview)" = 2002:2002 ]'
expect_false "Preview user is not in the docker group" bash -c "id -nG preview | tr ' ' '\n' | grep -qx docker"
expect_true "linger is on for the Preview user" bash -c '[ "$(loginctl show-user preview -p Linger --value)" = yes ]'
expect_true "rootless Docker runs as the Preview user's service" as_preview systemctl --user is-active docker.service
expect_true "the controller service is enabled for the Preview user" as_preview systemctl --user is-enabled agentic-studio-controller.service
expect_false "the controller is not started without its token" as_preview systemctl --user is-active agentic-studio-controller.service
expect_true "the Preview firewall service is active" systemctl is-active agentic-studio-preview-firewall.service
expect_true "the Preview firewall rule is in OUTPUT" iptables -w -C OUTPUT -m owner --uid-owner "$puid" -j AGENTIC-STUDIO-PREVIEW
expect_stat /run/preview-proxy preview:previewproxy 2750
expect_stat /usr/local/lib/agentic-studio/preview-egress-rules root:root 755
expect_true "the tmpfiles.d entry for the socket directory exists" \
  grep -qx 'd /run/preview-proxy 2750 preview previewproxy -' /etc/tmpfiles.d/agentic-studio-preview-proxy.conf
expect_true "the docker.service drop-in applies the egress rules and keeps the daemon up on an OOM" \
  bash -c "grep -q 'ExecStartPost=/usr/local/lib/agentic-studio/preview-egress-rules apply' /home/preview/.config/systemd/user/docker.service.d/60-agentic-studio-egress.conf && grep -qx 'OOMPolicy=continue' /home/preview/.config/systemd/user/docker.service.d/60-agentic-studio-egress.conf"
expect_true "the Preview user's slice has its limits" bash -c "[ \"\$(systemctl show user-$puid.slice -p TasksMax --value)\" = 4096 ]"
expect_true "the user manager delegates cpu, memory and pids" \
  bash -c "c=\"\$(cat /sys/fs/cgroup/user.slice/user-$puid.slice/user@$puid.service/cgroup.controllers)\"; [[ \" \$c \" == *' cpu '* && \" \$c \" == *' memory '* && \" \$c \" == *' pids '* ]]"
expect_true "the egress rules verify inside the Preview daemon's namespace" \
  as_preview nsenter -U --preserve-credentials -n -t "$(cat "/run/user/$puid/dockerd-rootless/child_pid")" \
  /usr/local/lib/agentic-studio/preview-egress-rules verify
expect_true "Studio's own firewall for the agent user is unchanged: active" systemctl is-active agentic-studio-agent-firewall.service

section "A third user is refused both users' sockets and data-roots"
useradd --create-home --uid 2999 --shell /bin/bash thirduser
third() { (cd / && runuser -u thirduser -- env -i HOME=/home/thirduser PATH=/usr/local/bin:/usr/bin:/bin "$@"); }
for who in agent preview; do
  case "$who" in agent) id_of=$uid ;; *) id_of=$puid ;; esac
  sock="/run/user/$id_of/docker.sock"
  expect_true "the $who's socket exists (control)" test -S "$sock"
  expect_false "the third user cannot reach the $who's socket" third curl -fsS --max-time 3 --unix-socket "$sock" http://localhost/_ping
  expect_false "the third user cannot list the $who's data-root" third ls "/home/$who/.local/share/docker"
done
expect_true "the agent reaches its own socket (control)" as_agent curl -fsS --max-time 5 --unix-socket "/run/user/$uid/docker.sock" http://localhost/_ping
expect_true "the Preview user reaches its own socket (control)" as_preview curl -fsS --max-time 5 --unix-socket "/run/user/$puid/docker.sock" http://localhost/_ping
expect_false "the agent cannot reach the Preview user's socket" as_agent curl -fsS --max-time 3 --unix-socket "/run/user/$puid/docker.sock" http://localhost/_ping
expect_false "the Preview user cannot reach the agent's socket" as_preview curl -fsS --max-time 3 --unix-socket "/run/user/$uid/docker.sock" http://localhost/_ping
expect_false "the agent cannot list the Preview user's data-root" as_agent ls /home/preview/.local/share/docker
expect_false "the Preview user cannot list the agent's data-root" as_preview ls /home/agent/.local/share/docker
userdel -r thirduser 2>/dev/null

section "Preview checks as the Preview user (before the controller token is set)"
out="$(check_preview --skip api)"
status=$?
printf '%s\n' "$out" | sed 's/^/      | /'
if [ "$status" -eq 0 ]; then ok "the Preview checks pass (token checks wait for the token)"; else not_ok "the Preview checks failed (exit $status)"; fi
expect_false "no FAIL line" grep -q '^FAIL' <<<"$out"
for name in not-root not-privileged sudo-needs-password home-private linger system-docker-unreachable \
  agent-docker-unreachable agent-files-unreadable studio-files-unreadable studio-network-unreachable \
  cgroup-v2 cgroup-delegation preview-user-limits slice-limit-bites build-memory-limit \
  egress-script-root-owned rootless-docker daemon-dns egress-rules-verify egress-blocked-build-step \
  egress-blocked-compose-network internet-https controller-unit-enabled controller-env-file \
  controller-data-dir controller-settings preview-proxy-dir controller-free-disk; do
  expect_line "PASS $name" "$out" "^PASS  $name "
done
expect_line "SKIP controller-active until the token is set" "$out" '^SKIP  controller-active '

section "Egress rules: control, and again after the daemon restarts"
# A root listener on the host's address stands in for any host service; the rules, not the
# listener, keep Preview containers away from it.
HOST_ADDR="$(ip -4 route get 192.0.2.1 | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }')"
socat TCP-LISTEN:29191,reuseaddr,fork /dev/null &
LISTENER=$!
sleep 1
expect_true "control: root reaches the listener on the host's address" timeout 3 bash -c "exec 3<>/dev/tcp/$HOST_ADDR/29191"
expect_false "a Preview container does not reach the host's address" \
  as_preview docker run --rm busybox:1.37 sh -c "nc -w 3 $HOST_ADDR 29191 </dev/null"
expect_false "a Preview container does not reach the host's loopback through 10.0.2.2" \
  as_preview docker run --rm busybox:1.37 sh -c "nc -w 3 10.0.2.2 29191 </dev/null"
as_preview systemctl --user restart docker.service
wait_for_preview_daemon() { as_preview docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; }
wait_for() {
  local _
  for _ in $(seq 1 30); do "$@" && return 0; sleep 1; done
  return 1
}
expect_true "the Preview daemon is back after a restart" wait_for wait_for_preview_daemon
expect_true "the rules are applied again in the new namespace (ExecStartPost)" \
  as_preview nsenter -U --preserve-credentials -n -t "$(cat "/run/user/$puid/dockerd-rootless/child_pid")" \
  /usr/local/lib/agentic-studio/preview-egress-rules verify
expect_false "after the restart a container still does not reach the host's address" \
  as_preview docker run --rm busybox:1.37 sh -c "nc -w 3 $HOST_ADDR 29191 </dev/null"
kill "$LISTENER" 2>/dev/null
wait "$LISTENER" 2>/dev/null

section "Units do not start while their token is empty"
# Both units are enabled and their tokens are still empty: after the user managers restart (as at
# boot) the services are inactive because their ExecCondition failed, not failed or restarting.
systemctl restart "user@$uid.service" "user@$puid.service"
agent_docker_up() { as_agent systemctl --user is-active --quiet docker.service; }
preview_docker_up() { as_preview systemctl --user is-active --quiet docker.service; }
expect_true "the agent's rootless Docker is back" wait_for agent_docker_up
expect_true "the Preview user's rootless Docker is back" wait_for preview_docker_up
sleep 5
for pair in "agent:agentic-studio-worker.service" "preview:agentic-studio-controller.service"; do
  who="${pair%%:*}"
  unit="${pair#*:}"
  state="$(runuser -u "$who" -- env -i XDG_RUNTIME_DIR="/run/user/$(id -u "$who")" systemctl --user show "$unit" -p ActiveState -p ExecCondition 2>&1)"
  expect_line "$unit is inactive with an empty token" "$state" '^ActiveState=inactive$'
  expect_line "... because its ExecCondition exited with status 1" "$state" 'status=1'
  expect_false "... and it is not failed" runuser -u "$who" -- env -i XDG_RUNTIME_DIR="/run/user/$(id -u "$who")" systemctl --user is-failed --quiet "$unit"
done

section "State (continued)"
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

section "Preview site of the reverse proxy: domain, hash, wildcard certificate"
PREVIEW_DOMAIN=preview.example.test
PREVIEW_LABEL=preview-aaaaaaaaaaaa
PREVIEW_HOST="$PREVIEW_LABEL.$PREVIEW_DOMAIN"
PREVIEW_PASSWORD="$(openssl rand -hex 16)"
PROXY_IMAGE="$(agentic-studio-compose config --images | grep '^caddy:' | head -n 1)"
preview_hash="$(docker run --rm --network none "$PROXY_IMAGE" caddy hash-password --plaintext "$PREVIEW_PASSWORD")"
expect_line "caddy hash-password gives a bcrypt hash" "$preview_hash" '^\$2[aby]\$'
# The operator's wildcard certificate: a throwaway one here, in the directory the setup made for
# the proxy's data (owner 10001, 0700), files 0600.
tls_dir=/var/lib/agentic-studio/proxy/preview-tls
install -d -o 10001 -g 10001 -m 0700 "$tls_dir"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 2 \
  -subj "/CN=$PREVIEW_DOMAIN" -addext "subjectAltName=DNS:*.$PREVIEW_DOMAIN" \
  -keyout "$tls_dir/privkey.pem" -out "$tls_dir/fullchain.pem" 2>/dev/null
chown 10001:10001 "$tls_dir/privkey.pem" "$tls_dir/fullchain.pem" && chmod 0600 "$tls_dir/privkey.pem" "$tls_dir/fullchain.pem"
set_env "$ENV_FILE" STUDIO_PREVIEW_DOMAIN "$PREVIEW_DOMAIN"
set_env "$ENV_FILE" STUDIO_PREVIEW_PASSWORD_HASH "'$preview_hash'"
if agentic-studio-compose up -d --wait; then
  ok "the stack is up with the Preview site (the wrapper added the overlay)"
else
  not_ok "the stack did not start with the Preview site"
  agentic-studio-compose logs --no-color --tail 60 api proxy 2>&1 | sed 's/^/      | /'
fi
proxy="$(agentic-studio-compose ps -q proxy)"
expect_line "the proxy has the preview group" \
  "$(docker inspect -f '{{.HostConfig.GroupAdd}}' "$proxy")" '^\[2003\]$'
expect_line "the socket directory is mounted read-only" \
  "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/preview-proxy"}}{{.RW}}{{end}}{{end}}' "$proxy")" '^false$'
expect_line "the proxy still runs as uid 10001 on a read-only root filesystem" \
  "$(docker inspect -f '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}' "$proxy")" '^10001:10001 true$'
preview_status() { curl -sk --max-time 10 --resolve "$PREVIEW_HOST:443:$HOST_IP" -o /dev/null -w '%{http_code}' "$@"; }
expect_line "Studio's host still answers 200" "$(public_status "https://$DOMAIN/api/health")" '^200$'
expect_line "a Preview host asks for the password: 401" "$(preview_status "https://$PREVIEW_HOST/")" '^401$'
expect_line "a wrong password: 401" "$(preview_status -u "preview:wrong-$PREVIEW_PASSWORD" "https://$PREVIEW_HOST/")" '^401$'
expect_line "with the password and no socket: 404" "$(preview_status -u "preview:$PREVIEW_PASSWORD" "https://$PREVIEW_HOST/")" '^404$'
expect_line "the 404 says the Preview is not running" \
  "$(curl -sk --max-time 10 --resolve "$PREVIEW_HOST:443:$HOST_IP" -u "preview:$PREVIEW_PASSWORD" "https://$PREVIEW_HOST/")" '^This Preview is not running\.$'

section "Controller token on both sides: the controller runs and claim answers 204"
CONTROLLER_TOKEN="$(openssl rand -hex 24)"
CONTROLLER_ENV=/home/preview/.config/agentic-studio-controller/.env
set_env "$ENV_FILE" STUDIO_CONTROLLER_TOKEN "$CONTROLLER_TOKEN"
as_preview sed -i "s|^STUDIO_CONTROLLER_TOKEN=.*|STUDIO_CONTROLLER_TOKEN=$CONTROLLER_TOKEN|" "$CONTROLLER_ENV"
if agentic-studio-compose up -d --wait; then ok "the stack is up with the controller token"; else not_ok "the stack did not restart with the controller token"; fi
out="$(bash "$SETUP" --only controller-service 2>&1)"
printf '%s\n' "$out" | sed 's/^/      | /'
expect_line "the controller service step restarted the controller" "$out" '^\[controller-service\] ok \(environment controller restarted\)'
controller_active() { as_preview systemctl --user is-active --quiet agentic-studio-controller.service; }
expect_true "the controller is active" wait_for controller_active
controller_cgroup="$(cat "/proc/$(as_preview systemctl --user show agentic-studio-controller.service -p MainPID --value)/cgroup" 2>/dev/null)"
expect_line "the controller runs in its own slice" "$controller_cgroup" 'user@2002\.service/.*agentic-studio-controller\.slice'
expect_false "... outside app.slice, which holds the daemon and the builds and is bounded per build" grep -q '/app\.slice' <<<"$controller_cgroup"
out="$(check_preview --claim)"
status=$?
printf '%s\n' "$out" | sed 's/^/      | /'
if [ "$status" -eq 0 ]; then ok "every Preview check passes with the token set"; else not_ok "the Preview checks failed (exit $status)"; fi
expect_line "nothing skipped: RESULT: PASS" "$(grep '^RESULT:' <<<"$out" | tail -n 1)" '^RESULT: PASS \('
for name in controller-active controller-token-works controller-token-claim controller-token-nothing-else; do
  expect_line "PASS $name" "$out" "^PASS  $name "
done
printf '%s' "$CONTROLLER_TOKEN" >/root/controller-token.test
holders=""
for cmdline in /proc/[0-9]*/cmdline; do
  [ "$cmdline" != "/proc/$$/cmdline" ] || continue
  if grep -qF -f /root/controller-token.test "$cmdline" 2>/dev/null; then
    holders+="$(basename "$(dirname "$cmdline")"):$(cut -c1-30 "$(dirname "$cmdline")/comm" 2>/dev/null) "
  fi
done
rm -f /root/controller-token.test
expect_line "the controller token is on no host command line (holders: ${holders:-none})" "${holders:-none}" '^none$'
out="$(as_agent /usr/local/bin/agentic-studio-check-boundary --skip 'identity,processes,studio-files,docker-socket,sudo,studio-network,host,cgroup,guardrails,rootless,api' 2>&1)"
expect_line "the agent is refused the Preview side; the worker token gets 401 on claim" "$out" '^PASS  worker-token-not-controller '
expect_line "the agent is refused the Preview user's socket and data-root" "$out" '^PASS  preview-docker-unreachable '
expect_line "the agent is not in the proxy group and cannot list the socket directory" "$out" '^PASS  preview-sockets-unreachable '

section "A real build through the Preview user's rootless daemon, served through the proxy"
# Fixture: a Project whose Repository is `ready`, with a Clone in Studio's data directory holding
# a tiny HTTP service that needs a build step. The operation is inserted by SQL, as an API
# request would have.
FIX_ID=3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607
FIX_LABEL=preview-3f2a1b4c5d6e
FIX_HOST="$FIX_LABEL.$PREVIEW_DOMAIN"
fixture="$(mktemp -d)"
export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.test \
  GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.test
mkdir -p "$fixture/work/app"
printf 'services:\n  web:\n    build:\n      context: ./app\n    expose:\n      - "8080"\n' >"$fixture/work/compose.yaml"
printf 'FROM busybox:1.37\nRUN echo built > /built.txt\nCOPY index.html /www/index.html\nCMD ["httpd", "-f", "-p", "8080", "-h", "/www"]\n' >"$fixture/work/app/Dockerfile"
printf 'preview-ok\n' >"$fixture/work/app/index.html"
git -C "$fixture/work" init -q --initial-branch=dev
git -C "$fixture/work" add --all
git -C "$fixture/work" commit -q -m 'fixture'
FIX_COMMIT="$(git -C "$fixture/work" rev-parse HEAD)"
install -d -o 10001 -g 10001 -m 0700 /var/lib/agentic-studio/data/clones
git clone -q --bare "$fixture/work" "/var/lib/agentic-studio/data/clones/$FIX_ID.git"
chown -R 10001:10001 "/var/lib/agentic-studio/data/clones"
rm -rf "$fixture"
sql() { agentic-studio-compose exec -T postgres psql -U studio -d agentic_studio -v ON_ERROR_STOP=1 -At "$@"; }
sql -c "insert into projects (id, name, name_normalized) values ('$FIX_ID', 'Preview fixture', 'preview fixture')" >/dev/null
sql -c "insert into repositories (project_id, url, url_normalized, integration_branch, state, head_sha, last_fetched_at) values ('$FIX_ID', 'https://git.example.test/fixture.git', 'git.example.test/fixture', 'dev', 'ready', '$FIX_COMMIT', now())" >/dev/null
operation_status() { sql -c "select status from preview_operations where id = '$1'"; }
operation_done() { case "$(operation_status "$1")" in succeeded | failed) return 0 ;; *) return 1 ;; esac; }
wait_operation() {
  local _
  for _ in $(seq 1 180); do operation_done "$1" && return 0; sleep 5; done
  return 1
}
explain_operation() {
  sql -c "select kind, status, coalesce(failure_code, ''), coalesce(failure_detail, '') from preview_operations where id = '$1'" | sed 's/^/      | /'
  sql -c "select text from preview_operation_lines where operation_id = '$1' order by seq desc limit 40" | sed 's/^/      | /'
  journalctl _SYSTEMD_USER_UNIT=agentic-studio-controller.service _UID="$puid" -n 40 --no-pager 2>&1 | sed 's/^/      | /'
}
build_id="$(sql -c "insert into preview_operations (project_id, kind, status, commit, compose_file, service, port, memory_mib, cpu_percent, tasks_max, build_minutes) values ('$FIX_ID', 'build', 'requested', '$FIX_COMMIT', 'compose.yaml', 'web', 8080, 1024, 100, 512, 20) returning id" | head -n 1)"
expect_line "the build operation was inserted" "$build_id" '^[0-9a-f-]{36}$'
if wait_operation "$build_id"; then ok "the build operation finished"; else not_ok "the build operation did not finish in 15 minutes"; fi
expect_line "the build succeeded" "$(operation_status "$build_id")" '^succeeded$'
[ "$(operation_status "$build_id")" = succeeded ] || explain_operation "$build_id"
preview_body() { curl -sk --max-time 10 --resolve "$FIX_HOST:443:$HOST_IP" -u "preview:$PREVIEW_PASSWORD" "https://$FIX_HOST/"; }
expect_line "the Preview answers 200 through the proxy with the password" \
  "$(curl -sk --max-time 10 --resolve "$FIX_HOST:443:$HOST_IP" -o /dev/null -w '%{http_code}' -u "preview:$PREVIEW_PASSWORD" "https://$FIX_HOST/")" '^200$'
expect_line "... and serves the built service's page" "$(preview_body)" '^preview-ok$'
expect_false "the agent cannot connect to the Preview's bridge socket (it would skip the password)"   as_agent curl -fsS --max-time 3 --unix-socket "/run/preview-proxy/$FIX_LABEL.sock" http://localhost/
expect_false "the agent cannot list the socket directory" as_agent ls /run/preview-proxy
expect_line "without the password it is still 401" \
  "$(curl -sk --max-time 10 --resolve "$FIX_HOST:443:$HOST_IP" -o /dev/null -w '%{http_code}' "https://$FIX_HOST/")" '^401$'
expect_stat "/run/preview-proxy/$FIX_LABEL.sock" preview:previewproxy 660
preview_containers() { as_preview docker ps -q --filter "label=io.agentic-studio.project=$FIX_ID"; }
preview_containers_all() { as_preview docker ps -aq --filter "label=io.agentic-studio.project=$FIX_ID"; }
nonempty() { [ -n "$("$@")" ]; }
expect_true "the Preview user's daemon runs the Preview's container" nonempty preview_containers
expect_line "the system Docker daemon holds no container of the Preview" "$(docker ps -aq --filter "label=io.agentic-studio.project=$FIX_ID" | wc -l)" '^0$'
stop_id="$(sql -c "insert into preview_operations (project_id, kind, status) values ('$FIX_ID', 'stop', 'requested') returning id" | head -n 1)"
if wait_operation "$stop_id"; then ok "the stop operation finished"; else not_ok "the stop operation did not finish"; fi
expect_line "the stop succeeded" "$(operation_status "$stop_id")" '^succeeded$'
[ "$(operation_status "$stop_id")" = succeeded ] || explain_operation "$stop_id"
expect_line "after the stop the Preview is not running: 404" \
  "$(curl -sk --max-time 10 --resolve "$FIX_HOST:443:$HOST_IP" -o /dev/null -w '%{http_code}' -u "preview:$PREVIEW_PASSWORD" "https://$FIX_HOST/")" '^404$'
expect_line "... with the not-running page" "$(preview_body)" '^This Preview is not running\.$'
expect_false "the socket is gone" test -e "/run/preview-proxy/$FIX_LABEL.sock"
expect_false "the Preview's containers are gone" \
  bash -c "$(declare -f as_preview); puid=$puid; as_preview docker ps -aq --filter label=io.agentic-studio.project=$FIX_ID | grep -q ."
out="$(journalctl _SYSTEMD_USER_UNIT=agentic-studio-controller.service _UID="$puid" --no-pager 2>&1)"
expect_false "no controller token, Environment value or password in the controller's journal" \
  grep -qF -e "$CONTROLLER_TOKEN" -e "$PREVIEW_PASSWORD" <<<"$out"

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
  worker-token-works worker-token-nothing-else managed-guardrails managed-guardrails-locked \
  preview-files-unreadable preview-docker-unreachable preview-sockets-unreachable worker-token-not-controller; do
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

section "The Preview side never runs without its firewall"
preview_firewall=/usr/local/sbin/agentic-studio-preview-firewall
preview_side_down() {
  ! systemctl is-active --quiet "user@$puid.service" && ! pgrep -u preview >/dev/null
}
preview_side_up() {
  systemctl is-active --quiet "user@$puid.service" && as_preview systemctl --user is-active --quiet docker.service
}
systemctl stop agentic-studio-preview-firewall.service
expect_true "Preview firewall stopped -> the Preview user's manager and every Preview process stop" wait_for preview_side_down
expect_true "the agent side is unaffected" as_agent systemctl --user is-active --quiet docker.service
expect_true "starting the Preview side starts its firewall first" systemctl start "user@$puid.service"
expect_true "... the Preview firewall is active" systemctl is-active --quiet agentic-studio-preview-firewall.service
expect_true "... rootless Docker is back" wait_for preview_side_up
expect_true "... with its egress rules applied again" \
  as_preview nsenter -U --preserve-credentials -n -t "$(cat "/run/user/$puid/dockerd-rootless/child_pid")" \
  /usr/local/lib/agentic-studio/preview-egress-rules verify
controller_active_for_a_minute() {
  local _
  for _ in $(seq 1 60); do controller_active && return 0; sleep 1; done
  return 1
}
if expect_true "... and the controller is back (it follows the daemon)" controller_active_for_a_minute; then :; else
  as_preview systemctl --user status agentic-studio-controller.service --no-pager 2>&1 | sed 's/^/      | /'
  journalctl _SYSTEMD_USER_UNIT=agentic-studio-controller.service _UID="$puid" -n 30 --no-pager 2>&1 | sed 's/^/      | /'
fi
"$preview_firewall" remove
systemctl start agentic-studio-preview-firewall-verify.service
expect_false "Preview rules missing -> the verify run stops the Preview firewall unit" \
  systemctl is-active --quiet agentic-studio-preview-firewall.service
expect_true "... and the Preview side with it" wait_for preview_side_down
systemctl start "user@$puid.service"
expect_true "restarting the Preview side restores the rules" "$preview_firewall" verify

agentic-studio-compose down -v >/dev/null 2>&1
finish
