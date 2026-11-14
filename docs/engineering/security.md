# Security Guardrails — AI Agent Studio

**Status:** design-time minimum controls and threat model. Permission enforcement, secret stores, sandboxing, allowlists and negative tests are **not yet implemented**; they are prerequisites for real unattended CLI agent execution.

## 1. Threat model and trust boundaries

The system runs code and tools against potentially hostile repository content. Key threats:

- Prompt injection in repository files, Issues, README files, logs, MCP tool responses, fetched documentation.
- Data exfiltration via shell, logs, arbitrary HTTP/network egress, commit contents, agent-visible environment variables.
- Cross-project filesystem escape, symlink traversal, path confusion, rogue working copies, Git credential misuse.
- Docker privilege escalation, unapproved Compose actions, host access, untrusted Preview content.
- Unsafe dependency installation, arbitrary shell hooks, malicious configuration.
- Duplicated jobs/events, replay, stale authorization, unintended merges, destructive migrations.

**Trust boundaries:** operator's admin session; Studio UI/REST API; PostgreSQL/Redis; untrusted project repository; agent runner; MCP servers; environment-controller; Docker host; exposed Preview origin. Credentials and authority stay narrow across each boundary.

## 2. Agent execution policy

Run isolation model: [ADR 0002](../architecture/adr/0002-agent-run-isolation.md).

- Each run has an **assigned project, working copy, branch, approved tool set, time/resource budget and explicit run identity**.
- **Where runs execute.** Studio (web, API, database, secrets, repository copies) runs in containers under the system Docker daemon, which only root controls. The agent worker and the agents it starts run on the host as an ordinary user, the **agent user**: never in the `docker` group, no passwordless `sudo`, no access to Studio's files. This operating-system boundary is the security boundary.
- **Working copy per run.** Each run works in its own clone, made from a per-project cache at the exact commit Studio recorded, on a branch named for the run; the agent definition, task and logs sit beside it, outside the repository. A working copy is an organization mechanism, **not a sandbox**. Enforce filesystem permissions and the user boundary; test path traversal and symlink escape.
- **Docker.** The agent worker and the agents **never obtain privileged Docker host access**: no access to the system Docker daemon or its socket (`/var/run/docker.sock`), no `docker` group membership, never a privileged container. Agents may use a **rootless Docker daemon owned by the agent user** for Compose stacks, integration and end-to-end tests; it grants nothing beyond the agent user's own rights. It is separate from the `environment-controller` (§5), which manages project Preview stacks on Studio's side.
- **The worker always calls Studio**; Studio never reaches into the host. The worker's token is limited to handling runs.
- CLI **hooks and permission rules are guardrails** against destructive mistakes, **not the security boundary**; the user boundary must hold without them.
- User/project code runs with the least capabilities possible: restricted host mounts, file access, process execution, network egress and inter-project access, per task.
- No production credentials or production data for coding agents, and none anywhere on the server; separate development/test accounts and databases.
- Configure execution timeout, cancellation, CPU/RAM/storage limits and output-size/log quotas; repeated operations are idempotent where appropriate.
- No unapproved MCP tools and no configuration changes outside permitted boundaries.

### CLI usage and provider terms — MVP decision (canonical)

- The MVP integrates the **official Claude Code and Codex CLI binaries**, not direct model API calls.
- Before implementing the agent worker, validate that the intended headless execution and authentication flows comply with each provider's **current** terms. A non-interactive CLI command existing does not establish permission for every form of subscription-based automation; consumer subscriptions are not unrestricted programmatic API access.
- The worker must **not extract, intercept, share, or proxy subscription credentials**.
- A small runner interface isolates provider-specific CLI execution. API/SDK runners (calling a model API or provider SDK directly instead of the CLI binary) are **out of scope for MVP**; they may be considered later if provider policy or product needs require it. Running the official CLI binary with an API key or other supported credentials is still a **CLI runner** and in scope; the authentication method is part of each provider's validation.
- **Acceptance gate:** automated execution for a provider stays disabled until its intended authentication and execution model is validated. Validation is per provider; approval for one never implies approval for the other.

