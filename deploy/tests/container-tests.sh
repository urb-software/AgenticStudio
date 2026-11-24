#!/usr/bin/env bash
# Setup script and boundary checks in a clean Ubuntu 24.04 container without systemd (CI job
# deploy:server). Covers: the refusals (agent user in the docker group, passwordless sudo,
# systemd steps without systemd), the steps that need no systemd run twice with the same result,
# the resulting ownership and modes, and the boundary checks' verdicts, including that each
# check fails when its rule is broken.
#   docker run --rm -v "$PWD:/w:ro" ubuntu:24.04 bash /w/deploy/tests/container-tests.sh
# Every token or password here is a test-only placeholder, never a real value.
# shellcheck disable=SC2016 # single-quoted text run by another shell
set -uo pipefail
REPO="${REPO:-/w}"
# The setup script refuses a checkout others can write: run it from a root-owned copy.
SRC=/usr/local/src/agentic-studio
SETUP="$SRC/deploy/setup-server.sh"
# shellcheck source=deploy/tests/lib.sh
. "$REPO/deploy/tests/lib.sh"
export DEBIAN_FRONTEND=noninteractive
mkdir -p /usr/local/src && cp -a "$REPO" "$SRC" && chown -R root:root "$SRC" && chmod -R go-w "$SRC"

as_agent() { (cd / && runuser -u agent -- env -i HOME=/home/agent PATH=/usr/local/bin:/usr/bin:/bin "$@"); }
check_as_agent() { as_agent /usr/local/bin/agentic-studio-check-boundary "$@" 2>&1; }

section "Refusals before any change"
groupadd docker
groupadd --gid 2001 agent
useradd --create-home --uid 2001 --gid 2001 --shell /bin/bash agent
usermod -aG docker agent
expect_fail "refuses an agent user in the docker group" "is in the docker group" bash "$SETUP"
expect_false "changed nothing before refusing" test -e /etc/agentic-studio
gpasswd -d agent docker >/dev/null

apt-get update -q >/dev/null && apt-get install -y -q --no-install-recommends sudo >/dev/null
echo 'agent ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/agent-test
chmod 0440 /etc/sudoers.d/agent-test
expect_fail "refuses an agent user with passwordless sudo" "passwordless sudo" bash "$SETUP"
rm -f /etc/sudoers.d/agent-test
expect_fail "refuses a systemd step without systemd" "needs systemd as PID 1" bash "$SETUP" --only rootless
expect_fail "refuses an unknown step" "unknown step" bash "$SETUP" --only nonsense
chmod g+w "$SRC/deploy/check-boundary.sh"
expect_fail "refuses a checkout others can write" "must be owned by root" bash "$SETUP" --only preflight
chmod g-w "$SRC/deploy/check-boundary.sh"
groupadd -f lxd && usermod -aG lxd agent
expect_fail "refuses an agent user in the lxd group" "is in the lxd group" bash "$SETUP" --only preflight
gpasswd -d agent lxd >/dev/null
useradd --create-home --uid 1500 lowuid
expect_fail "refuses an agent user below uid 2000" "below 2000" env AGENT_USER=lowuid bash "$SETUP" --only preflight
userdel -r lowuid 2>/dev/null

STEPS=packages,node,user,logins,layout,worker,guardrails
MANAGED=(/etc/claude-code/managed-settings.json /etc/codex/managed_config.toml /etc/codex/requirements.toml
  /usr/local/lib/agentic-studio/guardrails/claude-guard.mjs)
