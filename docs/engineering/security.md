# Security Guardrails — AI Agent Studio

**Status:** design-time minimum controls and threat model. Permission enforcement, secret stores, sandboxing, allowlists and negative tests are **not yet implemented**; they are prerequisites for real unattended CLI agent execution.

## 1. Threat model and trust boundaries

The system runs code and tools against potentially hostile repository content. Key threats:

- Prompt injection in repository files, Issues, README files, logs, MCP tool responses, fetched documentation.
- Data exfiltration via shell, logs, arbitrary HTTP/network egress, commit contents, agent-visible environment variables.
- Cross-project filesystem escape, symlink traversal, path confusion, rogue worktrees, Git credential misuse.
- Docker privilege escalation, unapproved Compose actions, host access, untrusted Preview content.
- Unsafe dependency installation, arbitrary shell hooks, malicious configuration.
- Duplicated jobs/events, replay, stale authorization, unintended merges, destructive migrations.

**Trust boundaries:** operator's admin session; Studio UI/REST API; PostgreSQL/Redis; untrusted project repository; agent runner; MCP servers; environment-controller; Docker host; exposed Preview origin. Credentials and authority stay narrow across each boundary.

## 2. Agent execution policy

- Each agent execution has an **assigned project, worktree, branch, approved tool set, time/resource budget and explicit run identity**.
- A Git worktree is an organization/isolation mechanism, **not a complete sandbox**. Enforce filesystem permissions and container/process isolation; test path traversal and symlink escape.
- Agent-worker **must not mount `/var/run/docker.sock` or obtain privileged Docker host access**, and never runs as a privileged container.
- User/project code runs with the least capabilities possible: restricted host mounts, file access, process execution, network egress and inter-project access, per task.
- No production credentials or production data for coding agents; separate development/test accounts and databases.
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
- Inject only the necessary secret values at the point of authorized use; minimize lifetime and visibility.
- Redact secrets and sensitive commands/paths from logs, error messages, SSE payloads, CI artifacts, PR descriptions and agent handoffs.
- External or provider session credentials are not copied to other agents unless explicitly supported and authorized.
- Scan source/commits/PRs for secret leaks; test that run logs cannot disclose protected values.

## 4. Git, branch and merge protection

- Each running agent works in an assigned branch/worktree and cannot write to another agent's workspace.
- Git operations go through public `projects` contracts and an authorized, path-validated Git adapter. Workers cannot bypass approval by merging to `dev` directly.
- A User Story normally lands through one integrated PR; subtasks normally produce commits; independent Technical Tasks may land separately when safe. `dev` is the GitHub default/integration branch; `main` is reserved for stable/release integration.
- Review the diff and relevant test results. Explicit authorization is required for approval/merge, force push, history rewrite, branch deletion, and repository credential changes.
- CI and independent review are preconditions for merge. **The operator is the final manual merge gate**; agents have no unrestricted merge authority.

### Public repository controls

The repository is public: rulesets and secret scanning are enforced for free, and Issues, PRs, CI logs and history are visible to anyone.

- **Rulesets** on `main` and `dev`: changes only via PR, no force-push, no deletion. On `dev`, require `ci:required` once B5 exists. Do not require an approving review count: GitHub does not let an author approve their own PR, which would block a single operator. Independent review stays a process gate (review report), not a GitHub approval.
- **Limit of rulesets:** if agents act through the operator's GitHub account or token, rulesets cannot tell them apart. Agents must not run `gh pr merge` or push to `main`/`dev`; give agent contexts the narrowest token available. A separate bot account is a possible later improvement.
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
- One default shared Preview per project tracks approved changes in `dev`. Opening a worktree does not create a preview.
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
| Merge into `dev` / protected branches | Passing applicable CI + independent review + operator approval |
| Deployment to production or external customer environment | Outside MVP; separate policy required |
| Secret creation/rotation/export | Authorized operator/controller; never arbitrary agent tooling |
| Destructive migrations or data deletion | Explicit operator review and tested recovery plan |
| Privileged Docker/Compose changes or broad network exposure | Authorized environment-controller + operator approval as appropriate |
| Repository access changes / Git credential changes | Operator approval |