#### Provider compliance decision records

Validation produces a durable, auditable decision, not an informal "validated". Technical Tasks **B6** (Claude Code CLI) and **B7** (Codex CLI) each produce a dated record under `docs/engineering/provider-compliance/` (template in that folder's `README.md`) documenting:

- Provider and CLI version.
- Terms and documentation reviewed: source URLs, version or effective date where available, review date.
- Selected authentication method.
- Permitted execution mode and relevant restrictions.
- Evidence from a controlled headless execution test.
- Decision (`Approved`, `Rejected`, or `Needs Clarification`) and the operator who accepted it.
- Next review date and triggers for earlier revalidation.

A provider is enabled in the agent worker only when its task is complete with an `Approved`, still-applicable record.

#### Runtime enforcement: per-provider enablement flags

The provider gate is a **runtime authorization requirement**, not only an instruction to coding agents. The agent worker reads one operator-controlled flag per provider from its deployment configuration:

```text
CLAUDE_CODE_ENABLED=false
CODEX_CLI_ENABLED=false
```

- Both default to disabled. **Fail closed:** only the exact value `true` enables a provider; missing, empty, malformed or `false` means disabled.
- Each provider needs its own flag enabled; enabling one **never** enables another.
- Before spawning any provider CLI process, the worker checks the flag and rejects the execution if disabled. Rejection is an explicit execution failure with a clear, non-sensitive error, not a silent skip.
- Only the trusted operator/deployment configuration sets these values. They **cannot be overridden** by an execution request, workflow definition, agent configuration, MCP response, or model-generated instructions.
- The operator enables a provider only after its compliance record is `Approved` and still applicable. Setting the flag does **not** itself constitute compliance, legal or terms approval.
- If approval is revoked or no longer applicable (e.g. the review date passes or a revalidation trigger occurs), the operator disables the flag before any further executions.
- Required negative tests: [Quality](quality.md) §10.

**Current status:** no provider has been validated; no compliance record exists. Both providers stay disabled until B6/B7 produce `Approved` records.

## 3. Secrets and credentials

- Use a dedicated secret-management mechanism with scoped, revocable credentials. **Never commit `.env` secrets, auth/session tokens, CLI credentials, private keys or MCP secrets.**
- DB/Git definitions store secret references where appropriate, **not secret values**.
- **Chosen mechanism ([ADR 0001](../architecture/adr/0001-secret-store.md)):** Studio-held secrets, such as the private half of a Project's Deploy key, are encrypted in PostgreSQL (AES-256-GCM) behind the `SecretStore` port, with a key-version field per record. The master key comes from the environment (`STUDIO_SECRETS_KEY`, 32 random bytes, base64) and never enters the database, Git, logs or API responses. Key rotation tooling and an external secret manager are deferred.
- Inject only the necessary secret values at the point of authorized use; minimize lifetime and visibility.
- **What an agent run can see ([ADR 0002](../architecture/adr/0002-agent-run-isolation.md)).** Everything the agent user can read is visible to the agent: its own provider CLI logins (subscription login, or an API key as fallback), the agent account's token and the worker's token. These are accepted risks, so each is kept narrow and revocable: the agent account's token is limited to the managed repositories, the worker's token to handling runs.
- **What an agent run cannot see.** Studio's files and secrets: the `SecretStore` contents and master key, Deploy keys, the operator password hash, sessions, and the database and Redis credentials; the system Docker daemon; production credentials, which never exist on the server.
- Redact secrets and sensitive commands/paths from logs, error messages, SSE payloads, CI artifacts, PR descriptions and agent handoffs.
- External or provider session credentials are not copied to other agents unless explicitly supported and authorized.
- Scan source/commits/PRs for secret leaks; test that run logs cannot disclose protected values.

### Dependency supply chain

- **Release age (Issue #30 decision 4):** `pnpm-workspace.yaml` sets `minimumReleaseAge: 10080` (7 days). pnpm refuses to resolve a version younger than that, and `pnpm install --frozen-lockfile` (local and CI) refuses a lockfile entry younger than that, so a fresh compromised release cannot slip in through an update or a hand-edited lockfile.
- **Exclusions** live in `minimumReleaseAgeExclude`, as exact `name@version` entries only (never a bare name or a range), each with a comment.
- **Urgent security fix younger than 7 days:** the implementer adds the exact patched version to `minimumReleaseAgeExclude` with a comment naming the advisory (GHSA/CVE), the tracking Issue and a removal date (at most the day the version turns 7 days old), bumps the dependency, and states the exclusion in the PR's review notes. The independent reviewer checks the advisory and the exact version; the operator's merge is the approval. Once the version is 7 days old, the entry is removed in a follow-up.
- **Adoption baseline (operator-approved, temporary; decision on Issue #30):** the exact versions already locked when the policy was adopted (2026-11-13) are listed as a baseline block, removed once they are all 7 days old (2026-11-18T12:31Z). Removal is tracked in Issue #36. Every other exclusion stays reserved for urgent security fixes.

## 4. Git, branch and merge protection

- Each run works in its own working copy and branch ([ADR 0002](../architecture/adr/0002-agent-run-isolation.md)) and does not write to another run's working copy.
- Studio's own Git operations go through public `projects` contracts and an authorized, path-validated Git adapter, with the Project's Deploy key.
- **Agents reach the Git host only through the agent account**: a separate account, not the operator's, whose token is limited to the managed repositories. Agents push only their own run branches and open pull requests. Studio's Deploy keys never reach the agent.
- Branch protection on each managed Repository keeps protected branches, including the integration branch (default `dev`), under the operator's approval: agents cannot merge, or push to them, directly. Merge stays with the operator.
- A User Story normally lands through one integrated PR; subtasks normally produce commits; independent Technical Tasks may land separately when safe. `dev` is the GitHub default/integration branch; `main` is reserved for stable/release integration.
- Review the diff and relevant test results. Explicit authorization is required for approval/merge, force push, history rewrite, branch deletion, and repository credential changes.
- CI and independent review are preconditions for merge. **The operator is the final manual merge gate**; agents have no unrestricted merge authority.

### Git adapter hardening baseline (connected Repositories)

Rules every Git operation Studio's Git adapter performs on a connected Repository follows, whatever the calling module. Git commands an agent runs in its working copy do not go through the adapter; the agent user's rights (§2) and the agent account's token limit them.

- **Linux only:** repository features run on Linux (containers, CI, VPS); on non-Linux platforms they report an unsupported platform instead of running.
- **Transports:** in production configuration, only `ssh` and `https` remote URLs without embedded credentials; every other transport is rejected. Tests may allow local fixture remotes; production configuration refuses that setting.
- **No submodule recursion** and **no LFS smudge**: Studio downloads only the Repository's own objects.
- **Hooks never run**, from the Repository or from anywhere else.
- **No terminal prompts:** an operation that would need interactive input fails instead.
- **Isolated Git configuration:** the host's system, global and user Git configuration, credential helpers and SSH agents are never used; only Studio's fixed configuration and the Project's Deploy key apply.
- **Time and size limits:** cloning is stopped after 10 minutes, a Fetch after 2 minutes, and a Clone may not exceed 2 GB.
- **Redacted output:** Git output is redacted before it is stored, logged or returned; private keys, credentials and secret-bearing URLs never appear.
- **Strict SSH host-key checking:** pinned host keys for the large Git hosts, an operator-confirmed fingerprint otherwise; an unknown or changed host key fails the operation.
- **Remote address policy (SSRF, Issue #69):** Studio never connects to link-local addresses (`169.254.0.0/16`, `fe80::/10`, with the cloud metadata service), other known metadata addresses (`100.100.100.200`, `192.0.0.192`, `168.63.129.16`, `fd00:ec2::254`, `fd20:ce::254`), `0.0.0.0/8`, `::`, multicast (`224.0.0.0/4`, `ff00::/8`) or reserved and broadcast addresses (`240.0.0.0/4`). Loopback (`127.0.0.0/8`, `::1`), private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`, deprecated site-local `fec0::/10`) and CGNAT (`100.64/10`) addresses are allowed only with `STUDIO_GIT_ALLOW_PRIVATE_REMOTES=true` (default `false`), for a self-hosted Git server on the LAN. IPv4-mapped, IPv4-compatible, IPv4-translated, NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) IPv6 addresses count as the IPv4 address they carry; local-use NAT64 (`64:ff9b:1::/48`) and Teredo (`2001::/32`), whose IPv4 address cannot be read reliably, are refused; any non-address fails closed. Documentation and benchmarking ranges stay public: nothing internal answers there.
  - **Where:** an IP-literal URL is checked at Connect (numeric forms such as `0x7f.1` or `2130706433` normalized first; a numeric host that is no valid address is refused) and refused with a field error. Before every Git or `ssh-keyscan` process, the adapter resolves the host once, under the operation's time limit, and checks **every** address; a refused one fails the operation with `remote_not_allowed`, whose detail names the address and, for an opt-in range, the setting.
  - **DNS rebinding:** Git and ssh connect only to the checked addresses: HTTPS through `http.curloptResolve` (hence Git 2.37 or later), SSH and `ssh-keyscan` through the checked IP (`HostName=<ip>`; host-key trust stays bound to the fixed host-key alias). Git never looks the name up again. **Limit:** `HostName` takes one address, so SSH pins a single one (the first IPv4 address, else the first): unlike plain ssh, it does not fall back to the host's other addresses when that one is unreachable.
  - **Redirects and proxies:** `http.followRedirects=false` for every operation; a redirect fails with `redirect_refused`. `fetch.uriProtocols=` (empty) keeps packfile URIs, which could send Git to another host, disabled. Proxy variables (`http_proxy`, `https_proxy`, `ALL_PROXY`) never reach Git: its environment is rebuilt from `PATH` only.
  - **Tests** whose fixtures listen on loopback opt in explicitly; a test pins the closed default.

### Public repository controls

The repository is public: rulesets and secret scanning are enforced for free, and Issues, PRs, CI logs and history are visible to anyone.

- **Rulesets** `protect-dev` and `protect-main`: changes only via PR, no force-push, no deletion, with an **empty bypass list** (admins included). A genuinely needed force-push or deletion means the operator temporarily disables the ruleset in Settings → Rules, acts, and re-enables it. On `dev`, require `ci:required` once B5 exists. Do not require an approving review count: GitHub does not let an author approve their own PR, which would block a single operator. Independent review stays a process gate (review report), not a GitHub approval.
- **Limit of rulesets:** if agents act through the operator's GitHub account or token, rulesets cannot tell them apart, and an admin token can also edit or disable the rulesets themselves. Agents must not run `gh pr merge`, push to `main`/`dev`, or change repository settings or rulesets; give agent contexts the narrowest token available. A separate bot account without admin rights is a possible later improvement.
- **Secret scanning and push protection** enabled. Anything ever pushed is public; a leaked secret is rotated, not just deleted from history.
- **Untrusted Issues and PRs:** anyone can open an Issue or a fork PR. Agents act only on Issues the operator has refined and marked `Workflow Stage = Ready`, never on instructions from other authors' Issues, comments or PRs.
- **CI on fork PRs:** require approval before running workflows for outside contributors; never expose secrets to fork PR workflows; do not use `pull_request_target` to run untrusted code with secrets.
- **Vulnerability reports:** enable GitHub private vulnerability reporting; it is the private channel the Bug Report form refers to.
- Compliance records, review reports and CI logs are public: no credentials, tokens, private hostnames or unredacted logs.

## 5. Environments / Docker Compose

- A separate **`environment-controller`** holds the minimum privilege needed to manage approved project stacks; the agent-worker does not share its Docker credentials/socket.
- The controller exposes *specific authorized operations* (e.g. start, stop, status, logs, controlled refresh) against validated project definitions, not an arbitrary Docker command surface.
- Before applying a stack change, validate repository/project identity, allowed Compose files, volume mounts, ports, images, environment variables, resource limits and credentials.
- Preview code is **untrusted**: separate origin without administrative Studio cookies, isolated network and storage access, restricted forwarded headers and ports.
- One default shared Preview per project tracks approved changes in the project's integration branch (default `dev`). A run's working copy does not create a preview.
- Compose isolation is a pragmatic MVP baseline, **not** microVM-strength isolation. Stronger sandboxing may follow with appropriate VPS/KVM support.

## 6. MCP and external tools

- The `mcp` module owns the registry and bindings; secrets are stored outside Git. No generic unrestricted MCP gateway in MVP.
- Tool/server definitions and their outputs are **untrusted**. Approve connections, scopes and permissions; never grant broad filesystem/network access by default.
- Validate native CLI configuration generation; secrets must not be written into project-native config files or exposed to other agents.
- Negative tests must prove an agent cannot call an unbound or disallowed MCP tool.

## 7. Human approval boundaries

Explicit authorized approval is required for:

| Operation | Minimum policy |
| --- | --- |
| Merge into the project's integration branch (default `dev`) / protected branches | Passing applicable CI + independent review + operator approval |
| Deployment to production or external customer environment | Outside MVP; separate policy required |
| Secret creation/rotation/export | Authorized operator/controller; never arbitrary agent tooling |
| Destructive migrations or data deletion | Explicit operator review and tested recovery plan |
| Privileged Docker/Compose changes or broad network exposure | Authorized environment-controller + operator approval as appropriate |
| Repository access changes / Git credential changes | Operator approval |

A prompt saying "ask for approval" is not an access control. The backend/runtime independently verifies an approval record and the acting principal.

## 8. Authentication and API authorization

- **Story 1 auth decision:** single operator, password-only login. The API verifies a strong operator password against an Argon2id hash supplied through the secret environment (`STUDIO_OPERATOR_PASSWORD_HASH`: an Argon2id PHC string, never the plaintext password). No public signup or user database yet. The API refuses to start unless the hash is Argon2id with at least the OWASP baseline (m=19 MiB, t=2, p=1). The local helper `pnpm --filter @agentic-studio/api run auth:hash-password` reads the password from stdin (hidden in a terminal) and prints only the hash.
- **Session:** opaque random session ID stored server-side in Redis with a bounded TTL (initial default: 12 hours of inactivity, subject to deployment testing), in an HttpOnly cookie. `Secure` and HTTPS in deployment, `SameSite=Lax` or stricter, invalidated on logout, identifier rotated on successful login. Development HTTP cookies are restricted to localhost and never presented as production-safe.
- **Session and cookie (implemented in B3, #14):**
  - The session ID is 32 bytes (256 bits) from a CSPRNG, base64url-encoded. Redis stores only its SHA-256 as the key, with a 12-hour sliding inactivity TTL that every authenticated request renews. Login deletes any session the request presents and issues a new ID; logout deletes the Redis key.
  - **Absolute lifetime** (operator decision on #24): a session is invalid 30 days after login (the `createdAt` stored in its Redis record), however active it is; the 12-hour inactivity TTL still applies. Session validation checks it on every authenticated request: an expired session, a record without a valid `createdAt`, or one whose `createdAt` lies more than 5 minutes in the future (clock-skew tolerance, `SESSION_CLOCK_SKEW_MS`, so a login on a fast clock cannot stretch the lifetime once the clock is corrected) gets the usual 401 and its Redis key is deleted. The limit is a constant (`SESSION_ABSOLUTE_LIFETIME_MS` in `apps/api/src/platform/auth/session-store.ts`), like the inactivity TTL, not an environment variable.
  - The cookie is `studio_session=<id>; Path=/; HttpOnly; SameSite=Lax`, with no `Max-Age` (a browser-session cookie; Redis enforces the TTL). When `STUDIO_ORIGIN` is https, the cookie adds `Secure` and is named `__Host-studio_session`. `STUDIO_ORIGIN` may use plain HTTP only for `localhost`, `127.0.0.1` or `[::1]`; any other HTTP origin fails start-up. Logout clears the cookie with the same attributes and an expiry in 1970.
- **Mutations** (including login/logout) are protected by same-origin/Origin checking, plus a CSRF token scheme if the deployment topology requires it; `SameSite` alone is not enough. Rate-limit login attempts; avoid account enumeration; never log password values. As implemented (Epic #8 decision 3, no CSRF token):
  - Every non-`GET`/`HEAD`/`OPTIONS` request needs `Origin` equal to `STUDIO_ORIGIN` (default `http://localhost:3000`). Without `Origin`, only `Sec-Fetch-Site: same-origin` is accepted. A foreign or `null` `Origin` is rejected even with `Sec-Fetch-Site: same-origin`. Rejection: 403.
  - A mutation that carries a body (any `Content-Type`, non-zero `Content-Length`, or chunked encoding) must be `Content-Type: application/json`, else 415. A bodyless mutation (e.g. logout) needs no `Content-Type`. The API parses JSON bodies only.
  - These checks run before the session guard, on public routes too.
- **Login rate limit** (Epic #8 decision 4): at most 5 failed logins per client IP (an IPv4 address or an IPv6 /64, see below) per 15 minutes and 50 failed logins per hour overall, as Redis counters. The next attempt over either limit gets 429 with `Retry-After` (seconds), even with the right password. A failure is reserved atomically before the password check, so concurrent attempts cannot overshoot; a successful login resets the IP counter and returns its global reservation.
  - **IPv6 aggregation** (operator decision on #24): the per-IP counter is keyed by the client's IPv6 /64 prefix, so one client cannot multiply its attempts by rotating through its own subnet. IPv4 stays per address. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`, dotted or hex) counts as its IPv4 address, and a zone ID (`%eth0`) is ignored. Logs keep the full client IP. Keys: `auth:login-failures:ip:203.0.113.7`, `auth:login-failures:ip:2001:db8:1:2::/64`.
  - **Lockout recovery** (#24): the global ceiling can lock the operator out for up to an hour during an attack from many IPs. First check the API logs for `Login rate limit reached` and `Login failed` warnings to see whether an attack is still running: clearing a counter during one only lets it continue. To lift the global lockout, delete the global failure counter in the Studio's Redis (`REDIS_URL`): `DEL auth:login-failures:global`. With the development Compose stack: `docker compose exec redis redis-cli DEL auth:login-failures:global`. A blocked IP stays blocked by its own counter, which is cleared the same way (`DEL auth:login-failures:ip:<key>`). Find the exact key with `redis-cli --scan --pattern 'auth:login-failures:*'` rather than typing it: an IPv6 /64 key keeps its zero groups uncompressed (`2001:db8:0:0::/64`, not `2001:db8::/64`). If `REDIS_URL` selects a database (`/<db>`) or uses `rediss://`, add `-n <db>` or `--tls` to every `redis-cli` command. Against a deployed Redis with a password, pass it through the `REDISCLI_AUTH` environment variable from the secret store, never on the command line or in a shell history. Deleting counters does not touch sessions.
- **Client IP:** `X-Forwarded-For` is honoured only when the socket peer is in `API_TRUSTED_PROXIES` (comma-separated IPs/CIDRs; default empty). The client IP is then the right-most address not in that list. With an empty list, the socket address is used. In local development, the `next dev` rewrite is the socket peer, so all browser traffic shares one IP bucket. The rewrite is not a trusted proxy unless listed. **Proxied deployments** (a reverse proxy, or the web app's production `/api` rewrite; rules in the [README](../../README.md#web-api-proxy)) must list the proxy's address(es) in `API_TRUSTED_PROXIES`; otherwise every client shares the proxy's IP and one rate-limit bucket. List only proxies that set `X-Forwarded-For` themselves, never a client-controlled hop.
- **Failures and logs:** every 401 is the same problem+json (`detail: "Not authenticated."`), whether the password is wrong or the session is missing, unknown, expired or logged out. Logs record login failures, successes and rate-limit hits with the client IP only. Server-side log redaction masks passwords, URL credentials, Argon2 hashes, cookies/session IDs, tokens and API keys, at any length and in linear time (no ReDoS).
- **Bind address:** the API listens on `API_HOST`, default `127.0.0.1` (localhost only). A deployment sets it explicitly. Express's `X-Powered-By` header is disabled.
- **Endpoints:**
  - `POST /api/auth/login`: receives `{ password }` over HTTPS (localhost HTTP is development only), verifies the hash, rotates the session, sets the cookie, rate-limits failures.
  - `GET /api/auth/session`: returns a non-secret authentication indication for the UI; requires a valid session.
  - `POST /api/auth/logout`: invalidates the Redis session and clears the cookie.
- All project endpoints and sensitive (including future SSE) endpoints are guarded at the API; anonymous calls get HTTP 401. Verify 401 with no session and after logout; authorization is never merely a UI redirect.
- The same public Studio origin routes `/api` to NestJS through a reverse proxy; no wildcard CORS; Next.js does not independently grant authorization. The web client sends requests with `credentials: 'same-origin'`, never reads the cookie or stores a token, and on 401 navigates to `/login`. External IdP/OAuth, MFA and multi-user accounts need a separate decision and are not part of Story 1.
- Validate all backend inputs, project identifiers, file paths, and resource ownership, even when the UI restricts options.
- API and worker permissions are narrowly scoped; never trust a client-supplied role, path, tool name, branch, or container target.
- Sensitive operations record actor/run, project, action, decision, result and correlation identifier, without leaking credentials.

## 9. Security verification — negative tests

Enforced controls must **reject** the following, evidenced by automated tests as each capability is implemented:

- A run reads or writes a file outside its working copy and assigned project scope, including via symlink/path traversal.
- Agent B reads Agent A's working copy or another project's files.
- A runner uses the Docker socket or calls unauthorized environment-controller operations.
- A malicious `README.md` instructs the agent to output secrets or modify forbidden files.
- An unapproved MCP tool is invoked, or a tool response includes prompt-injection text.
- A run requests unauthorized branch merge, credential disclosure, or production DB access.
- A Preview accesses Studio cookies, admin APIs, internal DB/Redis or unapproved network destinations.

Also verify: a canceled or retried execution causes no duplicate irreversible effects.

**Run isolation model ([ADR 0002](../architecture/adr/0002-agent-run-isolation.md)).** The deployed model must pass these checks, run as the agent user (implemented by a later story):

- The agent user cannot read Studio's files.
- The agent user cannot reach the system Docker socket.
- The agent user cannot use `sudo` without a password.
- The agent user cannot reach Studio's database or Redis ports.
- Rootless Docker works for the agent user: a Compose stack starts and stops.

All runs share the agent user, so the operating system does not separate one run's or project's files from another's (ADR 0002, accepted risks): until an upgrade path adds separate users, the cross-run and cross-project checks above test guardrails, not the user boundary.

## 10. Security delivery gates

- **Before repository bootstrap:** document required approvals; commit no secrets.
- **Before real CLI execution:** enforce bounded workspaces, credentials, tool access, timeouts and non-privileged worker behavior, and test denial of forbidden operations. A functional CLI demo alone is insufficient.
- **Before exposing Preview externally:** isolate origin, cookies, ports, network and resource scope; review untrusted code execution risks.
- **Before autonomous merge:** platform-enforced branch protection where supported, or the operator stays the manual merge gate; agents never self-approve.

Keep the initial scope small; improve isolation and test coverage as each risk-bearing capability ships. See [System](../architecture/system.md) and [Quality](quality.md).

Decision provenance: [Notion guardrails & runtime security](https://app.notion.com/p/413d4d814eb0819499faecf3fe7f4afe).