snapshot() {
  {
    find /etc/agentic-studio /var/lib/agentic-studio /opt/agentic-studio \
      /home/agent/.config/agentic-studio-worker /home/agent/.local/share/agentic-studio-worker \
      /usr/local/sbin/agentic-studio-compose /usr/local/bin/agentic-studio-check-boundary \
      /etc/apt/sources.list.d/docker.sources /etc/apt/keyrings/docker.asc \
      /opt/agentic-studio-worker/.source-commit /etc/claude-code /etc/codex /usr/local/lib/agentic-studio \
      -printf '%p %u:%g %m\n' | sort
    find /etc/agentic-studio /opt/agentic-studio /home/agent/.config/agentic-studio-worker \
      /usr/local/sbin/agentic-studio-compose /usr/local/bin/agentic-studio-check-boundary \
      /etc/apt/sources.list.d/docker.sources /opt/agentic-studio-worker/.source-commit \
      /etc/claude-code /etc/codex /usr/local/lib/agentic-studio -type f -exec sha256sum {} + | sort
    /usr/local/bin/node --version
    id agent
  }
}

section "First run: $STEPS"
first="$(bash "$SETUP" --only "$STEPS" 2>&1)"
status=$?
printf '%s\n' "$first" | sed 's/^/      | /'
if [ "$status" -eq 0 ]; then ok "first run succeeded"; else not_ok "first run failed (exit $status)"; fi
expect_line "first run made changes" "$first" '^\[[a-z]+\] changed: '
before="$(snapshot)"

section "Second run: $STEPS (nothing to change)"
second="$(bash "$SETUP" --only "$STEPS" 2>&1)"
status=$?
printf '%s\n' "$second" | sed 's/^/      | /'
if [ "$status" -eq 0 ]; then ok "second run succeeded"; else not_ok "second run failed (exit $status)"; fi
expect_line "second run changed nothing" "$second" '^Done: 0 change\(s\)\.$'
expect_line "node reported unchanged" "$second" '^\[node\] unchanged'
expect_line "worker reported unchanged" "$second" '^\[worker\] unchanged'
expect_line "guardrails reported ok" "$second" '^\[guardrails\] ok '
expect_false "guardrails changed nothing on the second run" grep -q '^\[guardrails\] changed' <<<"$second"
after="$(snapshot)"
if [ "$before" = "$after" ]; then
  ok "files, owners, modes and contents identical after the second run"
else
  not_ok "the second run changed the state:"
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | sed 's/^/      | /'
fi

section "Studio's side: root only"
expect_stat /etc/agentic-studio root:root 700
expect_stat /etc/agentic-studio/.env root:root 600
expect_stat /var/lib/agentic-studio root:root 700
expect_true "/var/lib/agentic-studio/data is 10001:10001 700 (the API container's uid)" bash -c '[ "$(stat -c "%u:%g %a" /var/lib/agentic-studio/data)" = "10001:10001 700" ]'
expect_true "/var/lib/agentic-studio/proxy is 10001:10001 700 (the proxy container's uid)" bash -c '[ "$(stat -c "%u:%g %a" /var/lib/agentic-studio/proxy)" = "10001:10001 700" ]'
expect_stat /opt/agentic-studio root:root 700
expect_stat /opt/agentic-studio/compose.yaml root:root 600
expect_stat /opt/agentic-studio/compose.app.yaml root:root 600
expect_stat /opt/agentic-studio/Caddyfile root:root 644
expect_stat /opt/agentic-studio/Caddyfile.preview root:root 644
expect_stat /opt/agentic-studio/compose.preview.yaml root:root 600
expect_stat /usr/local/sbin/agentic-studio-compose root:root 700
expect_stat /usr/local/bin/agentic-studio-check-boundary root:root 755
for name in POSTGRES_PASSWORD DATABASE_URL STUDIO_OPERATOR_PASSWORD_HASH STUDIO_SECRETS_KEY STUDIO_WORKER_TOKEN; do
  expect_true "Studio .env leaves $name empty (no secret written)" grep -qx "$name=" /etc/agentic-studio/.env
done
expect_true "system Docker and Compose plugin installed" docker compose version

section "The agent side"
expect_false "agent user is not in the docker group" bash -c "id -nG agent | tr ' ' '\n' | grep -qx docker"
expect_true "agent user has a subordinate uid range" grep -q '^agent:' /etc/subuid
expect_true "agent user has uid and gid 2001" bash -c '[ "$(id -u agent):$(id -g agent)" = 2001:2001 ]'
expect_true "agent user is in /etc/cron.deny" grep -qx agent /etc/cron.deny
expect_true "agent user is in /etc/at.deny" grep -qx agent /etc/at.deny
expect_true "logind kills only the agent user's session processes" \
  grep -qx 'KillOnlyUsers=agent' /etc/systemd/logind.conf.d/60-agentic-studio.conf
