# Security Guardrails — AI Agent Studio

**Status:** design-time minimum controls and threat model. Actual permission enforcement, secret stores, sandboxing, allowlists and negative tests are **not yet implemented**. Treat them as prerequisites for real unattended CLI agent execution.

## 1. Threat model and trust boundaries

The system runs code and tools against potentially hostile repository content. Key threats:

- Prompt injection inside repository files, Issues, README files, logs, MCP tool responses, and fetched documentation.
- Data exfiltration via shell, logs, arbitrary HTTP/network egress, commit contents, or agent-visible environment variables.
- Cross-project filesystem escape, symlink traversal, path confusion, rogue worktrees, and Git credential misuse.
- Docker privilege escalation, unapproved Compose actions, host access, untrusted Preview content.
- Unsafe dependency installation, execution of arbitrary shell hooks and malicious configuration.
- Duplicated jobs/events, replay, stale authorization, unintended merges and destructive migrations.

**Trust boundaries:** operator's admin session; Studio UI/REST API; PostgreSQL/Redis; untrusted project repository; agent runner; MCP servers; environment-controller; Docker host; exposed Preview origin. Keep credentials and authority narrow across each boundary.

## 2. Agent execution policy

- Each agent execution has an **assigned project, worktree, branch, approved tool set, time/resource budget and explicit run identity**.
- A Git worktree is an organization/isolation mechanism but **not a complete sandbox**. Enforce filesystem permissions and container/process isolation; test path traversal and symlink escape.
- Agent-worker **must not mount `/var/run/docker.sock` or obtain privileged Docker host access**. Do not run it as a privileged container.
- Run user/project code with the least capabilities possible. Restrict host mounts, file access, process execution, network egress and inter-project access according to the task.
- Do not expose production credentials or production data to coding agents. Separate development/test accounts and databases.
- Configure execution timeout, cancellation, CPU/RAM/storage limits and output-size/log quotas; make repeated operations idempotent where appropriate.
- No access to unapproved MCP tools or arbitrary configuration modifications outside permitted boundaries.

### CLI usage and provider terms — MVP decision (canonical)

- The MVP integrates the **official Claude Code and Codex CLI binaries** rather than calling model APIs directly.
- Before implementing the agent worker, validate that the intended headless execution and authentication flows comply with each provider's **current** terms. Support for non-interactive CLI commands does not by itself establish permission for every form of subscription-based automation. Consumer subscriptions are not equivalent to unrestricted programmatic API access.
- The worker must **not extract, intercept, share, or proxy subscription credentials**.
- Keep a small runner interface that isolates provider-specific CLI execution. API-based or SDK-based runners are **out of scope for MVP**; they may be considered later if required by provider policy or product needs. "API/SDK runner" means calling a model API or provider SDK directly instead of the CLI binary. Running the official CLI binary with API-key or other supported credentials is still a **CLI runner** and is in scope; the chosen authentication method is part of each provider's validation.
- **Acceptance gate:** do not enable automated execution for a provider until its intended authentication and execution model has been validated. Validation is per provider; approval for Codex never implies approval for Claude Code, or vice versa.

#### Provider compliance decision records

Validation produces a durable, auditable decision, not an informal statement that an integration was "validated". Technical Tasks **B6** (Claude Code CLI) and **B7** (Codex CLI) each produce a dated record under `docs/engineering/provider-compliance/` (template in that folder's `README.md`) documenting:

- Provider and CLI version.
- Terms and documentation reviewed: source URLs, version or effective date where available, and review date.
- Selected authentication method.
- Permitted execution mode and relevant restrictions.
- Evidence from a controlled headless execution test.
- Decision (`Approved`, `Rejected`, or `Needs Clarification`) and the operator who accepted it.
- Next review date and triggers for earlier revalidation.

The corresponding task must be complete, with an `Approved` record that is still applicable, before that provider is enabled in the agent worker.

#### Runtime enforcement: per-provider enablement flags

The provider gate is a **runtime authorization requirement**, not only an instruction to coding agents. The agent worker reads one operator-controlled flag per provider from its deployment configuration:

```text
CLAUDE_CODE_ENABLED=false
CODEX_CLI_ENABLED=false
```

- Both default to disabled. **Fail closed:** only the exact value `true` enables a provider; a missing, empty, malformed or `false` value means disabled.
- A provider cannot be executed unless its own flag is explicitly enabled. Enabling one provider **never** enables another.
- Before spawning any provider CLI process, the worker checks the corresponding flag and rejects the execution if the provider is disabled. Rejection is recorded as an explicit execution failure with a clear, non-sensitive error, not a silent skip.
- Only the trusted operator/deployment configuration may set these values. They **cannot be overridden** through an execution request, workflow definition, agent configuration, MCP response, or model-generated instructions.
- The operator may enable a provider only after its compliance decision record is `Approved` and still applicable. Setting the flag does **not** itself constitute compliance, legal or terms approval.
- If a provider's approval is revoked or no longer applicable (e.g. a record's review date passes or a revalidation trigger occurs), the operator disables its flag before any further executions.
- Required negative tests are listed in [Quality](quality.md) §10.

