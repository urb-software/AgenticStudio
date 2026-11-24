# Trial report: a Preview user's rootless Docker and routing from the reverse proxy (2026-11-24)

Trial for [ADR 0004](0004-preview-isolation.md) (#273), run on 2026-11-24 in a separate, disposable WSL 2 distribution, as the operator decided for this trial. Output is redacted: no hostnames, account names (other than the roles `agent` and `preview`), addresses of the machine, tokens or ids. Throwaway scripts and files are in [`0004-trial/`](0004-trial/); they are evidence, not production code.

**Result, one line per question**

| Question | Result | Recommendation |
| --- | --- | --- |
| 1. Isolation between users | Neither user can use the other's socket, see its containers or volumes, or read its data-root. | Create both users as in [Setup](#setup-steps) and run the negative checks as part of server setup. |
| 2. Routing | A Unix socket bridge worked with the proxy running as a non-root user; a port on a host address worked only with a firewall rule. | **A socket per Preview** (b), bridged by `socat` from the Preview user's account, the socket's group is the proxy's group (the Preview user is a member only to be able to set it), and a static wildcard hostname-to-socket route. |
| 3. Limits | A per-project systemd slice used as `cgroup_parent` bounds a whole Compose project. | A slice per Preview, injected by the controller; the controller's override sets `cgroup_parent` (the Compose validation already refuses the Repository's own). |
| 4. Network | Loopback is blocked by the rootless networking; Studio's networks and other users' ports need rules in the daemon's own namespace. | `DOCKER-USER` rules inside the Preview daemon's namespace, re-applied at each daemon start. |