expect_stat /home/agent/.config/agentic-studio-worker agent:agent 700
expect_stat /home/agent/.config/agentic-studio-worker/.env agent:agent 600
expect_stat /home/agent/.local/share/agentic-studio-worker agent:agent 700
for name in STUDIO_WORKER_TOKEN STUDIO_AGENT_GITHUB_TOKEN; do
  expect_true "worker .env leaves $name empty" grep -qx "$name=" /home/agent/.config/agentic-studio-worker/.env
done
expect_true "worker .env: provider switches off" grep -qx 'CLAUDE_CODE_ENABLED=false' /home/agent/.config/agentic-studio-worker/.env
expect_true "worker .env: data directory on the agent side" \
  grep -qx 'STUDIO_WORKER_DATA_DIR=/home/agent/.local/share/agentic-studio-worker' /home/agent/.config/agentic-studio-worker/.env
expect_true "worker .env: the API through the reverse proxy's worker port" \
  grep -qx 'STUDIO_API_URL=http://172.31.250.20:8080' /home/agent/.config/agentic-studio-worker/.env
expect_stat /opt/agentic-studio-worker root:root 755
expect_true "Node.js v24.22.1 in /usr/local" bash -c '[ "$(/usr/local/bin/node --version)" = v24.22.1 ]'
expect_true "agent user can read the worker code" as_agent test -r /opt/agentic-studio-worker/apps/agent-worker/dist/main.js
expect_false "agent user cannot change the worker code" as_agent touch /opt/agentic-studio-worker/apps/agent-worker/dist/main.js
expect_false "agent user cannot add files to the worker code" as_agent touch /opt/agentic-studio-worker/probe
expect_false "no file in the worker code is writable by the agent user" \
  bash -c "find /opt/agentic-studio-worker \( -perm -o+w -o ! -user root \) ! -type l | grep -q ."
# The built worker starts and fails closed on its empty token (the service is not started then).
worker="$(as_agent node --env-file=/home/agent/.config/agentic-studio-worker/.env \
  /opt/agentic-studio-worker/apps/agent-worker/dist/main.js 2>&1)"
status=$?
printf '%s\n' "$worker" | sed 's/^/      | /'
if [ "$status" -ne 0 ] && grep -q STUDIO_WORKER_TOKEN <<<"$worker"; then
  ok "the built worker refuses to start without its token"
else
  not_ok "the built worker did not refuse its empty token (exit $status)"
fi

section "Managed guardrails (Issue #134): root-owned, equal to the worker's copies"
GUARDRAILS_SRC=/opt/agentic-studio-worker/apps/agent-worker/guardrails
for dir in /etc/claude-code /etc/codex /usr/local/lib/agentic-studio /usr/local/lib/agentic-studio/guardrails; do
  expect_stat "$dir" root:root 755
done
for file in "${MANAGED[@]}"; do expect_stat "$file" root:root 644; done
expect_true "Claude Code managed settings equal the worker's copy" \
  cmp -s /etc/claude-code/managed-settings.json "$GUARDRAILS_SRC/claude-managed-settings.json"
expect_true "Codex requirements equal the worker's copy" cmp -s /etc/codex/requirements.toml "$GUARDRAILS_SRC/codex-requirements.toml"
expect_true "Codex managed config equals the worker's copy" cmp -s /etc/codex/managed_config.toml "$GUARDRAILS_SRC/codex-managed-config.toml"
expect_true "the guard script equals the worker's copy" \
  cmp -s /usr/local/lib/agentic-studio/guardrails/claude-guard.mjs "$GUARDRAILS_SRC/claude-guard.mjs"
expect_true "the managed settings are valid JSON" \
  /usr/local/bin/node -e 'JSON.parse(require("fs").readFileSync("/etc/claude-code/managed-settings.json", "utf8"))'