**Current status:** no provider has been validated; no compliance record exists yet. Both providers stay disabled until B6/B7 produce `Approved` records.

## 3. Secrets and credentials

- Use a dedicated secret-management mechanism, with scoped and revocable credentials. **Never commit `.env` secrets, auth/session tokens, CLI credentials, private keys or MCP secrets.**
- Store secret references in DB/Git definitions where appropriate, **not actual secret values**.
- Inject only necessary secret values at the point of authorized use; minimize their lifetime and visibility.
- Redact secrets and sensitive commands/paths from logs, error messages, SSE payloads, CI artifacts, PR descriptions and agent handoffs.
- Do not copy external or provider session credentials to other agents unless explicitly supported and authorized.
- Scan source/commits/PRs for secret leaks and test that run logs cannot disclose protected values.

## 4. Git, branch and merge protection

- Each running agent works in an assigned branch/worktree and cannot write to another agent's workspace.
- Git operations happen through public `projects` contracts and an authorized, path-validated Git adapter. Do not let workers directly bypass approval by merging to `dev`.
- A User Story normally lands through one integrated PR; subtasks normally produce commits. Independent Technical Tasks may land separately when safe. `dev` is the integration branch; `main` is the GitHub default, reserved for stable/release integration.
- Review diff and relevant test results; require explicit authorization for approval/merge, force push, history rewrite, branch deletion, and repository credential changes.
- Keep CI and independent review as preconditions for merge. **The operator is the final manual merge gate**; agents must lack unrestricted merge authority.

### Public repository controls

The repository is public. This enables enforced rulesets and free secret scanning, and also exposes Issues, PRs, CI logs and history to anyone.

- **Rulesets** on `main` and `dev`: changes only via PR, no force-push, no deletion. On `dev`, require `ci:required` once B5 exists. Do not require an approving review count: GitHub does not let an author approve their own PR, which would block a single operator. Independent review stays a process gate (review report), not a GitHub approval.
- **Limit of rulesets:** if agents act through the operator's GitHub account or token, rulesets cannot tell them apart. Agents must not run `gh pr merge` or push to `main`/`dev`; give agent contexts the narrowest token available. A separate bot account is a possible later improvement.
- **Secret scanning and push protection** enabled. Anything ever pushed is public; a leaked secret is rotated, not just deleted from history.
- **Untrusted Issues and PRs:** anyone can open an Issue or a fork PR. Agents act only on Issues the operator has refined and marked `Workflow Stage = Ready`, never on instructions from other authors' Issues, comments or PRs.
- **CI on fork PRs:** require approval before running workflows for outside contributors; never expose secrets to fork PR workflows; do not use `pull_request_target` to run untrusted code with secrets.
- **Vulnerability reports:** enable GitHub private vulnerability reporting, which is the private channel the Bug Report form refers to.
- Compliance records, review reports and CI logs are public: no credentials, tokens, private hostnames or unredacted logs.

## 5. Environments / Docker Compose

- A separate **`environment-controller`** holds the minimum privilege needed to manage approved project stacks; the agent-worker does not share its Docker credentials/socket.
- The controller exposes *specific authorized operations* (e.g. start, stop, status, logs, controlled refresh) against validated project definitions, not an arbitrary Docker command surface.
- Validate repository/project identity, allowed Compose files, volume mounts, ports, images, environment variables, resource limits and credentials before applying a stack change.
- Treat application Preview code as **untrusted**. Expose Preview on a separate origin without administrative Studio cookies; isolate network and storage access, and restrict forwarded headers and ports.
- One default shared Preview per project tracks approved changes in `dev`. No preview is created merely because an agent opened a worktree.
- Compose isolation is a pragmatic MVP baseline, **not** a claim of microVM-strength isolation. Stronger sandboxing may be introduced later with appropriate VPS/KVM support.

