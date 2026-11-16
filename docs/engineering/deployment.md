# Deployment: server setup and isolation boundary checks

How Studio is put on its server so that the isolation model of [ADR 0002](../architecture/adr/0002-agent-run-isolation.md) holds: Studio under the system Docker daemon, which only root controls; agents and the agent worker as an ordinary user with its own rootless Docker. Introduced by #107.

**Status (2026-11-16).** There is no target server yet (operator decision on #107). The setup script, the boundary checks and Studio's production images (#132) are built and tested in CI (job `deploy:server`, see [What CI covers](#8-what-ci-covers)). Running them on the server, repeating the rootless Docker trial there, the first real Runs and the branch protection check are tracked in #130.

All host names, accounts, domains and addresses below are placeholders.

## 1. The two sides of the boundary

| | Studio's side | The agent side |
| --- | --- | --- |
| Runs | PostgreSQL, Redis, the reverse proxy, API, web (and later the environment-controller) as a Compose stack | The agent worker and the agents it starts (provider CLIs, their Git and Docker commands) |
| As | Containers of the **system** Docker daemon (root only); the API, web, reverse proxy and migrations run as uid 10001 (`STUDIO_CONTAINER_UID`) with a read-only root filesystem | The **agent user** (default `agent`, uid/gid 2001, `AGENT_UID`): not in the `docker` group, no `sudo`, no password, no cron, at or SSH login; everything it runs is under its user manager |
| Docker | `/var/run/docker.sock`, root only | Its own **rootless** daemon at `/run/user/<uid>/docker.sock`, a systemd user service |
| Configuration | `/etc/agentic-studio/.env` (root, 0600) in `/etc/agentic-studio/` (root, 0700) | `~agent/.config/agentic-studio-worker/.env` (agent, 0600) |
| Data | `/var/lib/agentic-studio/data` (uid 10001, 0700, inside root-only `/var/lib/agentic-studio`; the API's `STUDIO_DATA_DIR`), `/var/lib/agentic-studio/proxy` (uid 10001, 0700: the proxy's certificates and ACME account), Docker volumes | `~agent/.local/share/agentic-studio-worker` (Working copies, per-project caches) |
| Code | The production images ([Production images](#production-images)); Compose files and the `Caddyfile` in `/opt/agentic-studio/` (root, 0700) | `/opt/agentic-studio-worker/` (root-owned, readable, not writable by the agent user) |
| Network | Container network `172.31.250.0/24` with fixed addresses (PostgreSQL `.10`, Redis `.11`, API `.12`, web `.13`, reverse proxy `.20`; other containers from `.128/25`); only the reverse proxy publishes host ports (80 and 443, IPv4) | Calls the API through the reverse proxy's worker port, `http://172.31.250.20:8080`, with the worker token; a firewall rule rejects its traffic to Studio's container network, except that port. Like any host process it reaches the proxy's published ports, never the API, web, PostgreSQL or Redis directly |

The worker always calls Studio; Studio never reaches into the host. The operating-system boundary is the security boundary; the CLIs' hooks and permission rules are guardrails on top of it ([Security](security.md) §2).

**No production credentials on the server**, on either side: no production database, cloud or deployment credentials, and no operator Git credentials. Studio holds only its own secrets and the projects' Deploy keys; the agent side holds the provider CLI logins, the Agent account's token (limited to the managed repositories) and the worker token. Assume an agent can read everything the agent user can.

## 2. Prerequisites

- **Ubuntu 24.04 LTS on native Linux** (a VM or a dedicated machine), with systemd and cgroup v2 (the Ubuntu 24.04 default). The script refuses other distributions. WSL is not an isolation boundary with default settings ([trial](../architecture/adr/0002-trial-rootless-docker.md#security-finding-wsl)).
- Outbound HTTPS to `download.docker.com`, `nodejs.org`, the npm registry and Docker Hub.
- A clone of this repository owned by root and writable by root only, in a directory whose parents up to `/` are too (the script refuses anything else, because root builds the worker from it), for example `git clone https://github.com/<owner>/AgenticStudio.git /usr/local/src/agentic-studio`. The script deploys the agent worker from this checkout's `HEAD`.
- Operator prerequisites on the Git host: the **Agent account**, with access limited to the managed repositories, and **branch protection** on their integration branches so the Agent account cannot merge or push to them.

## 3. The setup script

```bash
sudo /usr/local/src/agentic-studio/deploy/setup-server.sh           # every step
sudo /usr/local/src/agentic-studio/deploy/setup-server.sh --list    # what each step changes
sudo /usr/local/src/agentic-studio/deploy/setup-server.sh --only worker,service
```

It is safe to run again: each step checks the current state and reports `unchanged` or each change, and the last lines give the number of changes and the remaining manual steps. Run it again after `git pull` to update the agent worker (`--only worker,service` is enough).

**Refusals.** Before any change, and again at the end, it refuses to continue if the agent user is in the `docker` group, has passwordless `sudo` rules, or can run `sudo -n true`; it also refuses a distribution other than Ubuntu 24.04 and the systemd steps without systemd and cgroup v2.

| Step | What it does |
| --- | --- |
| `preflight` | Root, Ubuntu 24.04, supported architecture, no per-user directories in `/etc/environment`, the agent user checks above (also no `lxd`, `incus-admin`, `libvirt` or `disk` group), and a checkout only root can change. Changes nothing. |
| `packages` | Base packages (`uidmap`, `slirp4netns`, `dbus-user-session`, `fuse-overlayfs`, `iptables`, `quota`, `git`, `curl`, ...); Docker's official apt repository with its signing key's fingerprint checked; `docker-ce`, the Compose and Buildx plugins and `docker-ce-rootless-extras`; enables the system Docker daemon. |
| `node` | The official Node.js 24 binary tarball (the version CI uses) into `/usr/local`, checked against its SHA-256 pinned in the script per version and architecture (a different `NODE_VERSION` needs `NODE_SHA256_X64`/`NODE_SHA256_ARM64` with it); pnpm through corepack. |
| `user` | Creates the agent user with the fixed uid/gid `AGENT_UID` (default 2001, outside the range ordinary users and images commonly use; an existing agent user below 2000 is refused), home directory, no password, no `sudo`, a subordinate uid/gid range; makes its home directory inaccessible to other users. |
| `logins` | Nothing of the agent user may run outside its user manager, which is bound to the firewall: it goes into `/etc/cron.deny` and `/etc/at.deny`, gets `DenyUsers` in `/etc/ssh/sshd_config.d/60-agentic-studio.conf` (only when sshd is installed; checked with `sshd -t`, then reloaded), and logind kills its session processes at logout (`KillUserProcesses=yes`, `KillOnlyUsers=agent` in `/etc/systemd/logind.conf.d/60-agentic-studio.conf`). The operator still works as it through `sudo -iu agent`. |
| `layout` | Studio's root-only directories and files (table above; `data/` and `proxy/` owned by uid 10001), `.env` from [`deploy/studio.env.example`](../../deploy/studio.env.example) only when it does not exist, the Compose files, the [`Caddyfile`](../../deploy/Caddyfile) (0644, readable by the proxy container, inside the root-only directory), `/usr/local/sbin/agentic-studio-compose` and `/usr/local/bin/agentic-studio-check-boundary`. The worker's `.env` gets `STUDIO_API_URL=http://172.31.250.20:8080` (the proxy's worker port). On the agent side, **as the agent user** (root never writes into its home): the worker's directories and its `.env` from [`apps/agent-worker/.env.example`](../../apps/agent-worker/.env.example). |
| `worker` | The agent worker's code from `HEAD` into `/opt/agentic-studio-worker`, installed with dependency install scripts disabled and built there; root-owned, world-readable. Skipped when that commit is already built. |
| `firewall` | `agentic-studio-agent-firewall.service`: an `iptables` rule rejecting the agent user's traffic to Studio's container network, except TCP 8080 on the reverse proxy's address (the worker port). Without it, the agent user could reach the API, PostgreSQL and Redis at their container addresses even though no host port is published. **Fail closed:** the unit fails unless the rules are verified in place; a drop-in makes the agent user's manager (`user@<uid>.service`: its services, rootless Docker and the worker) `Requires=`, `BindsTo=` and `After=` it, so the agent side never runs without it; `agentic-studio-agent-firewall-verify.timer` checks the rules every minute and, if they were flushed, stops the firewall unit and with it the agent side. Starting the agent side again (`systemctl start user@<uid>.service`, or a re-run of the script) re-applies them. |
| `limits` | A drop-in for the agent user's slice (`user-<uid>.slice`): `MemoryMax` (default 75%), `TasksMax` (4096), `CPUWeight` (50, below the default 100); cgroup delegation to user managers so rootless Docker's container limits work; a disk quota if configured and available ([Disk quota](#disk-quota)). |
| `rootless` | An AppArmor profile for `rootlesskit` (Ubuntu 24.04 restricts unprivileged user namespaces), linger for the agent user (its services run without a login session), and its rootless Docker daemon as a systemd user service. The Compose plugin is the system one, available to every user. |
| `service` | `/etc/systemd/user/agentic-studio-worker.service` ([template](../../deploy/systemd/agentic-studio-worker.service)), enabled for the agent user, started (restarted) only once its worker token is filled in. It reads the worker's own `.env` and talks to the rootless Docker daemon only. |

**Configuration.** The variables at the top of the script can be overridden through the environment: `AGENT_USER`, the four directories, `NODE_VERSION`, `STUDIO_NETWORK_SUBNET`, `STUDIO_PROXY_ADDRESS` and `STUDIO_PROXY_WORKER_PORT`, `AGENT_MEMORY_MAX`, `AGENT_TASKS_MAX`, `AGENT_CPU_WEIGHT`, `AGENT_DISK_QUOTA_GB`. The container network, its dynamic range and the fixed addresses must stay equal in `studio.env.example`, the Compose files, `setup-server.sh` and `check-boundary.sh`, and the worker port in `setup-server.sh` and the `Caddyfile`; a test checks the defaults.

**Rollback.** The script touches application data nowhere. To undo it: `systemctl disable --now agentic-studio-agent-firewall-verify.timer agentic-studio-agent-firewall` (this stops the agent side too) and remove `/usr/local/sbin/agentic-studio-agent-firewall`, its three units and `/etc/systemd/system/user@<uid>.service.d/60-agentic-studio-firewall.conf`; as the agent user, `systemctl --user disable --now agentic-studio-worker docker` and `dockerd-rootless-setuptool.sh uninstall`; `loginctl disable-linger agent`; remove `/etc/systemd/user/agentic-studio-worker.service`, `/etc/systemd/system/user-<uid>.slice.d/50-agentic-studio.conf`, `/etc/systemd/system/user@.service.d/50-agentic-studio-delegate.conf` and `/etc/apparmor.d/usr.bin.rootlesskit` (then `systemctl daemon-reload`); remove the agent user from `/etc/cron.deny` and `/etc/at.deny` and remove `/etc/ssh/sshd_config.d/60-agentic-studio.conf` and `/etc/systemd/logind.conf.d/60-agentic-studio.conf`; remove `/opt/agentic-studio-worker`, `/usr/local/sbin/agentic-studio-compose`, `/usr/local/bin/agentic-studio-check-boundary`; `userdel -r agent` removes the agent side with its data. Studio's directories, the packages, Docker's apt source and Node.js in `/usr/local` are removed by hand when no longer wanted; `/etc/agentic-studio` and `/var/lib/agentic-studio` hold Studio's configuration and data.

## 4. Manual steps

The script never writes a secret value. It prints the steps below; each value goes in exactly one root-only or agent-only file.

1. **Studio's configuration**, as root, in `/etc/agentic-studio/.env`:
   - `POSTGRES_PASSWORD` (`openssl rand -hex 32`) and `DATABASE_URL` with the same password and the host `postgres`.
   - `REDIS_PASSWORD` (`openssl rand -hex 32`; Redis requires it) and `REDIS_URL` as `redis://:<REDIS_PASSWORD>@redis:6379`. Neither ever goes to the agent side.
   - `STUDIO_OPERATOR_PASSWORD_HASH`: the operator password's Argon2id hash, generated on the operator's workstation with `pnpm --filter @agentic-studio/api run auth:hash-password` (README, "Operator login"), in single quotes.
   - `STUDIO_SECRETS_KEY`: the secret store's master key (`openssl rand -base64 32`). Store a copy off the server at once, separately from the database backups (README, "Secrets key").
   - `STUDIO_WORKER_TOKEN`: the worker token (`openssl rand -base64 32`).
   - `STUDIO_API_IMAGE` and `STUDIO_WEB_IMAGE`: the production images ([Production images](#production-images)).
   - `STUDIO_DOMAIN`: the web app's public domain (the API's `STUDIO_ORIGIN` becomes `https://<STUDIO_DOMAIN>`), and `STUDIO_TLS`: the ACME account email ([Reverse proxy and TLS](#reverse-proxy-and-tls)).
2. **The agent worker's configuration**, as the agent user, in `~/.config/agentic-studio-worker/.env`: the same `STUDIO_WORKER_TOKEN`; `STUDIO_AGENT_GIT_NAME` and `STUDIO_AGENT_GIT_EMAIL` (the Agent account's commit identity); `STUDIO_AGENT_GITHUB_TOKEN`, the Agent account's token limited to the managed repositories (contents and pull requests). Leave `CLAUDE_CODE_ENABLED` and `CODEX_CLI_ENABLED` at `false` ([Enabling a provider](#6-enabling-a-provider)).
3. **The provider CLIs**, as the agent user: install each CLI with its provider's official installer, then log it in interactively with the operator's subscription login, as the CLI runner stories describe (Claude Code: #105, Codex: #106). Never copy a login from another machine or user. Configure the agent user's own Git credentials for fetching the managed repositories.
4. **Project test dependencies**, as root, only when the operator's projects need them: for example Playwright's browser libraries, `npx --yes playwright@<version> install-deps chromium` with the version the project pins.
5. **Start Studio**, as root: `agentic-studio-compose up -d --wait`. The `migrate` service applies the database migrations first and the API starts only after it succeeded ([Migrations](#migrations)); while either image variable is empty, only PostgreSQL and Redis start.
6. **Start the worker**, as the agent user (for example `sudo -iu agent`, with `XDG_RUNTIME_DIR=/run/user/$(id -u)`): `systemctl --user restart agentic-studio-worker`, then `journalctl --user -u agentic-studio-worker`.
7. **Run the boundary checks** as the agent user: `agentic-studio-check-boundary` must end with `RESULT: PASS` ([Boundary checks](#5-boundary-checks)).

### Production images

Studio's API and web run from two images built from this repository (#132), from the repository root:

```bash
docker build -f apps/api/Dockerfile -t registry.example.com/agentic-studio-api:<tag> .
docker build -f apps/web/Dockerfile -t registry.example.com/agentic-studio-web:<tag> .
```

Build them on the server (as root, from the root-owned checkout) or push them to a registry the server pulls from, then set `STUDIO_API_IMAGE` and `STUDIO_WEB_IMAGE` in `/etc/agentic-studio/.env` and run `agentic-studio-compose up -d --wait` again; the registry and tags are placeholders. Both images: a multi-stage build on a Node.js base image pinned by digest (the Node.js version CI uses), `pnpm install --frozen-lockfile` with dependency install scripts limited as in CI (`allowBuilds` in `pnpm-workspace.yaml`), production dependencies only in the final stage, no secret and no `.env` file in any layer ([`.dockerignore`](../../.dockerignore)), `USER 10001:10001`. The API image adds `git` and an SSH client (Repository features) and holds the Prisma migrations; the web image is Next.js's standalone server, built without the `/api` rewrite (the reverse proxy routes `/api`). Compose runs every Studio container with a read-only root filesystem, all capabilities dropped (the proxy keeps only binding ports) and `no-new-privileges`.

### Migrations

The one-off `migrate` service ([`compose.server.app.yaml`](../../deploy/compose.server.app.yaml)) runs `prisma migrate deploy` from the API image, the command `pnpm db:migrate:deploy` runs in development, with only `DATABASE_URL` in its environment; the API `depends_on` it with `service_completed_successfully`, so every `agentic-studio-compose up` applies the committed migrations of the image's version before that API starts. A failed migration leaves the API stopped: read `agentic-studio-compose logs migrate`. Migrations are forward only; take a database backup ([Backups](#7-backups-and-restore-drill)) before switching to an image with new migrations.

### Reverse proxy and TLS

The `proxy` service (Caddy, image pinned by digest, configured by [`deploy/Caddyfile`](../../deploy/Caddyfile)) is the **only service with host ports**: 80 and 443, IPv4 only. It serves `https://<STUDIO_DOMAIN>` with a certificate from Let's Encrypt (`STUDIO_TLS` = the ACME account email; the domain must point at the server and ports 80 and 443 be reachable; certificates are kept in `/var/lib/agentic-studio/proxy`) and sends `/api` straight to the API and everything else to the web app. It neither buffers nor compresses responses, so live Run logs (`GET /api/runs/:runId/events/stream`) stream as they come. `STUDIO_TLS=internal` uses Caddy's own CA instead, for tests only. The agent worker uses a second listener, plain HTTP on port 8080 of the proxy's fixed address inside Studio's network (not published), for `/api` only.

**Trusted proxy (login rate limit).** The API trusts `X-Forwarded-For` only from the proxy's fixed address (`API_TRUSTED_PROXIES=172.31.250.20`, set by the Compose file; a value in `.env` is ignored), and Caddy sets that header from the connection itself, ignoring any incoming one. The network's gateway (`172.31.250.1`) is never trusted: every host process reaching a published port or the proxy's worker port, the agent user included, arrives from it. So each client has its own login rate-limit bucket by its real address: the operator's from outside, the agent user's (and any other host process's) as the gateway. A misled agent can exhaust only its own bucket, and a forged `X-Forwarded-For` does not change it. The ports are published on IPv4 only because Docker relays IPv6 clients through its userland proxy, from the gateway's address. Only ports 80 and 443 of the proxy, and SSH, are reachable from outside.

### Disk quota

The `limits` step sets a disk quota only when `AGENT_DISK_QUOTA_GB` is set and user quotas are switched on for the filesystem holding the agent user's home directory; otherwise it reports that none was set. To switch them on for ext4: add `usrquota` to that filesystem's options in `/etc/fstab`, remount it, run `quotacheck -cum <mount>` and `quotaon -u <mount>`, then run the script again with `AGENT_DISK_QUOTA_GB=<GiB>`. The agent user's rootless Docker images and volumes are in its home directory, so the quota covers them.

## 5. Boundary checks

[`deploy/check-boundary.sh`](../../deploy/check-boundary.sh), installed as `/usr/local/bin/agentic-studio-check-boundary`, runs as the agent user after every server change (packages, users, Docker, firewall, Compose files) and implements the checks of [Security](security.md) §9. Each check prints `PASS`, `FAIL` or `SKIP` with one line of detail; the last line is `RESULT: PASS` (exit 0), `RESULT: PASS WITH SKIPS` (exit 0; not a complete server check) or `RESULT: FAIL` (exit 1). It prints no secret; attach its output, redacted of host names, to the server change.

| Check | Must |
| --- | --- |
| `processes-in-user-manager`, `no-studio-container-as-agent` | Every process of the agent user runs under `user@<uid>.service` (except the check's own session); no system Docker container runs as its uid. |
| `not-root`, `not-in-docker-group` | Run as the agent user, which is in none of the root-equivalent groups `docker`, `lxd`, `incus-admin`, `libvirt`, `disk` (the setup script refuses them too). |
| `studio-config-unreadable`, `studio-data-unreadable` | Fail to read `/etc/agentic-studio`, its `.env`, `/opt/agentic-studio`, `/var/lib/agentic-studio` (with `data/` and the proxy's certificates in `proxy/`) and Docker's volumes. |
| `secrets-unreachable` | Fail to read the master key or a Deploy key; no Studio variable (`DATABASE_URL`, `REDIS_URL`, `REDIS_PASSWORD`, `STUDIO_SECRETS_KEY`, `STUDIO_OPERATOR_PASSWORD_HASH`, `POSTGRES_PASSWORD`) in its environment or the worker's `.env`. |
| `system-docker-unreachable`, `system-containerd-unreachable` | Fail to reach the system Docker socket (`curl --unix-socket`, `docker -H`); the system containerd socket (`/run/containerd/containerd.sock`) is not writable. |
| `sudo-needs-password` | `sudo -n true` fails. |
| `studio-stack-running` | Positive control: Studio's public health route through the reverse proxy's worker port (`STUDIO_API_URL` + `/api/health`) answers 200, so the refusals below are not just a stopped stack. A stopped Studio makes the run fail. |
| `studio-postgres-unreachable`, `studio-redis-unreachable` | Fail to connect to `127.0.0.1:5432`/`6379` and to the containers' addresses. |
| `studio-app-direct-unreachable` | Fail to connect to the API and web directly: `127.0.0.1:3001`/`3000` and their containers' addresses (`.12:3001`, `.13:3000`); only the reverse proxy is open to the agent user. |
| `no-wsl-escape` | No WSL interop and no Windows drive mount. |
| `cgroup-v2`, `agent-user-limits` | cgroup v2; the agent user's slice has a `MemoryMax` and a `TasksMax`. |
| `rootless-docker`, `rootless-container-limits`, `rootless-compose` | The agent user's own daemon answers, is rootless on cgroup v2 with the systemd driver; a container started with `--memory` and `--pids-limit` gets them; a Compose stack starts and stops. |
| `worker-token-works`, `worker-token-nothing-else` | A read-only worker route answers 200 with the worker token and 401 without it; operator routes (`GET /api/projects`, `/api/runs`, `/api/auth/session`, `/api/providers`: 401; `POST /api/projects`: 401 or 403) refuse it. The token is read from the worker's `.env` and sent on stdin to `curl`, never on a command line. |

`--skip <group>` leaves out a group (`identity`, `processes`, `studio-files`, `docker-socket`, `sudo`, `studio-network`, `host`, `cgroup`, `rootless`, `api`) and reports it as `SKIP`, ending with `RESULT: PASS WITH SKIPS`; a server check counts only as `RESULT: PASS`. The settings at the top of the script (directories, the container addresses, `CHECK_IMAGE`) can be overridden through the environment.

## 6. Enabling a provider

Enabling a provider is a separate operator action ([Security](security.md) §2), never done by the script:

1. The provider's compliance record under [`provider-compliance/`](provider-compliance/) is `Approved` and still applicable; moving to this server is a revalidation trigger in both records (#130).
2. As the agent user, set `CLAUDE_CODE_ENABLED=true` or `CODEX_CLI_ENABLED=true` (only the exact value `true` turns it on) in `~/.config/agentic-studio-worker/.env`, then `systemctl --user restart agentic-studio-worker`.
3. When the approval no longer applies, set it back to `false` and restart the worker before any further Run.

## 7. Backups and restore drill

Backups are kept **off the server** (ADR 0002), so that a compromised or wiped server can be rebuilt.

- **Database.** As root, `agentic-studio-compose exec -T postgres pg_dump -U studio -d agentic_studio -Fc > agentic-studio-<date>.dump`, then copy the dump off the server and delete the local copy. The stored secrets in it are encrypted: **a backup is useless for them without the master key**.
- **Master key.** `STUDIO_SECRETS_KEY` is backed up once, separately from the database backups (for example in the operator's password manager), never next to them.
- **Configuration.** The rest of `/etc/agentic-studio/.env` can be recreated; the operator password hash and the worker token can be generated again.
- **Not backed up.** Clones and Working copies are recreated from the Git hosts; the agent side's CLI logins and the Agent account token are issued again.

**Restore drill**, on a throwaway Ubuntu 24.04 machine, after the first real Runs and then on a schedule the operator sets: run the setup script; fill in `.env` with the backed-up master key and new values for the rest; `agentic-studio-compose up -d --wait postgres`; `agentic-studio-compose exec -T postgres pg_restore -U studio -d agentic_studio --clean --if-exists < agentic-studio-<date>.dump`; start the rest; sign in and check that Projects and their Repositories are there and a stored secret can be used (a fetch with a Deploy key). Record the date and result. Then destroy the machine.

## 8. What CI covers

The CI job `deploy:server` (`.github/workflows/ci.yml`) runs on every code change:

- `shellcheck` on both scripts and the tests.
- [`deploy/tests/compose-server.test.mjs`](../../deploy/tests/compose-server.test.mjs) (`docker compose config` only): only the reverse proxy publishes host ports (80 and 443, IPv4), the API trusts the proxy's address only (whatever `.env` says), the `migrate` service runs before the API with the database URL only, every Studio container runs as uid 10001 with a read-only root filesystem and no capabilities, the web container gets no Studio secret, and the network defaults, the worker port and the Caddyfile's routes agree across files.
- [`refuse-distro.sh`](../../deploy/tests/refuse-distro.sh) in a Debian container: the script refuses and changes nothing.
- [`container-tests.sh`](../../deploy/tests/container-tests.sh) in a clean Ubuntu 24.04 container without systemd: the refusals (docker group, passwordless `sudo`, systemd steps), the steps `packages,node,user,layout,worker` run twice with an identical result, the ownership and modes above, the built worker refusing to start without its token, and every boundary check passing where it should and failing when its rule is broken, including the API checks against a stub of the worker routes.
- [`vm-tests.sh`](../../deploy/tests/vm-tests.sh) on the runner VM (Ubuntu 24.04, systemd, cgroup v2; discarded afterwards): every step twice (the second run changes nothing), PostgreSQL and Redis from the server Compose file, Redis refusing unauthenticated commands; both production images built (uid 10001, no `.env` file inside) and the whole stack started with them (migrations applied, every Studio process as uid 10001 on a read-only root filesystem, only ports 80 and 443 published); health, the login page and the http-to-https redirect through the proxy; the login rate limit per client (the agent user's sixth failure gets 429, also with a forged `X-Forwarded-For`, while the operator from outside still gets 401 and signs in, with a `Secure` cookie); then **every** boundary check as the agent user, the `api` group against the real stack, ending `RESULT: PASS` with no skip; the checks failing again when the agent user is put in the `docker` group, the firewall rule is removed or the API is stopped, and the fail-closed binding: with the firewall unit stopped or failing, the agent user's manager, rootless Docker and every agent process are down, and flushed rules make the verify run stop them; the agent user has uid 2001, cron and SSH refuse it, logind kills its session processes, and the process checks fail for a system service or a system container running as it.

Not covered in CI: a public certificate (CI uses `STUDIO_TLS=internal`), a disk quota, WSL, and anything on the real server. Those run on the server (#130).

## Known gaps

- **One bucket for every host process.** Every process on the server reaches Studio from the network's gateway, so they share one login rate-limit bucket (the operator signing in through an SSH tunnel to the server too); the operator from outside keeps their own.
- **IPv4 only.** The firewall rule is `iptables` only; Studio's container network has no IPv6. Add an `ip6tables` rule if IPv6 is ever turned on for it.
- **The CLI runners** are being built (#105, #106); the install and login steps above follow them.
- **On-server verification** (#130): the setup and boundary checks on the target server, the rootless Docker trial repeated there, one real Run per enabled provider, the branch protection check and the compliance records' revalidation note.