for file in "${MANAGED[@]}"; do
  expect_false "agent user cannot change $file" as_agent sh -c "echo x >> '$file'"
  expect_false "agent user cannot replace $file" as_agent sh -c "ln -sf /dev/null '$file.agent' && mv -f '$file.agent' '$file'"
done
expect_false "agent user cannot add a Claude Code drop-in folder" as_agent mkdir /etc/claude-code/managed-settings.d
# The guard as installed blocks a guarded command (exit 2) and leaves an ordinary one alone.
guard() { as_agent sh -c "printf '%s' '$1' | /usr/local/bin/node /usr/local/lib/agentic-studio/guardrails/claude-guard.mjs"; }
expect_fail "the installed guard blocks git push" "Blocked by Studio's guardrails" guard '{"tool_name":"Bash","tool_input":{"command":"git push"}}'
expect_true "the installed guard leaves npm test alone" guard '{"tool_name":"Bash","tool_input":{"command":"npm test"}}'

section "Boundary checks as the agent user (no systemd, no rootless Docker here)"
out="$(check_as_agent --skip api)"
status=$?
printf '%s\n' "$out" | sed 's/^/      | /'
if [ "$status" -eq 1 ]; then ok "fails overall here (rootless Docker and slice limits need systemd)"; else not_ok "exit $status, expected 1"; fi
for name in not-root not-in-docker-group processes-in-user-manager no-studio-container-as-agent studio-config-unreadable studio-data-unreadable secrets-unreachable \
  system-docker-unreachable system-containerd-unreachable sudo-needs-password studio-postgres-unreachable \
  studio-redis-unreachable studio-app-direct-unreachable no-wsl-escape managed-guardrails managed-guardrails-locked; do
  expect_line "PASS $name" "$out" "^PASS  $name "
done
for name in rootless-docker agent-user-limits; do
  expect_line "FAIL $name without systemd" "$out" "^FAIL  $name "
done
expect_line "no Studio running -> FAIL studio-stack-running (positive control)" "$out" '^FAIL  studio-stack-running '

expect_line "SKIP api on request" "$out" '^SKIP  api '
expect_line "last line is the result" "$(tail -n 1 <<<"$out")" '^RESULT: FAIL '