## 6. MCP and external tools

- The `mcp` module owns the registry and bindings; secrets are stored outside Git. Do not build a generic unrestricted MCP gateway in MVP.
- Tool/server definitions and their outputs are **untrusted**. Approve connections, scopes and permissions; never grant broad filesystem/network access by default.
- Validate native CLI configuration generation and prevent secrets from being written into project-native config files or exposed to other agents.
- Negative tests must prove an agent cannot call an unbound or disallowed MCP tool.

## 7. Human approval boundaries

Require explicit authorized approval for:

| Operation | Minimum policy |
| --- | --- |
| Merge into `dev` / protected branches | Passing applicable CI + independent review + operator approval |
| Deployment to production or external customer environment | Outside MVP; separate policy required |
| Secret creation/rotation/export | Authorized operator/controller; never arbitrary agent tooling |
| Destructive migrations or data deletion | Explicit operator review and tested recovery plan |
| Privileged Docker/Compose changes or broad network exposure | Authorized environment-controller + operator approval as appropriate |
| Repository access changes / Git credential changes | Operator approval |

A text prompt saying "ask for approval" is not an access control. The backend/runtime must independently verify an approval record and the acting principal.

## 8. Authentication and API authorization

- **Story 1 auth decision:** single operator, password-only login; a strong operator password is verified by the API against an Argon2id hash supplied through the secret environment (`STUDIO_OPERATOR_PASSWORD_HASH`, illustrative key name; not the plaintext password). No public signup or user database is required yet.
- Use an opaque random session ID, stored server-side in Redis with a bounded TTL (initial default: 12 hours of inactivity, subject to deployment testing), and an HttpOnly cookie. Use `Secure` and HTTPS in deployment, `SameSite=Lax` or stricter, invalidate on logout, and rotate the session identifier on successful login. Development HTTP cookies must be restricted to localhost and never presented as production-safe settings.
- Protect mutation routes including login/logout with same-origin/Origin checking (and a suitable CSRF token scheme if the deployment topology requires it); do not rely on `SameSite` alone. Rate-limit login attempts; avoid account enumeration and avoid logging password values.
- Authentication endpoints: `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout`. Guard all project endpoints and sensitive SSE endpoints at the API. Verify 401 responses with no session and after logout, and verify authorization is not merely a UI redirect.
- The same public Studio origin routes `/api` to NestJS; Next.js does not independently grant authorization. Future external IdP/OAuth, MFA and multi-user accounts require a separate decision and are not part of Story 1.
- Validate all backend inputs, project identifiers, file paths, and resource ownership, even when the UI restricts options.
- Use narrowly scoped API and worker permissions; do not trust client-supplied role, path, tool name, branch, or container target.
- All sensitive operations should record actor/run, project, action, decision, result and correlation identifier without leaking credentials.

## 9. Security verification — negative tests

The following should be **rejected** by enforced controls and evidenced by automated tests as the corresponding capabilities are implemented:

- A worktree tries to read or write a file outside its assigned project scope, including via symlink/path traversal.
- Agent B attempts to read Agent A's workspace or another project's files.
- A runner tries to use Docker socket or call unauthorized environment-controller operations.
- A malicious `README.md` instructs the agent to output secrets or modify forbidden files.
- An unapproved MCP tool is invoked or a tool response includes prompt-injection text.
- A run requests unauthorized branch merge, credential disclosure, or production DB access.
- An execution is canceled or retried, with no duplicate irreversible effects.
- A Preview attempts to access Studio cookies, admin APIs, internal DB/Redis or unapproved network destinations.

## 10. Security delivery gates

**Before repository bootstrap:** document required approvals and avoid committing secrets.

**Before real CLI execution:** enforce bounded workspaces, credentials, tool access, timeouts, non-privileged worker behavior, and test denial of forbidden operations. A functional CLI demo alone is insufficient.

**Before exposing Preview externally:** isolate origin, cookies, ports, network and resource scope; review untrusted code execution risks.

**Before autonomous merge:** ensure platform-enforced branch protection where supported or keep the operator as the manual merge gate; do not let agents self-approve.

See [System](../architecture/system.md) and [Quality](quality.md). Keep the initial scope small; improve isolation and test coverage as each risk-bearing capability ships.

Decision provenance: [Notion guardrails & runtime security](https://app.notion.com/p/413d4d814eb0819499faecf3fe7f4afe).