**Limit of the trial:** WSL is not a server (see [What WSL could not verify](#what-wsl-could-not-verify)). Everything below was observed in the trial distribution only. The first check on a real server is the server setup that adds the Preview user (#275, #277).

## Environment

- Windows 11 host, WSL 2, distribution imported from the official Ubuntu 24.04 image, WSL kernel 5.15, systemd 255 on, cgroup v2 only with controllers `cpuset cpu io memory hugetlb pids rdma misc` at the root. The VM has about 3 GB RAM, 1 GB swap and 2 CPUs, shared with other distributions.
- `/etc/wsl.conf`: systemd on, `[automount] enabled=false`, `[interop] enabled=false` (the settings [ADR 0002 trial](0002-trial-rootless-docker.md#security-finding-wsl) found necessary).
- Docker Engine and Compose from Docker's official apt repository: Docker 29.10.0 (system daemon, root, as Studio's stack), Compose 5.8.0. Rootless setup from the `docker-ce-rootless-extras` package: rootlesskit 3.3.0, `slirp4netns` 1.2.1 (the default network driver). Caddy 2.11.9 (`caddy:2-alpine`), socat 1.8.0, Python 3.12 (client and test server only).
- Images: `alpine:3.22`, `python:3.13-alpine`, `caddy:2-alpine`.
- Stand-ins for Studio's side: a Docker network with the same subnet as `deploy/compose.server.yaml` (`172.31.250.0/24`, gateway `.1`, dynamic range `.128/25`), Caddy at `.2` with `admin off` as in `deploy/Caddyfile` (plain HTTP on 8081, published on the host loopback), and a Python HTTP server at `.10` standing in for the database, queue and API.
- The Preview service is a WebSocket echo server written for the trial (`0004-trial/ws_echo.py`): it answers `hello-plain` to a plain request and echoes a text frame after an upgrade. `0004-trial/ws_client.py` sends one frame and prints the echo.

## Setup steps

All as an admin user with passwordless `sudo`; the helper `asu USER CMD...` (`0004-trial/asu.sh`) runs a command as a user with that user's rootless socket.

1. Docker's apt repository, then `apt-get install docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras uidmap slirp4netns dbus-user-session iptables socat netcat-openbsd`.
2. `useradd -m -s /bin/bash` for `agent`, `preview` and `other` (the "ordinary third user"). `loginctl enable-linger agent preview`. `sudo -l -U agent` and `-U preview`: "not allowed to run sudo". `/etc/subuid` gave each user 65536 ids. Home directories came out `drwxr-x---` (0750).
3. For `agent` and `preview`: `dockerd-rootless-setuptool.sh install`, then `systemctl --user enable --now docker.service` (a systemd user service).

```text
$ asu preview docker info | grep -E "Cgroup|rootless|Storage Driver|Root Dir"
 Storage Driver: overlayfs
 Cgroup Driver: systemd
 Cgroup Version: 2
  rootless
 Docker Root Dir: /home/preview/.local/share/docker
```

## Question 1: isolation between the two users

`0004-trial/probe-isolation.sh`. Each user ran one container with a named volume. Observed:

| Check | Result |
| --- | --- |
| Each user's own `docker ps` and `docker volume ls` | Only its own container and volume. |
| `ls /run/user/<uid>/docker.sock` as the other user | `Permission denied`; `/run/user/<uid>` is `drwx------`. |
| `agent` with `DOCKER_HOST` set to the `preview` socket, `docker ps` | `permission denied while trying to connect to the docker API`. |
| `curl --unix-socket` the same socket as `agent` | exit 7 (no connection). |
| `preview` with `DOCKER_HOST` at the `agent` socket; `other` at both | `permission denied`, each. |
| `agent` listing `/home/preview/.local/share/docker/volumes` and reading `preview-vol/_data/s` | `Permission denied` (the home is 0750). |
| `preview` listing the `agent` volumes; `other` listing the `preview` data-root | `Permission denied`. |
| `agent` reading `/proc/<preview dockerd pid>/environ` | `Permission denied`. |
| `id`, `getent group docker` | Neither user is in `docker` (the group has no members). |
| `sudo -n true` as each | `a password is required`. |
| System socket `/var/run/docker.sock` (`root:docker`, 0660) with the docker CLI as each | `permission denied`. |

Both daemons ran at the same time (`rootlesskit`, `slirp4netns` and `dockerd` per user, as that user). The Preview daemon's default bridge (`172.17.0.0/16`) lives in its own network namespace.

**Recommendation.** Keep the model as decided. The boundary is the file permission on `/run/user/<uid>` and on the home directory, which the distribution's defaults give.

**Server setup must:** create the users without the `docker` group or `sudo`; enable linger; install the rootless daemon as a user service for each; then run these negative checks (extending [Security](../../engineering/security.md) §9) and fail on any success: each socket from the other user and from a third user, the data-root listing, `sudo -n`, the system socket. Home directories must be 0750 or tighter.

## Question 2: routing from the reverse proxy

### (a) A port published on a host address only the proxy can reach

- The Preview container was started by the rootless daemon with `-p 172.31.250.1:20001:8000`; the address is the gateway of Studio's Docker network. `ss -ltnp` showed the listener owned by `rootlesskit`.
- Route file `routes/p1.caddy` (one block per file, `reverse_proxy 172.31.250.1:20001`), imported by the Caddyfile.

`0004-trial/probe-routing.sh 172.31.250.1 20001` before any firewall rule:

```text
host root                       : REACHED (hello-plain)
host user agent (not the proxy) : REACHED (hello-plain)
host user other (not the proxy) : REACHED (hello-plain)
agent's rootless container      : REACHED (hello-plain)
studio network, other container : REACHED (hello-plain)
proxy container (Caddy)         : REACHED (hello-plain)
```

So the address alone separates nothing. A rule scoped to this trial's own address and network interface:

```text
iptables -N TRIAL-PREVIEW-IN
iptables -A TRIAL-PREVIEW-IN -i br-trial -s 172.31.250.2/32 -j ACCEPT
iptables -A TRIAL-PREVIEW-IN -j REJECT
iptables -I INPUT 1 -d 172.31.250.1/32 -p tcp --dport 20000:20999 -j TRIAL-PREVIEW-IN
```

After it: every row above was `blocked` except the proxy container, which was `REACHED`. The counters showed 17 packets accepted and 7 rejected. A WebSocket upgrade through Caddy to `p1.preview.test` returned `HTTP/1.1 101 Switching Protocols` and `echo: ping-from-client`.

**Result (a):** works, with these properties.

- Another local user, `agent`'s containers and any other container on Studio's network are kept out **only by the rule**; without it every one of them reaches the service.
- The rule trusts the proxy's source address. A container on Studio's network that can forge a source address (`NET_RAW`) was **not tested**.
- Docker's network, when created with an `ip_range` and no `gateway`, gave the bridge the address `172.31.250.128`, not `.1` (`docker network inspect`: `"Gateway":"172.31.250.128"`). The compose file in `deploy/compose.server.yaml` has the same IPAM block without a gateway; this was observed with `docker network create` using the same values, not with the compose file. A routing design that publishes on the gateway must set it explicitly.
- Each Preview needs a port from a range kept by the controller, a published port injected through an override file, and the firewall rule installed at setup (root, once, not at run time).

### (b) A Unix socket, bridged from the Preview user's account

Setup: group `previewproxy` (the proxy's group; the Preview user is a member only so it can set the socket's group), `usermod -aG previewproxy preview`, directory `/run/preview-proxy` owned `preview:previewproxy`, mode 0750. The Preview container publishes **no port**; the controller reads its address inside the daemon's namespace and bridges it:

```text
IP=$(asu preview docker inspect -f '{{.NetworkSettings.Networks.bridge.IPAddress}}' echo2)
CP=$(cat /run/user/<uid>/dockerd-rootless/child_pid)
socat UNIX-LISTEN:/run/preview-proxy/p6.sock,fork,mode=660,group=previewproxy \
  'EXEC:nsenter -U --preserve-credentials -n -t '$CP' socat STDIO TCP\:'$IP'\:8000'     # as preview
```

- The outer `socat` runs in the Preview user's own namespaces, so the socket gets the real group (`srw-rw---- preview previewproxy`). The inner one enters the daemon's network namespace to reach the container.
- No TCP listener exists (`ss -ltnp | grep socat`: none).

| Who | Result |
| --- | --- |
| `preview` (`curl --unix-socket`) | `hello-plain` |
| `agent`, `other` | exit 7, no connection |
| A non-root container (`--user 65534`) with the directory mounted but without the group | `Permission denied` |
| Caddy as `--user 65534 --group-add <gid>` with the directory mounted read-only | proxied: plain request answered, WebSocket upgrade `101`, echo returned |

A root container on Studio's network would pass the file permission; Studio's own services must not run as root with this directory mounted (the setup runs the proxy as a non-root user with the group).

**How a route is added and removed without restarting Caddy.** With `admin off`:

- `caddy reload --config ...` inside the container fails: `dial tcp [::1]:2019: connect: connection refused`. A restart is the only way unless the proxy reloads itself.
- **`caddy run --config ... --watch` reloaded on a change to any imported file** (new, edited and removed route files each triggered one reload, logged by the `watcher`), with the admin API still off. A route file with a missing brace did not break the running config: the log said `unable to load latest config` and the previous routes kept answering. After the broken file was removed, the next reload succeeded.
- **A wildcard route needs no file and no reload at all.** `routes/wild.caddy`:

  ```text
  http://*.preview.test:8081 {
  	@pv header_regexp pv Host ^([a-z0-9-]{1,40})\.preview\.test(:[0-9]+)?$
  	handle @pv {
  		reverse_proxy unix//run/preview-proxy/{re.pv.1}.sock
  	}
  	respond 404
  }
  ```

  A new socket `p7.sock` answered the next request (`hello-plain`, WebSocket `101` and echo) with no file written and no reload. After the bridge was stopped and the socket deleted, the same hostname returned `502`. An unknown name also returned `502` (the socket is absent), so a real Caddyfile needs a `handle_errors` mapping if a 404 is wanted. The regular expression keeps the label to a safe character set, so it cannot name another path. Hostnames that did not match fell through to the stand-in's catch-all block (`200`), which is the trial's test block, not a design.
- An admin API on a Unix socket for the controller only was **not tried**.
- The Preview password (`basic_auth` per Project) was **not tried**. The wildcard route cannot carry a per-Project password by itself. The recommended ways, both **not tried**: Caddy's `forward_auth` to an endpoint of Studio that checks the password for the hostname, or route files generated **on Studio's side** from validated data. The Preview user must never write proxy configuration.
- **Rejected: per-route files written by the Preview user, reloaded with `--watch`.** It worked technically (above), but the proxy holds Studio's TLS keys and ACME data, sits on Studio's internal network next to the API and serves Studio's own site, so configuration written by the Preview user (the controller, which runs beside untrusted Repository code) would let a compromise of that user change what the proxy does. The Preview user only creates sockets.

**Rejected:** nothing needed root or the system Docker socket **at run time** in (a) or (b); (a) needs one root-installed firewall rule at setup.

**Label-driven routing.** Not tried. A proxy that builds routes from container labels would need the Preview daemon's API socket, which is the Preview user's boundary, so it is **rejected** under the rule of the Definition of Ready. The chosen routing never reads labels, so no label refusal is needed in the Compose validation for it (the validation does not refuse labels today); this answers the note on #274.

**Recommendation: (b).** It leaves no TCP port at all on the host, so the question "who else can connect" is answered by one file permission, not by a firewall rule that must stay correct. It worked with a non-root proxy.

**Server setup must:**

- create the group `previewproxy` and the directory `/run/preview-proxy` (0750, `preview:previewproxy`) at every boot, for example with a `tmpfiles.d` entry;
- add the Preview user to the group, and the group (`group_add`) to the proxy service, which runs as a non-root user and mounts the directory read-only;
- configure one static wildcard route in Studio's Caddyfile that matches only `^preview-[0-9a-f]{12}\.<preview domain>$` and proxies to `unix//run/preview-proxy/{re.pv.1}.sock`, with `handle_errors` so a missing socket answers `404` (the trial's `502` is what Caddy gives without it); the Preview password is checked by Studio (see above), not by files the Preview user writes;
- keep `/run/preview-proxy` holding **only** Preview bridge sockets: no controller or admin socket, since the proxy's group can connect to every socket in it;
- have the controller create one bridge per Preview and tie its lifetime to the container id: the bridge must resolve the container address per connection, or be re-created whenever the container restarts (the trial resolved the address once), and the socket is removed with the bridge.

**Costs found:** each connection starts a `nsenter` and a `socat` process (not measured under load), and the bridge targets the daemon's namespace, so it dies when the Preview daemon restarts (see [Pitfalls](#pitfalls)); the controller must re-create it.

## Question 3: limits for a whole Compose project

`systemd` 255 delegates `cpu memory pids` (not `cpuset` or `io`) to the Preview user's manager by default: `cat .../user@<uid>.service/cgroup.controllers` printed `cpu memory pids`. `docker info` as `preview` warned `No cpuset support` and `No io.weight support`; memory and CPU limits are supported. Containers are placed in `.../user@<uid>.service/user.slice/docker-<id>.scope`.

**A. Limits per service, two spellings** (`0004-trial/compose.limits.yaml`). `mem_limit: 64m`, `cpus: 0.5` and `deploy.resources.limits` (`memory: 64M`, `cpus: '0.5'`) both became `HostConfig.Memory=67108864`, `NanoCpus=500000000`.

- **Memory limit hit.** The hog (`tail /dev/zero`) was killed: `exit=137 OOMKilled=true`. `docker events` showed `oom` then `die` (`exitCode` 137) for the container.
- **CPU limit hit.** A busy loop showed `cpu=52.99%` in `docker stats`; the container's `cpu.max` was `50000 100000` and `cpu.stat` showed `nr_throttled 103`. It is throttled, not killed.
- These limits apply per container, not to the project as a whole.

**B. A slice for the whole project** (`0004-trial/compose.hogs.yaml`, four services, none with limits). The Preview user's `~/.config/systemd/user/preview-p1.slice`:

```text
[Slice]
MemoryMax=96M
MemorySwapMax=0
CPUQuota=50%
TasksMax=200
```

After `systemctl --user daemon-reload`, an override file (`compose.slice-override.yaml`) set `cgroup_parent: preview-p1.slice` on each service. Observed:

- Two memory hogs started together exceeded 96 MB: **both** were killed (`exit=137 OOMKilled=true`, `oom` and `die` events). The slice's `memory.events` counted `oom_kill 2`. The two CPU hogs kept running and the daemon stayed up (`docker version` worked).
- The two CPU hogs together used about 50% of one CPU: `docker stats` showed 25.62% and 24.71%; the slice's `cpu.stat` showed `nr_throttled 345` of `nr_periods 349`.
- systemd nested the slice under an implicit `preview.slice` (`.../user@<uid>.service/preview.slice/preview-p1.slice`), which can carry a limit for all Previews together. **Not tried.**
- The kernel chose what to kill inside the slice; a project cannot say which of its services is killed.

**C. The Repository's file can choose its own parent.** A file with `cgroup_parent: user.slice` ran in `user.slice` (no limit). With the override as a second `-f` file, the later file won (`parent=preview-p1.slice`). So the override works. The Compose validation's allow list already refuses `cgroup_parent` in the Repository's file (`unknown_key`); the follow-up is a regression fixture that pins it, not a new refusal.

**Recommendation.** One slice per Preview, `preview-<id>.slice`, written by the controller into the Preview user's unit directory with `MemoryMax`, `MemorySwapMax=0`, `CPUQuota` and `TasksMax`, then `systemctl --user daemon-reload`; the controller injects `cgroup_parent` into every service through its override file and removes the slice when the Preview is deleted. The Compose validation already refuses `mem_limit` and `cpus` as unknown keys; only `deploy.resources.limits` passes, and it only tightens further.

**Server setup must:** keep linger on; confirm `cpu memory pids` in the user manager's `cgroup.controllers` (fail the setup check otherwise); keep swap in mind, since `MemorySwapMax=0` is what made the memory limit bite on a host with swap; not touch `user@.service` delegation unless `cpuset` or `io` limits are wanted.

**Not covered:** the image build runs in the daemon's own cgroup (`.../app.slice/docker.service`), not in a Preview slice. A build's memory and CPU limit was **not tried**; the build's time limit is the controller's.

**Required of the controller:** the override forces `restart: "no"` on every service, and the controller starts or restarts Previews only after the egress rules read-back check passes (see Question 4).

## Question 4: network blocking

`0004-trial/probe-network.sh`. Targets, from a container started by the Preview user's rootless daemon (`alpine`, `wget`): a public HTTPS site; the slirp gateway `10.0.2.2` (the host's loopback, a listener on `127.0.0.1`); a listener on `0.0.0.0` reached through the host's non-loopback address; the stand-in for Studio's internal services; the proxy; and a port the `agent` user's container had published on all addresses.

| Target | Baseline (no rule) | With the rules below |
| --- | --- | --- |
| Outbound HTTPS | reached | reached |
| Host loopback via `10.0.2.2` | **blocked** | blocked |
| Host non-loopback address | reached | blocked |
| Studio stand-in service (`172.31.250.10`) | reached | blocked |
| The proxy (`172.31.250.2`) | reached | blocked |
| The `agent` user's published port | reached | blocked |

**Which mechanism does each:**

- **Outbound internet:** `slirp4netns` user-mode NAT. No rule needed.
- **Host loopback:** `slirp4netns --disable-host-loopback`, which the setup tool passes by default (visible in `ps`: `slirp4netns --mtu 65520 -r 3 --disable-host-loopback ...`). It was the only thing blocked at baseline.
- **Everything else on the host's networks:** nothing blocks it by default. The container's traffic leaves through the daemon's `tap0` into `slirp4netns`, which makes the connection from the host as the Preview user. The container reached Studio's stand-in, the proxy and the other user's published port.
- **The agent user's containers:** their addresses live in the agent daemon's namespace and are not reachable by address; what was reachable was a port the agent daemon **published on the host**, which is a host address and is covered by the same rules.

**The rules.** Added inside the Preview daemon's own network namespace, in Docker's `DOCKER-USER` chain (`nsenter -U --preserve-credentials -n -t <child pid>`, run as the Preview user, no root): `0004-trial/preview-egress-rules.sh`. In short: accept DNS to the daemon's resolver and to `10.0.2.3`; reject `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` and `100.64.0.0/10` for traffic out of `tap0`.

- **DNS was blocked at first:** the first rule set had only `10.0.2.3`; name resolution failed (`nslookup: ... Connection refused`) because Docker's embedded DNS in the container forwards to the address in the host's `/etc/resolv.conf`, which was a `10.x` address here. Allowing port 53 to that address fixed it (`nslookup example.com` answered; an IP-literal HTTPS request also worked).
- **The rules are lost when the daemon restarts:** after `systemctl --user restart docker.service`, `DOCKER-USER` was empty. A drop-in `ExecStartPost=` running the script restored 11 lines of rules and the table above; the probe gave the same result.
- **Rejected alternative: a host rule on the Preview user's uid.** `iptables -I OUTPUT 1 -d 172.31.250.0/24 -m owner --uid-owner <preview uid> -j REJECT` blocked the container but also the Preview user's own processes: `curl` as `preview` to the stand-in returned code `000`, and `200` after the rule was removed. The controller runs as that user and must reach Studio, so a uid rule would block it. The rules inside the daemon's namespace do not touch the controller (`curl` as `preview` to the stand-in returned `200` with the rules in place).

**Recommendation.** Filter in the Preview daemon's namespace, not on the host.

**Server setup must:** install `preview-egress-rules.sh` (or its equivalent) and the `ExecStartPost=` drop-in for the Preview user's `docker.service`; add the host's own public addresses to the reject list (private ranges do not cover them; not testable here) and the IPv6 equivalent (**not tried**); set the resolver explicitly so the DNS exception names it (for example `dns` in the rootless `daemon.json`, since a resolver on `127.0.0.53` behaves differently, **not tried**); and add a check that the controller runs before it starts any Preview, reading the rules back and refusing to start without them (**not tried**).

**Window after a daemon restart (reasoned, not reproduced):** the user service is `Type=notify`, so `ExecStartPost=` runs after the daemon is ready, and containers with a restart policy may start before the rules are applied. Hence the controller's override forces `restart: "no"` on every service, and the controller (not the daemon) restarts Previews, only after the read-back check.

**Not verified, to include in the blocking test of #275:** egress from a Compose project network (not the default bridge; the rule matches by output interface `tap0`, which should cover it, but it was only run from the default bridge) and from a build `RUN` step (the build runs in the daemon, not in a container of the project). A test must prove the blocking, as the network decision requires: this table is its model.

## What WSL could not verify

- **WSL is not a server.** All WSL 2 distributions share one kernel and one network stack. The trial's bridge, its published ports and the host-level rule of (a) lived in that shared stack; whether other distributions saw them was not checked. Rules were scoped to the trial's own interface and addresses, written down above, and removed at the end (verified: no `TRIAL` chain left, `INPUT` and `OUTPUT` back to their defaults).
- **Host-level firewall rules last only until the WSL VM restarts.** The persistence of any rule across a reboot was not tested.
- **The distribution stops when no session is open.** The distribution restarted once between two commands, and every container exited with 255 (a restart policy was not tried). A background session kept it alive for the rest of the trial. Boot ordering on a real server (system Docker, its network, the firewall, the Preview daemon, linger) was not tested.
- **Kernel and network.** The WSL kernel is 5.15 and the VM has one network interface with a generated resolver address; a real server has its own kernel, public addresses, IPv6 and probably `systemd-resolved`. `pasta` instead of `slirp4netns` was not tried.
- **No TLS and no Preview password.** Caddy ran on plain HTTP; the production `tls` and `basic_auth` blocks, `handle_errors` and `X-Forwarded-*` behaviour were not exercised.
- **No load and no hostile Compose file.** Throughput, the process cost of the socket bridge, a service that ignores the validation, and source-address forgery on Studio's network were not tested.
- **cgroup v2 here was configured** (`cgroup_no_v1=all`); the server's default was not checked.

## Pitfalls

- **A route file written as one line is not valid Caddyfile.** `http://p1... { reverse_proxy ... }` on one line made Caddy refuse to start (`Unexpected '}'`), so a restart with a bad imported file takes the proxy down; `--watch` keeps the old config instead.
- **`socat` inside the rootless user namespace sets the wrong group.** Run with `nsenter -U`, `group=previewproxy` became group id 297613 (a mapped sub-id), not the proxy's group. The socket must be created by a `socat` outside the namespace, which is why the bridge has two.
- **`EXEC:` splits its argument at colons.** `TCP:<ip>:8000` had to be written `TCP\:<ip>\:8000` ("wrong number of parameters (3 instead of 1)").
- **Docker 29 changed the inspect path:** `.NetworkSettings.IPAddress` is gone; use `.NetworkSettings.Networks.bridge.IPAddress`.
- **A published or bridged address changes when the Preview daemon restarts.** The namespace and the container addresses are recreated; the bridge's `child_pid` and target address are stale. The controller must re-create bridges and the firewall rules after any daemon restart.

## Items for later stories (not decided here)

- **Routing (#277):** the bridge process per Preview, the socket directory and its group at boot, the static wildcard route with `handle_errors`, the socket directory and its group at boot, and how Studio checks the Preview password (`forward_auth` or Studio-generated route files).
- **Server setup (#275):** the users, groups, directory, slice delegation check, egress rules and the drop-in; each negative check above as a boundary test.
- **Compose validation:** a regression fixture that `cgroup_parent` stays refused; no label refusal is needed.
- **First check on a real server:** repeat Questions 1, 2 and 4's tables there, and the limit check of Question 3.