ONLY_LOCAL=(--skip 'rootless,cgroup,api')
section "Each check fails when its rule is broken"
ONLY_GUARDRAILS=(--skip 'identity,processes,studio-files,docker-socket,sudo,studio-network,host,cgroup,rootless,api')
guardrails_reinstalled() {
  local out
  out="$(bash "$SETUP" --only guardrails 2>&1)"
  grep -q '^\[guardrails\] changed: ' <<<"$out" || return 1
  out="$(check_as_agent "${ONLY_GUARDRAILS[@]}")"
  grep -q '^PASS  managed-guardrails ' <<<"$out"
}
echo '# changed' >>/etc/codex/requirements.toml
out="$(check_as_agent "${ONLY_GUARDRAILS[@]}")"
expect_line "changed requirements -> FAIL managed-guardrails" "$out" '^FAIL  managed-guardrails .*requirements\.toml differs'
expect_true "the guardrails step restores it" guardrails_reinstalled
chmod 0666 /etc/claude-code/managed-settings.json
out="$(check_as_agent "${ONLY_GUARDRAILS[@]}")"
expect_line "writable managed settings -> FAIL managed-guardrails" "$out" '^FAIL  managed-guardrails .*not root:root 644'
expect_line "writable managed settings -> FAIL managed-guardrails-locked" "$out" '^FAIL  managed-guardrails-locked '
expect_true "the guardrails step restores its mode" guardrails_reinstalled
chown agent /usr/local/lib/agentic-studio/guardrails
out="$(check_as_agent "${ONLY_GUARDRAILS[@]}")"
expect_line "guard folder owned by the agent -> FAIL managed-guardrails" "$out" '^FAIL  managed-guardrails .*not a root-only directory'
expect_line "guard folder owned by the agent -> FAIL managed-guardrails-locked" "$out" '^FAIL  managed-guardrails-locked '
expect_true "the guardrails step takes the folder back" guardrails_reinstalled
mv /etc/codex/managed_config.toml /root/managed_config.toml.test
ln -s /root/managed_config.toml.test /etc/codex/managed_config.toml
out="$(check_as_agent "${ONLY_GUARDRAILS[@]}")"
expect_line "symbolic link -> FAIL managed-guardrails" "$out" '^FAIL  managed-guardrails .*symbolic link'
expect_true "the guardrails step replaces the link" guardrails_reinstalled
expect_false "... with a real file" test -L /etc/codex/managed_config.toml
rm -f /root/managed_config.toml.test
rm -f /etc/claude-code/managed-settings.json
out="$(check_as_agent "${ONLY_GUARDRAILS[@]}")"
expect_line "missing managed settings -> FAIL managed-guardrails" "$out" '^FAIL  managed-guardrails .*managed-settings\.json missing'
expect_true "the guardrails step reinstalls it" guardrails_reinstalled
# Review L1 of #136: managed inputs the CLIs would merge into Studio's policy must be absent.
for extra in /etc/codex/config.toml /etc/claude-code/managed-mcp.json /etc/claude-code/managed-settings.d; do
  if [ "$extra" = /etc/claude-code/managed-settings.d ]; then mkdir "$extra"; else echo '{}' >"$extra"; fi
  out="$(check_as_agent "${ONLY_GUARDRAILS[@]}")"
  expect_line "present $extra -> FAIL managed-guardrails" "$out" "^FAIL  managed-guardrails .*$extra must not exist"
  expect_fail "the guardrails step refuses while $extra exists" "$extra exists" bash "$SETUP" --only guardrails
  rm -rf "$extra"
done
out="$(check_as_agent "${ONLY_GUARDRAILS[@]}")"
expect_line "removed again -> PASS managed-guardrails" "$out" '^PASS  managed-guardrails '

chmod 0755 /etc/agentic-studio && chmod 0644 /etc/agentic-studio/.env
out="$(check_as_agent "${ONLY_LOCAL[@]}")"
expect_line "readable Studio config -> FAIL studio-config-unreadable" "$out" '^FAIL  studio-config-unreadable '
expect_line "readable master key -> FAIL secrets-unreachable" "$out" '^FAIL  secrets-unreachable '
chmod 0700 /etc/agentic-studio && chmod 0600 /etc/agentic-studio/.env

chmod 0755 /var/lib/agentic-studio /var/lib/agentic-studio/data
out="$(check_as_agent "${ONLY_LOCAL[@]}")"
expect_line "readable Studio data -> FAIL studio-data-unreadable" "$out" '^FAIL  studio-data-unreadable '
chmod 0700 /var/lib/agentic-studio/data
chmod 0755 /var/lib/agentic-studio/proxy
out="$(check_as_agent "${ONLY_LOCAL[@]}")"
expect_line "readable proxy certificates -> FAIL studio-data-unreadable" "$out" '^FAIL  studio-data-unreadable '
chmod 0700 /var/lib/agentic-studio /var/lib/agentic-studio/proxy

echo 'agent ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/agent-test && chmod 0440 /etc/sudoers.d/agent-test
out="$(check_as_agent "${ONLY_LOCAL[@]}")"
expect_line "passwordless sudo -> FAIL sudo-needs-password" "$out" '^FAIL  sudo-needs-password '
rm -f /etc/sudoers.d/agent-test

usermod -aG docker agent
out="$(check_as_agent "${ONLY_LOCAL[@]}")"
expect_line "docker group -> FAIL not-in-docker-group" "$out" '^FAIL  not-in-docker-group '
gpasswd -d agent docker >/dev/null

