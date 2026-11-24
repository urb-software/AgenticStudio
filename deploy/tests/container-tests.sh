#!/usr/bin/env bash
# Setup script and boundary checks in a clean Ubuntu 24.04 container without systemd (CI job
# deploy:server). Covers: the refusals (agent user in the docker group, passwordless sudo,
# systemd steps without systemd, the Preview user's refusals: root-equivalent groups, the proxy
# group, a shared group, a uid collision, a uid below 2000, a gid collision), the steps that need
# no systemd run twice with the same result,
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
as_preview() { (cd / && runuser -u preview -- env -i HOME=/home/preview PATH=/usr/local/bin:/usr/bin:/bin "$@"); }
check_as_preview() { as_preview /usr/local/bin/agentic-studio-check-preview "$@" 2>&1; }
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
groupadd -f --gid 3001 lxd && usermod -aG lxd agent
expect_fail "refuses an agent user in the lxd group" "is in the lxd group" bash "$SETUP" --only preflight
gpasswd -d agent lxd >/dev/null
useradd --create-home --uid 1500 lowuid
expect_fail "refuses an agent user below uid 2000" "below 2000" env AGENT_USER=lowuid bash "$SETUP" --only preflight
userdel -r lowuid 2>/dev/null

section "Refusals for the Preview user"
expect_fail "refuses a Preview uid equal to the agent's" "must differ from the agent user's uid" env PREVIEW_UID=2001 bash "$SETUP" --only preflight
expect_fail "refuses a Preview uid below 2000" "PREVIEW_UID must be a number of 2000 or more" env PREVIEW_UID=1500 bash "$SETUP" --only preflight
expect_fail "refuses a Preview user named like the agent user" "equals the agent user" env PREVIEW_USER=agent bash "$SETUP" --only preflight
groupadd --gid 2003 othergroup
expect_fail "refuses a proxy gid held by another group" "already taken by the group 'othergroup'" bash "$SETUP" --only preflight
groupdel othergroup
getent group 2002 >/dev/null || groupadd --gid 2002 preview
useradd --create-home --uid 2002 --gid 2002 --shell /bin/bash preview
for group in docker lxd sudo; do
  groupadd -f --gid 3002 "$group" && usermod -aG "$group" preview
  expect_fail "refuses a Preview user in the $group group" "is in the $group group" bash "$SETUP" --only preflight
  usermod -G "" preview
done
groupadd --gid 2003 previewproxy
usermod -aG previewproxy preview
expect_fail "refuses a Preview user in the proxy group" "is in the previewproxy group" bash "$SETUP" --only preflight
usermod -G "" preview
groupadd --gid 3003 sharedgroup && usermod -aG sharedgroup agent && usermod -aG sharedgroup preview
expect_fail "refuses a group shared by the agent and Preview users" "share the group(s) sharedgroup" bash "$SETUP" --only preflight
usermod -G "" agent && usermod -G "" preview && groupdel sharedgroup
echo 'preview ALL=(ALL) NOPASSWD: ALL' >/etc/sudoers.d/preview-test
chmod 0440 /etc/sudoers.d/preview-test
expect_fail "refuses a Preview user with passwordless sudo" "passwordless sudo" bash "$SETUP" --only preflight
rm -f /etc/sudoers.d/preview-test
userdel -r preview 2>/dev/null
for group in previewproxy preview "$(getent group 2002 | cut -d: -f1)"; do
  [ -z "$group" ] || ! getent group "$group" >/dev/null || groupdel "$group"
done

expect_fail "the egress script refuses an unknown command" "usage:" bash "$SRC/deploy/preview-egress-rules.sh" bogus
expect_fail "the egress script's verify fails without rules" "preview egress rules are missing" env -u XDG_RUNTIME_DIR bash "$SRC/deploy/preview-egress-rules.sh" verify

STEPS=packages,node,user,preview-user,logins,layout,worker,controller,guardrails
MANAGED=(/etc/claude-code/managed-settings.json /etc/codex/managed_config.toml /etc/codex/requirements.toml
  /usr/local/lib/agentic-studio/guardrails/claude-guard.mjs)
