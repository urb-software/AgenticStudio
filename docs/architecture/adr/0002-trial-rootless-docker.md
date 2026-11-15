# Trial report: rootless Docker for agent runs (2026-11-15)

Trial for [ADR 0002](0002-agent-run-isolation.md) (#94), run by the coordinator on 2026-11-15 in WSL on the operator's machine. Project: AgenticStudio itself (a public repository). Output is redacted: no hostnames, account names, tokens, ids or temporary paths.

**Result:** the project's Compose stack comes up under rootless Docker as an ordinary user, and its unit, integration and end-to-end tests pass. Both negative checks fail as expected. Docker is reachable from the Codex `workspace-write` sandbox only with network access enabled, so the Codex sandbox is kept (ADR 0002, [Run decisions](0002-agent-run-isolation.md#run-decisions-2026-11-15)). The ADR's decision stands.

**Limit of the trial:** WSL with default settings is not an isolation boundary (see [Security finding: WSL](#security-finding-wsl)), so the operating-system boundary checks here are valid for a native Linux server only. The trial is repeated on the target server in the server setup task (#107).

## Environment

- Windows 11 host, WSL 2, Ubuntu 22.04, WSL kernel 5.15, no systemd, WSL VM with about 3 GB RAM.
- A new user `agent` (`useradd -m`): not in the `docker` group, no `sudo` (`sudo -l -U agent`: not allowed). A subuid/subgid range of 65536 was assigned automatically.
- Project: AgenticStudio at commit `683bd57`, cloned over HTTPS. Node.js 24 from a user-local tarball, pnpm 11.22 through corepack.
- CLIs: Claude Code 2.1.325 and Codex 0.169.0, signed in as `agent` by the operator; API key environment variables unset.

## Setup steps

As root:

1. `apt install uidmap slirp4netns dbus-user-session iptables fuse-overlayfs`.
2. The browser's system libraries for the end-to-end tests: `playwright install-deps chromium`.

As `agent`:

1. Docker's official rootless install script with `FORCE_ROOTLESS_INSTALL=1 SKIP_IPTABLES=1` (a system Docker was already present in the distro and was not touched). Docker Engine 29.9.3.
2. Without systemd, `dockerd-rootless.sh` was started by hand in the background (`setsid`).
3. Environment: `PATH=$HOME/bin:$PATH`, `XDG_RUNTIME_DIR=$HOME/.docker/run`, `DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock`.
4. Docker Compose plugin v2.35 (the one already present in the distro), working against the rootless daemon through `DOCKER_HOST`.

`docker info`: security options `seccomp` and `rootless`, storage driver `overlayfs`, cgroup v1 with cgroup driver `none`.

## Changes needed

| Area | Change |
| --- | --- |
| Compose file | None. |
| Environment variables | `.env` from `.env.example` with `POSTGRES_PORT=55432` and `REDIS_PORT=56379`, only to avoid clashes with other stacks on the machine. Testcontainers (and its Ryuk container) needs `DOCKER_HOST` and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=$XDG_RUNTIME_DIR/docker.sock`. |
| Port restrictions | Host ports above 1024 work rootless. Ports below 1024 would need `net.ipv4.ip_unprivileged_port_start`; the project does not use them. |
| Kernel or system settings | None. |
| System packages | The rootless prerequisites above, and Playwright's browser libraries, both installed by root. |
| File ownership | No problem found. |
| Networking | No difference observed for the project (slirp4netns user-mode networking). |

## Results per test level

| Level | Command | Exit | Result |
| --- | --- | --- | --- |
| Install | `pnpm install --frozen-lockfile` | 0 | 62 s |
| Compose stack | `docker compose up -d --wait` | 0 | PostgreSQL and Redis healthy |
| Migrations | `pnpm db:migrate:deploy` | 0 | Applied |
| Unit + integration (API, Testcontainers PostgreSQL and Redis) | `pnpm test:api` | 0 | 43 files, 1124 passed, 4 skipped (the CI-only "no silent skip" guards, which run only when `GITHUB_ACTIONS=true`) |
| Unit (web) | `pnpm test:web` | 0 | 34 files, 273 passed |
| End-to-end | `pnpm e2e:smoke` | 0 | 7 passed, 3 skipped (platform variants, by design); the repository guard passed in both projects |
| Teardown | `docker compose down -v` | 0 | Stack and volumes removed |

The first end-to-end attempt failed only because the browser's system libraries were missing (`libnspr4.so`), not because of Docker. After the run, the only container left was Testcontainers' Ryuk container, which removes itself.

## Negative checks (as `agent`)

| Check | Result |
| --- | --- |
| System Docker socket `/var/run/docker.sock` with the docker CLI | `permission denied` |
| The same socket with `curl --unix-socket` | HTTP code `000` (no connection) |
| Root-only directory: `ls /root` | `Permission denied` |
| `sudo -n true` | `a password is required` |

## Claude Code

Non-interactive run as `agent` in a throwaway Git repository in a temporary directory (deleted afterwards). Prompt: run exactly `docker run --rm hello-world` and report the second line of output or the exact error.

```text
claude -p --output-format stream-json --verbose --permission-mode dontAsk \
  --setting-sources user --strict-mcp-config --max-turns 5 \
  --allowedTools "<rules>" -- "<prompt>" < /dev/null
```

| `--allowedTools` | Exit | Result |
| --- | --- | --- |
| `Read,Edit,Write` | 0 | Result `success` with one permission denial ("Permission to use Bash has been denied because Claude Code is running in don't ask mode"); no container started. |
| `Read,Edit,Write,Bash(docker run:*)` | 0 | No denials; tool result "Hello from Docker!". **Works.** |

- **Permission rule needed:** `Bash(docker run:*)` for this check. A real run needs a wider rule set for Docker and Compose (for example `Bash(docker:*)`, `Bash(docker compose:*)`), to be set by the provider story (#105).
- Compared with the compliance record's Mode, the run did not pass `--permission-prompts none` or a `--settings` guardrail file (none exists yet). `dontAsk` alone denied the prompt-requiring call without waiting.

## Codex

Same prompt and throwaway repository, as `agent`.

```text
codex exec --json --cd <repo> --sandbox workspace-write \
  -c approval_policy="never" [<extra -c>] "<prompt>" < /dev/null
```

| Extra option | Exit | Result |
| --- | --- | --- |
| None (network access off, the default) | 0 | Agent reported "permission denied while trying to connect to the docker API at unix:///home/agent/.docker/run/docker.sock". Socket not reachable. |
| `-c sandbox_workspace_write.network_access=true` | 0 | Command output "Hello from Docker!". **Works.** |

The sandbox was also probed directly, without a model call, with `codex sandbox -c sandbox_mode="workspace-write"`:

- Network access off: the Docker socket is not reachable (docker CLI "permission denied while trying to connect…", `curl` exit code 7).
- `-c sandbox_workspace_write.network_access=true`: `docker ps` and `docker run hello-world` work.
- A direct write outside the workspace is still refused ("Read-only file system").
- `docker run -v $HOME:/h alpine touch /h/escape-probe` **succeeded**: the daemon mounts anything the agent user can read or write, so with Docker reachable the sandbox is an extra guardrail, not a boundary.

**Answer:** the rootless Docker socket is reachable from inside `workspace-write` only with network access enabled. `danger-full-access` was not needed, so it was not tried. Following the operator's rule of 2026-11-15, the posture is **sandbox kept** (`workspace-write` with `sandbox_workspace_write.network_access=true`).

## Resource observations

- Docker data directory: about 570 MB after the stack and the test images.
- WSL VM: 2.9 GB in total, about 0.9 GB used at idle with the stack up; all suites completed in that VM.
- No per-container memory or CPU limits and no `docker stats` numbers: under WSL the daemon runs on cgroup v1 with no cgroup driver. The target server needs cgroup v2 and systemd for container resource limits; disk quotas for the agent user's Docker data directory are a separate setting.

## Security finding: WSL

WSL interop was enabled (the `WSLInterop` binfmt entry): the `agent` user could run Windows programs (`cmd.exe` ran), which run as the Windows user. The Windows drive was mounted world-writable (`/mnt/c/Users/<user>` was `drwxrwxrwx`): `agent` read the Windows profile and wrote to its temporary folder. **WSL with default settings is therefore not an isolation boundary.** The operating-system user boundary holds on native Linux, or on WSL with `[interop] enabled=false` and `[automount] enabled=false` in `/etc/wsl.conf`, which affects every user of the distro. Recorded in ADR 0002 and as a server setup check in [Security](../../engineering/security.md) §9.

## Pitfalls

- **Rootless CLI context.** The setup tool's `rootless` CLI context captured WSLg's `XDG_RUNTIME_DIR` and pointed at the wrong socket. Fixed by removing the context and using `DOCKER_HOST`.
- **No systemd.** The rootless daemon had to be started by hand; on the server it runs as a systemd user service.
- **`--allowedTools` is variadic.** It swallowed a following prompt ("Input must be provided either through stdin or as a prompt argument"). End the options with `--` before the prompt.
- **Trailing punctuation in prompts.** A trailing "." after the command in the prompt was passed as an argument by the Codex agent. Quote commands in backticks.

## Items for later stories (not decided here)

- **Provider story (#105):** Claude Code needs Docker and Compose permission rules (`Bash(docker …)`); the worker ends CLI options with `--` before the prompt.
- **Runs:** Testcontainers needs `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` (and `DOCKER_HOST`) in the run environment.
- **Server setup (#107):** install the Docker Compose plugin for the agent user (`~/.docker/cli-plugins`); install Playwright's system libraries as root; run the rootless daemon as a systemd user service on cgroup v2, so container resource limits work; on any WSL host, disable interop and automount.