as_agent sh -c 'echo "DATABASE_URL=postgresql://placeholder@localhost/db" >> "$HOME/.config/agentic-studio-worker/.env"'
out="$(check_as_agent "${ONLY_LOCAL[@]}")"
expect_line "Studio variable in the worker .env -> FAIL secrets-unreachable" "$out" '^FAIL  secrets-unreachable '
as_agent sed -i '/^DATABASE_URL=/d' /home/agent/.config/agentic-studio-worker/.env

# A listener on the database, Redis and API ports stands in for a published Studio port.
node -e "for (const p of [5432, 6379, 3001]) require('node:net').createServer((s) => s.end()).listen(p, '127.0.0.1')" &
listener=$!
sleep 1
out="$(check_as_agent "${ONLY_LOCAL[@]}")"
expect_line "reachable database port -> FAIL studio-postgres-unreachable" "$out" '^FAIL  studio-postgres-unreachable '
expect_line "reachable Redis port -> FAIL studio-redis-unreachable" "$out" '^FAIL  studio-redis-unreachable '
expect_line "reachable API port -> FAIL studio-app-direct-unreachable" "$out" '^FAIL  studio-app-direct-unreachable '
kill "$listener"
wait "$listener" 2>/dev/null

section "API checks against a stub of Studio's worker routes"
# A test-only token (not a secret) in the worker .env; the stub accepts it on worker routes only,
# or, in leaky mode, on every route. The stub stands in for the reverse proxy's worker port on
# loopback (the proxy's container address does not exist in this container).
TEST_TOKEN="test-only-placeholder-token-0123456789abcdef"
as_agent sed -i "s|^STUDIO_WORKER_TOKEN=.*|STUDIO_WORKER_TOKEN=$TEST_TOKEN|" /home/agent/.config/agentic-studio-worker/.env
as_agent sed -i "s|^STUDIO_API_URL=.*|STUDIO_API_URL=http://127.0.0.1:8080|" /home/agent/.config/agentic-studio-worker/.env
stub() {
  STUB_TOKEN="$TEST_TOKEN" STUB_LEAKY="$1" node -e "
    require('node:http').createServer((req, res) => {
      if (req.url === '/api/health') { res.writeHead(200); return res.end('ok'); }
      const auth = req.headers.authorization === 'Bearer ' + process.env.STUB_TOKEN;
      const worker = req.url.startsWith('/api/worker/');
      const allowed = auth && (worker || process.env.STUB_LEAKY === '1');
      res.writeHead(allowed ? 200 : 401, { 'content-type': 'application/json' });
      res.end(allowed && worker ? '[]' : '{}');
    }).listen(8080, '127.0.0.1');" &
  STUB_PID=$!
  sleep 1
}
ONLY_API=(--skip 'identity,processes,studio-files,docker-socket,sudo,studio-network,host,cgroup,rootless')
stub 0
out="$(check_as_agent --skip 'identity,processes,studio-files,docker-socket,sudo,host,cgroup,rootless,api')"
expect_line "Studio answering -> PASS studio-stack-running" "$out" '^PASS  studio-stack-running '
out="$(check_as_agent "${ONLY_API[@]}")"
printf '%s\n' "$out" | sed 's/^/      | /'
expect_line "PASS worker-token-works" "$out" '^PASS  worker-token-works '
expect_line "PASS worker-token-nothing-else" "$out" '^PASS  worker-token-nothing-else '
expect_line "the token is never printed" "$(grep -c -- "$TEST_TOKEN" <<<"$out")" '^0$'
kill "$STUB_PID"
wait "$STUB_PID" 2>/dev/null
stub 1
out="$(check_as_agent "${ONLY_API[@]}")"
expect_line "token accepted elsewhere -> FAIL worker-token-nothing-else" "$out" '^FAIL  worker-token-nothing-else '
kill "$STUB_PID"
wait "$STUB_PID" 2>/dev/null
as_agent sed -i "s|^STUDIO_WORKER_TOKEN=.*|STUDIO_WORKER_TOKEN=|" /home/agent/.config/agentic-studio-worker/.env
out="$(check_as_agent "${ONLY_API[@]}")"
expect_line "no token -> FAIL worker-token-works" "$out" '^FAIL  worker-token-works '

finish