A prompt saying "ask for approval" is not an access control. The backend/runtime independently verifies an approval record and the acting principal.

## 8. Authentication and API authorization

- **Story 1 auth decision:** single operator, password-only login. The API verifies a strong operator password against an Argon2id hash supplied through the secret environment (`STUDIO_OPERATOR_PASSWORD_HASH`, illustrative key name; never the plaintext password). No public signup or user database yet.
- **Session:** opaque random session ID stored server-side in Redis with a bounded TTL (initial default: 12 hours of inactivity, subject to deployment testing), in an HttpOnly cookie. `Secure` and HTTPS in deployment, `SameSite=Lax` or stricter, invalidated on logout, identifier rotated on successful login. Development HTTP cookies are restricted to localhost and never presented as production-safe.
- **Mutations** (including login/logout) are protected by same-origin/Origin checking, plus a CSRF token scheme if the deployment topology requires it; `SameSite` alone is not enough. Rate-limit login attempts; avoid account enumeration; never log password values.
- **Endpoints:**
  - `POST /api/auth/login`: receives `{ password }` over HTTPS (localhost HTTP is development only), verifies the hash, rotates the session, sets the cookie, rate-limits failures.
  - `GET /api/auth/session`: returns a non-secret authentication indication for the UI; requires a valid session.
  - `POST /api/auth/logout`: invalidates the Redis session and clears the cookie.
- All project endpoints and sensitive (including future SSE) endpoints are guarded at the API; anonymous calls get HTTP 401. Verify 401 with no session and after logout; authorization is never merely a UI redirect.
- The same public Studio origin routes `/api` to NestJS through a reverse proxy; no wildcard CORS; Next.js does not independently grant authorization. Exact cookie attributes are chosen and documented in B3. External IdP/OAuth, MFA and multi-user accounts need a separate decision and are not part of Story 1.
- Validate all backend inputs, project identifiers, file paths, and resource ownership, even when the UI restricts options.
- API and worker permissions are narrowly scoped; never trust a client-supplied role, path, tool name, branch, or container target.
- Sensitive operations record actor/run, project, action, decision, result and correlation identifier, without leaking credentials.

## 9. Security verification — negative tests

Enforced controls must **reject** the following, evidenced by automated tests as each capability is implemented:

- A worktree reads or writes a file outside its assigned project scope, including via symlink/path traversal.
- Agent B reads Agent A's workspace or another project's files.
- A runner uses the Docker socket or calls unauthorized environment-controller operations.
- A malicious `README.md` instructs the agent to output secrets or modify forbidden files.
- An unapproved MCP tool is invoked, or a tool response includes prompt-injection text.
- A run requests unauthorized branch merge, credential disclosure, or production DB access.
- A Preview accesses Studio cookies, admin APIs, internal DB/Redis or unapproved network destinations.

Also verify: a canceled or retried execution causes no duplicate irreversible effects.

## 10. Security delivery gates

- **Before repository bootstrap:** document required approvals; commit no secrets.
- **Before real CLI execution:** enforce bounded workspaces, credentials, tool access, timeouts and non-privileged worker behavior, and test denial of forbidden operations. A functional CLI demo alone is insufficient.
- **Before exposing Preview externally:** isolate origin, cookies, ports, network and resource scope; review untrusted code execution risks.
- **Before autonomous merge:** platform-enforced branch protection where supported, or the operator stays the manual merge gate; agents never self-approve.

Keep the initial scope small; improve isolation and test coverage as each risk-bearing capability ships. See [System](../architecture/system.md) and [Quality](quality.md).

Decision provenance: [Notion guardrails & runtime security](https://app.notion.com/p/413d4d814eb0819499faecf3fe7f4afe).