snapshot() {
  {
    find /etc/agentic-studio /var/lib/agentic-studio /opt/agentic-studio \
      /home/agent/.config/agentic-studio-worker /home/agent/.local/share/agentic-studio-worker \
      /usr/local/sbin/agentic-studio-compose /usr/local/bin/agentic-studio-check-boundary \
      /etc/apt/sources.list.d/docker.sources /etc/apt/keyrings/docker.asc \
      /opt/agentic-studio-worker/.source-commit /etc/claude-code /etc/codex /usr/local/lib/agentic-studio \
      /home/preview/.config/agentic-studio-controller /home/preview/.local/share/agentic-studio-controller \
      /usr/local/bin/agentic-studio-check-preview /opt/agentic-studio-controller/.source-commit \
      -printf '%p %u:%g %m\n' | sort
    find /etc/agentic-studio /opt/agentic-studio /home/agent/.config/agentic-studio-worker \
      /usr/local/sbin/agentic-studio-compose /usr/local/bin/agentic-studio-check-boundary \
      /etc/apt/sources.list.d/docker.sources /opt/agentic-studio-worker/.source-commit \
      /etc/claude-code /etc/codex /usr/local/lib/agentic-studio /home/preview/.config/agentic-studio-controller \
      /usr/local/bin/agentic-studio-check-preview /opt/agentic-studio-controller/.source-commit -type f -exec sha256sum {} + | sort
    /usr/local/bin/node --version
    id agent
    id preview
    getent group previewproxy
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
expect_true "logind kills only the agent and Preview users' session processes" \
  grep -qx 'KillOnlyUsers=agent preview' /etc/systemd/logind.conf.d/60-agentic-studio.conf
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

section "The Preview side (Issue #286)"
expect_true "Preview user has uid and gid 2002" bash -c '[ "$(id -u preview):$(id -g preview)" = 2002:2002 ]'
expect_true "the proxy group has gid 2003" bash -c '[ "$(getent group previewproxy | cut -d: -f3)" = 2003 ]'
expect_false "Preview user is not in the docker group" bash -c "id -nG preview | tr ' ' '\n' | grep -qx docker"
expect_false "Preview user is not in the proxy group (the setgid directory makes it unnecessary)" \
  bash -c "id -nG preview | tr ' ' '\n' | grep -qx previewproxy"
expect_false "the agent and Preview users share no group" \
  bash -c "comm -12 <(id -nG agent | tr ' ' '\n' | sort) <(id -nG preview | tr ' ' '\n' | sort) | grep -q ."
expect_true "Preview user has a subordinate uid range" grep -q '^preview:' /etc/subuid
expect_true "Preview user has a subordinate gid range" grep -q '^preview:' /etc/subgid
expect_true "the agent and Preview ranges differ" bash -c '[ "$(grep ^agent: /etc/subuid | cut -d: -f2)" != "$(grep ^preview: /etc/subuid | cut -d: -f2)" ]'
expect_true "Preview user is in /etc/cron.deny" grep -qx preview /etc/cron.deny
expect_true "Preview user is in /etc/at.deny" grep -qx preview /etc/at.deny
expect_true "home is 0750 or tighter" bash -c '[ "$(stat -c %a /home/preview | tail -c 2)" = 0 ] || [ "$(stat -c %a /home/preview | tail -c 2)" = "00" ]'
expect_stat /home/preview/.config/agentic-studio-controller preview:preview 700
expect_stat /home/preview/.config/agentic-studio-controller/.env preview:preview 600
expect_stat /home/preview/.local/share/agentic-studio-controller preview:preview 700
expect_stat /usr/local/bin/agentic-studio-check-preview root:root 755
expect_true "controller .env leaves STUDIO_CONTROLLER_TOKEN empty (no secret written)" \
  grep -qx 'STUDIO_CONTROLLER_TOKEN=' /home/preview/.config/agentic-studio-controller/.env
expect_true "controller .env: the API through the reverse proxy's worker port" \
  grep -qx 'STUDIO_API_URL=http://172.31.250.20:8080' /home/preview/.config/agentic-studio-controller/.env
expect_true "controller .env: data directory on the Preview side" \
  grep -qx 'STUDIO_CONTROLLER_DATA_DIR=/home/preview/.local/share/agentic-studio-controller' /home/preview/.config/agentic-studio-controller/.env
expect_true "controller .env: the proxy group" grep -qx 'STUDIO_CONTROLLER_PROXY_GID=2003' /home/preview/.config/agentic-studio-controller/.env
expect_true "controller .env: production" grep -qx 'STUDIO_CONTROLLER_ENVIRONMENT=production' /home/preview/.config/agentic-studio-controller/.env
expect_stat /opt/agentic-studio-controller root:root 755
expect_true "Preview user can read the controller code" as_preview test -r /opt/agentic-studio-controller/apps/environment-controller/dist/main.js
expect_false "Preview user cannot change the controller code" as_preview touch /opt/agentic-studio-controller/apps/environment-controller/dist/main.js
expect_false "no file in the controller code is writable by the Preview user" \
  bash -c "find /opt/agentic-studio-controller \( -perm -o+w -o ! -user root \) ! -type l | grep -q ."
expect_false "the agent user cannot list the Preview user's home" as_agent ls /home/preview
expect_false "the Preview user cannot list the agent user's home" as_preview ls /home/agent
expect_false "the Preview user cannot read the worker's .env" as_preview cat /home/agent/.config/agentic-studio-worker/.env
expect_false "the agent user cannot read the controller's .env" as_agent cat /home/preview/.config/agentic-studio-controller/.env
expect_false "the Preview user cannot read Studio's .env" as_preview cat /etc/agentic-studio/.env
controller="$(as_preview node --env-file=/home/preview/.config/agentic-studio-controller/.env \
  /opt/agentic-studio-controller/apps/environment-controller/dist/main.js 2>&1)"
status=$?
printf '%s\n' "$controller" | sed 's/^/      | /'
if [ "$status" -ne 0 ] && grep -q STUDIO_CONTROLLER_TOKEN <<<"$controller"; then
  ok "the built controller refuses to start without its token"
else
  not_ok "the built controller did not refuse its empty token (exit $status)"
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
for name in preview-files-unreadable preview-docker-unreachable; do
  expect_line "PASS $name" "$out" "^PASS  $name "
done
expect_line "no Studio API reachable here -> FAIL worker-token-not-controller" "$out" "^FAIL  worker-token-not-controller "
expect_line "no Studio running -> FAIL studio-stack-running (positive control)" "$out" '^FAIL  studio-stack-running '

expect_line "SKIP api on request" "$out" '^SKIP  api '
expect_line "last line is the result" "$(tail -n 1 <<<"$out")" '^RESULT: FAIL '

ONLY_LOCAL=(--skip 'rootless,cgroup,preview,api')
section "Each check fails when its rule is broken"
ONLY_GUARDRAILS=(--skip 'identity,processes,studio-files,docker-socket,sudo,studio-network,host,cgroup,rootless,preview,api')
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

chmod 0755 /home/preview
out="$(check_as_agent "${ONLY_PREVIEW[@]}")"
expect_line "readable Preview home -> FAIL preview-files-unreadable" "$out" '^FAIL  preview-files-unreadable '
chmod 0750 /home/preview

section "Preview checks as the Preview user (no systemd, no rootless Docker here)"
out="$(check_as_preview --skip 'cgroup,egress,internet,controller,api')"
status=$?
printf '%s\n' "$out" | sed 's/^/      | /'
if [ "$status" -ne 0 ]; then ok "fails without a login session here (linger needs systemd)"; else not_ok "exit $status"; fi
for name in not-root not-privileged sudo-needs-password home-private system-docker-unreachable system-containerd-unreachable \
  agent-docker-unreachable agent-files-unreadable studio-files-unreadable studio-network-unreachable; do
  expect_line "PASS $name" "$out" "^PASS  $name "
done
expect_line "FAIL linger without systemd" "$out" '^FAIL  linger '
chmod 0755 /home/agent
out="$(check_as_preview --skip 'identity,cgroup,egress,internet,controller,api')"
expect_line "readable agent home -> FAIL agent-files-unreadable" "$out" '^FAIL  agent-files-unreadable '
chmod 0750 /home/agent
usermod -aG docker preview
out="$(check_as_preview --skip 'refused,cgroup,egress,internet,controller,api')"
expect_line "docker group -> FAIL not-privileged" "$out" '^FAIL  not-privileged '
gpasswd -d preview docker >/dev/null

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
ONLY_API=(--skip 'identity,processes,studio-files,docker-socket,sudo,studio-network,host,cgroup,rootless,preview')
ONLY_PREVIEW=(--skip 'identity,processes,studio-files,docker-socket,sudo,studio-network,host,cgroup,guardrails,rootless,api')
stub 0
out="$(check_as_agent --skip 'identity,processes,studio-files,docker-socket,sudo,host,cgroup,rootless,preview,api')"
expect_line "Studio answering -> PASS studio-stack-running" "$out" '^PASS  studio-stack-running '
out="$(check_as_agent "${ONLY_API[@]}")"
printf '%s\n' "$out" | sed 's/^/      | /'
expect_line "PASS worker-token-works" "$out" '^PASS  worker-token-works '
expect_line "PASS worker-token-nothing-else" "$out" '^PASS  worker-token-nothing-else '
expect_line "the token is never printed" "$(grep -c -- "$TEST_TOKEN" <<<"$out")" '^0$'
out="$(check_as_agent "${ONLY_PREVIEW[@]}")"
expect_line "the worker token is refused by the controller's claim route -> PASS worker-token-not-controller" "$out" '^PASS  worker-token-not-controller '
kill "$STUB_PID"
wait "$STUB_PID" 2>/dev/null
stub 1
out="$(check_as_agent "${ONLY_API[@]}")"
expect_line "token accepted elsewhere -> FAIL worker-token-nothing-else" "$out" '^FAIL  worker-token-nothing-else '
out="$(check_as_agent "${ONLY_PREVIEW[@]}")"
expect_line "claim accepts the worker token -> FAIL worker-token-not-controller" "$out" '^FAIL  worker-token-not-controller '
kill "$STUB_PID"
wait "$STUB_PID" 2>/dev/null
as_agent sed -i "s|^STUDIO_WORKER_TOKEN=.*|STUDIO_WORKER_TOKEN=|" /home/agent/.config/agentic-studio-worker/.env
out="$(check_as_agent "${ONLY_API[@]}")"
expect_line "no token -> FAIL worker-token-works" "$out" '^FAIL  worker-token-works '

finish
