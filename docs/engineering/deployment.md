# Deployment: server setup and isolation boundary checks

How Studio is put on its server so that the isolation model of [ADR 0002](../architecture/adr/0002-agent-run-isolation.md) holds: Studio under the system Docker daemon, which only root controls; agents and the agent worker as an ordinary user with its own rootless Docker. Introduced by #107.

**Status (2026-11-16).** There is no target server yet (operator decision on #107). The setup script and the boundary checks are built and tested in CI (job `deploy:server`, see [What CI covers](#what-ci-covers)). Running them on the server, repeating the rootless Docker trial there, the first real Runs and the branch protection check are tracked in #130. Studio has no production container images yet: see [Known gaps](#known-gaps).

All host names, accounts, domains and addresses below are placeholders.

## 1. The two sides of the boundary

| | Studio's side | The agent side |
| --- | --- | --- |
| Runs | PostgreSQL, Redis, API, web (and later the environment-controller) as a Compose stack | The agent worker and the agents it starts (provider CLIs, their Git and Docker commands) |
| As | Containers of the **system** Docker daemon (root only); the API and web run as uid 10001 (`STUDIO_CONTAINER_UID`) | The **agent user** (default `agent`, uid/gid 2001, `AGENT_UID`): not in the `docker` group, no `sudo`, no password, no cron, at or SSH login; everything it runs is under its user manager |
| Docker | `/var/run/docker.sock`, root only | Its own **rootless** daemon at `/run/user/<uid>/docker.sock`, a systemd user service |
| Configuration | `/etc/agentic-studio/.env` (root, 0600) in `/etc/agentic-studio/` (root, 0700) | `~agent/.config/agentic-studio-worker/.env` (agent, 0600) |
| Data | `/var/lib/agentic-studio/data` (uid 10001, 0700, inside root-only `/var/lib/agentic-studio`; the API's `STUDIO_DATA_DIR`), Docker volumes | `~agent/.local/share/agentic-studio-worker` (Working copies, per-project caches) |
| Code | Compose files in `/opt/agentic-studio/` (root, 0700) | `/opt/agentic-studio-worker/` (root-owned, readable, not writable by the agent user) |
| Network | Container network `172.31.250.0/24`; only the API (`127.0.0.1:3001`) and web (`127.0.0.1:3000`) ports are published | Calls the API at `http://127.0.0.1:3001` with the worker token; a firewall rule rejects its traffic to Studio's container network, except the API port. Like any host process it reaches the two ports published on `127.0.0.1` (the API and the web login), never PostgreSQL or Redis |

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
| `layout` | Studio's root-only directories and files (table above), `.env` from [`deploy/studio.env.example`](../../deploy/studio.env.example) only when it does not exist, the Compose files, `/usr/local/sbin/agentic-studio-compose` and `/usr/local/bin/agentic-studio-check-boundary`. On the agent side, **as the agent user** (root never writes into its home): the worker's directories and its `.env` from [`apps/agent-worker/.env.example`](../../apps/agent-worker/.env.example). |
| `worker` | The agent worker's code from `HEAD` into `/opt/agentic-studio-worker`, installed with dependency install scripts disabled and built there; root-owned, world-readable. Skipped when that commit is already built. |
| `firewall` | `agentic-studio-agent-firewall.service`: an `iptables` rule rejecting the agent user's traffic to Studio's container network, except TCP 3001 (the API). Without it, the agent user could reach PostgreSQL and Redis at their container addresses even though no host port is published. **Fail closed:** the unit fails unless the rules are verified in place; a drop-in makes the agent user's manager (`user@<uid>.service`: its services, rootless Docker and the worker) `Requires=`, `BindsTo=` and `After=` it, so the agent side never runs without it; `agentic-studio-agent-firewall-verify.timer` checks the rules every minute and, if they were flushed, stops the firewall unit and with it the agent side. Starting the agent side again (`systemctl start user@<uid>.service`, or a re-run of the script) re-applies them. |
| `limits` | A drop-in for the agent user's slice (`user-<uid>.slice`): `MemoryMax` (default 75%), `TasksMax` (4096), `CPUWeight` (50, below the default 100); cgroup delegation to user managers so rootless Docker's container limits work; a disk quota if configured and available ([Disk quota](#disk-quota)). |
| `rootless` | An AppArmor profile for `rootlesskit` (Ubuntu 24.04 restricts unprivileged user namespaces), linger for the agent user (its services run without a login session), and its rootless Docker daemon as a systemd user service. The Compose plugin is the system one, available to every user. |
| `service` | `/etc/systemd/user/agentic-studio-worker.service` ([template](../../deploy/systemd/agentic-studio-worker.service)), enabled for the agent user, started (restarted) only once its worker token is filled in. It reads the worker's own `.env` and talks to the rootless Docker daemon only. |

**Configuration.** The variables at the top of the script can be overridden through the environment: `AGENT_USER`, the four directories, `NODE_VERSION`, `STUDIO_NETWORK_SUBNET` and `STUDIO_AGENT_ALLOWED_PORTS`, `AGENT_MEMORY_MAX`, `AGENT_TASKS_MAX`, `AGENT_CPU_WEIGHT`, `AGENT_DISK_QUOTA_GB`. The container network and the addresses of PostgreSQL (`.10`) and Redis (`.11`) must stay equal in `studio.env.example`, the Compose files, `setup-server.sh` and `check-boundary.sh`; a test checks the defaults.

**Rollback.** The script touches application data nowhere. To undo it: `systemctl disable --now agentic-studio-agent-firewall-verify.timer agentic-studio-agent-firewall` (this stops the agent side too) and remove `/usr/local/sbin/agentic-studio-agent-firewall`, its three units and `/etc/systemd/system/user@<uid>.service.d/60-agentic-studio-firewall.conf`; as the agent user, `systemctl --user disable --now agentic-studio-worker docker` and `dockerd-rootless-setuptool.sh uninstall`; `loginctl disable-linger agent`; remove `/etc/systemd/user/agentic-studio-worker.service`, `/etc/systemd/system/user-<uid>.slice.d/50-agentic-studio.conf`, `/etc/systemd/system/user@.service.d/50-agentic-studio-delegate.conf` and `/etc/apparmor.d/usr.bin.rootlesskit` (then `systemctl daemon-reload`); remove the agent user from `/etc/cron.deny` and `/etc/at.deny` and remove `/etc/ssh/sshd_config.d/60-agentic-studio.conf` and `/etc/systemd/logind.conf.d/60-agentic-studio.conf`; remove `/opt/agentic-studio-worker`, `/usr/local/sbin/agentic-studio-compose`, `/usr/local/bin/agentic-studio-check-boundary`; `userdel -r agent` removes the agent side with its data. Studio's directories, the packages, Docker's apt source and Node.js in `/usr/local` are removed by hand when no longer wanted; `/etc/agentic-studio` and `/var/lib/agentic-studio` hold Studio's configuration and data.

## 4. Manual steps

The script never writes a secret value. It prints the steps below; each value goes in exactly one root-only or agent-only file.

1. **Studio's configuration**, as root, in `/etc/agentic-studio/.env`:
   - `POSTGRES_PASSWORD` (`openssl rand -hex 32`) and `DATABASE_URL` with the same password and the host `postgres`.
   - `REDIS_PASSWORD` (`openssl rand -hex 32`; Redis requires it) and `REDIS_URL` as `redis://:<REDIS_PASSWORD>@redis:6379`. Neither ever goes to the agent side.
   - `STUDIO_OPERATOR_PASSWORD_HASH`: the operator password's Argon2id hash, generated on the operator's workstation with `pnpm --filter @agentic-studio/api run auth:hash-password` (README, "Operator login"), in single quotes.
   - `STUDIO_SECRETS_KEY`: the secret store's master key (`openssl rand -base64 32`). Store a copy off the server at once, separately from the database backups (README, "Secrets key").
   - `STUDIO_WORKER_TOKEN`: the worker token (`openssl rand -base64 32`).
   - `STUDIO_ORIGIN`: the public `https://` origin of the web app behind the reverse proxy.
2. **The agent worker's configuration**, as the agent user, in `~/.config/agentic-studio-worker/.env`: the same `STUDIO_WORKER_TOKEN`; `STUDIO_AGENT_GIT_NAME` and `STUDIO_AGENT_GIT_EMAIL` (the Agent account's commit identity); `STUDIO_AGENT_GITHUB_TOKEN`, the Agent account's token limited to the managed repositories (contents and pull requests). Leave `CLAUDE_CODE_ENABLED` and `CODEX_CLI_ENABLED` at `false` ([Enabling a provider](#6-enabling-a-provider)).
3. **The provider CLIs**, as the agent user: install each CLI with its provider's official installer, then log it in interactively with the operator's subscription login, as the CLI runner stories describe (Claude Code: #105, Codex: #106). Never copy a login from another machine or user. Configure the agent user's own Git credentials for fetching the managed repositories.
4. **Project test dependencies**, as root, only when the operator's projects need them: for example Playwright's browser libraries, `npx --yes playwright@<version> install-deps chromium` with the version the project pins.
5. **Start Studio**, as root: `agentic-studio-compose up -d --wait` (only PostgreSQL and Redis until the images exist, see [Known gaps](#known-gaps)).
6. **Start the worker**, as the agent user (for example `sudo -iu agent`, with `XDG_RUNTIME_DIR=/run/user/$(id -u)`): `systemctl --user restart agentic-studio-worker`, then `journalctl --user -u agentic-studio-worker`.
7. **Run the boundary checks** as the agent user: `agentic-studio-check-boundary` must end with `RESULT: PASS` ([Boundary checks](#5-boundary-checks)).

**Reverse proxy (placeholder).** A reverse proxy on the host terminates TLS for `studio.example.com` and forwards to the web app at `127.0.0.1:3000`; the web app forwards `/api` to the API. Turn response buffering off for `GET /api/runs/:runId/events/stream` (live Run logs, README "Web `/api` proxy"). `API_TRUSTED_PROXIES` stays empty for now and never lists the network's gateway (`172.31.250.1`): every host process that reaches `127.0.0.1:3001`, the agent user included, arrives from it and could forge `X-Forwarded-For` past the login rate limit ([Known gaps](#known-gaps)). Only ports 80 and 443 of the proxy, and SSH, are reachable from outside.

### Disk quota

The `limits` step sets a disk quota only when `AGENT_DISK_QUOTA_GB` is set and user quotas are switched on for the filesystem holding the agent user's home directory; otherwise it reports that none was set. To switch them on for ext4: add `usrquota` to that filesystem's options in `/etc/fstab`, remount it, run `quotacheck -cum <mount>` and `quotaon -u <mount>`, then run the script again with `AGENT_DISK_QUOTA_GB=<GiB>`. The agent user's rootless Docker images and volumes are in its home directory, so the quota covers them.

## 5. Boundary checks

[`deploy/check-boundary.sh`](../../deploy/check-boundary.sh), installed as `/usr/local/bin/agentic-studio-check-boundary`, runs as the agent user after every server change (packages, users, Docker, firewall, Compose files) and implements the checks of [Security](security.md) §9. Each check prints `PASS`, `FAIL` or `SKIP` with one line of detail; the last line is `RESULT: PASS` (exit 0), `RESULT: PASS WITH SKIPS` (exit 0; not a complete server check) or `RESULT: FAIL` (exit 1). It prints no secret; attach its output, redacted of host names, to the server change.

| Check | Must |
| --- | --- |
| `processes-in-user-manager`, `no-studio-container-as-agent` | Every process of the agent user runs under `user@<uid>.service` (except the check's own session); no system Docker container runs as its uid. |
| `not-root`, `not-in-docker-group` | Run as the agent user, which is in none of the root-equivalent groups `docker`, `lxd`, `incus-admin`, `libvirt`, `disk` (the setup script refuses them too). |
| `studio-config-unreadable`, `studio-data-unreadable` | Fail to read `/etc/agentic-studio`, its `.env`, `/opt/agentic-studio`, `/var/lib/agentic-studio` and Docker's volumes. |
| `secrets-unreachable` | Fail to read the master key or a Deploy key; no Studio variable (`DATABASE_URL`, `REDIS_URL`, `REDIS_PASSWORD`, `STUDIO_SECRETS_KEY`, `STUDIO_OPERATOR_PASSWORD_HASH`, `POSTGRES_PASSWORD`) in its environment or the worker's `.env`. |
| `system-docker-unreachable`, `system-containerd-unreachable` | Fail to reach the system Docker socket (`curl --unix-socket`, `docker -H`); the system containerd socket (`/run/containerd/containerd.sock`) is not writable. |
| `sudo-needs-password` | `sudo -n true` fails. |
| `studio-stack-running` | Positive control: Studio's public health route (`STUDIO_API_URL` + `/api/health`) answers 200, so the refusals below are not just a stopped stack. A stopped Studio makes the run fail. |
| `studio-postgres-unreachable`, `studio-redis-unreachable` | Fail to connect to `127.0.0.1:5432`/`6379` and to the containers' addresses. |
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
- [`deploy/tests/compose-server.test.mjs`](../../deploy/tests/compose-server.test.mjs) (`docker compose config` only): PostgreSQL and Redis publish no host port, only the API and web ports are published and only on `127.0.0.1`, the web container gets no Studio secret, and the network defaults agree across files.
- [`refuse-distro.sh`](../../deploy/tests/refuse-distro.sh) in a Debian container: the script refuses and changes nothing.
- [`container-tests.sh`](../../deploy/tests/container-tests.sh) in a clean Ubuntu 24.04 container without systemd: the refusals (docker group, passwordless `sudo`, systemd steps), the steps `packages,node,user,layout,worker` run twice with an identical result, the ownership and modes above, the built worker refusing to start without its token, and every boundary check passing where it should and failing when its rule is broken, including the API checks against a stub of the worker routes.
- [`vm-tests.sh`](../../deploy/tests/vm-tests.sh) on the runner VM (Ubuntu 24.04, systemd, cgroup v2; discarded afterwards): every step twice (the second run changes nothing), PostgreSQL and Redis from the server Compose file, then the boundary checks as the agent user with the `api` group skipped, the checks failing again when the agent user is put in the `docker` group, the firewall rule is removed or Studio's health route stops answering (a stand-in serves it until the images exist), Redis refusing unauthenticated commands, and the fail-closed binding: with the firewall unit stopped or failing, the agent user's manager, rootless Docker and every agent process are down, and flushed rules make the verify run stop them; the agent user has uid 2001, cron and SSH refuse it, logind kills its session processes, and the process checks fail for a system service or a system container running as it.

Not covered in CI: the `api` group against the real API (no images yet), a disk quota, WSL, and anything on the real server. Those run on the server (#130).

## Known gaps

- **No production images for the API and web.** [`deploy/compose.server.app.yaml`](../../deploy/compose.server.app.yaml) fixes how they will run (image names from `STUDIO_API_IMAGE` and `STUDIO_WEB_IMAGE`, both run as uid 10001, the root-only `.env` for the API, nothing secret for the web, host ports on `127.0.0.1` only); `agentic-studio-compose` adds it once both are set. Building the images, running database migrations (`pnpm db:migrate:deploy`) in a deployment and the web app's build-time `/api` proxy settings are follow-up work.
- **Trusted proxy for the API.** Which address the API trusts for `X-Forwarded-For` (the web container, at a fixed address) is settled with the images; until then `API_TRUSTED_PROXIES` is empty, so all clients share one login rate-limit bucket: a misled agent (or anything else on the host) could exhaust it and lock the operator out of login. Resolved in #132.
- **IPv4 only.** The firewall rule is `iptables` only; Studio's container network has no IPv6. Add an `ip6tables` rule if IPv6 is ever turned on for it.
- **The CLI runners** are being built (#105, #106); the install and login steps above follow them.
- **On-server verification** (#130): the setup and boundary checks on the target server, the rootless Docker trial repeated there, one real Run per enabled provider, the branch protection check and the compliance records' revalidation note.
