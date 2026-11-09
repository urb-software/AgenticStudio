# System Architecture — AI Agent Studio

**Status:** approved high-level target architecture. Components are not yet implemented; all specifics not explicitly agreed below are subject to User Story refinement.

## 1. Architectural principles

- **One TypeScript stack:** NestJS API and Next.js App Router UI.
- **Modular Monolith + Vertical Slice Architecture (VSA) + Lightweight Clean Architecture** in the API; feature-first modular frontend.
- Exactly **six business modules** in the API, not six microservices.
- Separate **technical processes** for background execution and narrowly privileged environment management.
- Git-first / file-native configuration of coding agents and skills where supported by their CLIs.
- Human-controlled changes: isolated branches/worktrees, tests, review, and approval before merge.
- Self-hosted single-operator deployment; least privilege, isolation, observability, and recoverability.
- Introduce abstractions in response to a concrete use case, not as empty scaffolding.

## 2. Logical context

```text
Human operator
  │
  ▼
Next.js Studio (apps/web)
  │  REST + SSE (via approved auth)
  ▼
NestJS API (apps/api) ───────── PostgreSQL
  │  projects / agents / workflows / executions / environments / mcp
  │
  ├──────── Redis + BullMQ ───── agent-worker (apps/agent-worker)
  │                               │
  │                               └── Official Claude/Codex CLI
  │                                   in isolated Git worktrees
  │
  └── Authorized environment actions → environment-controller
                                          │
                                          └── controlled Docker Compose
                                              for project Preview

Traefik exposes only explicitly approved UI/Preview entrypoints.
```

This diagram is conceptual. The exact network, queue, auth, and deployment boundaries must be implemented and tested.

## 3. Business module ownership

| Module | Owns | Does not own |
| --- | --- | --- |
| `projects` | Project lifecycle, repository connection, Git worktrees/branches, diff, approval and merge | Agent definitions, raw Docker privilege |
| `agents` | `AgentDefinition`, `SkillDefinition`, assignment, native-file definitions, validation and publishing | Task queue execution |
| `workflows` | Workflow definitions, step dependencies, ordering, conditions, human approval semantics | Individual worker/process execution plumbing |
| `executions` | Runs, state transitions, queue scheduling, progress/log/result records | Direct Docker host control or unrelated project Git internals |
| `environments` | Project environment lifecycle, Compose stack abstraction, health/logs, shared Preview | CLI agent definitions |
| `mcp` | Reusable MCP server definitions, bindings, validation/connection checks, CLI tool configuration | Project repository internals or a full gateway in MVP |

Frontend navigation may cross these boundaries: `/skills` is part of `agents`; `/projects/:id/preview` displays `environments` functionality in a project context. Backend boundaries remain authoritative.

## 4. Cross-cutting platform

Under `apps/api/src/platform/`:

```text
auth/       # Operator authentication, authorization policies
database/   # Database connection, transactions, migrations integration
queue/      # BullMQ abstraction and job submission
messaging/  # Outbox, inbox/idempotency, event delivery
config/     # Validated configuration
logging/    # Structured logs, correlation/tracing
```

`shared/` is for genuinely domain-neutral helpers; business use cases belong to their owning modules.

## 5. Processes and cross-process contracts

- `apps/web`: UI only; never connects directly to privileged infrastructure or the agent worker.
- `apps/api`: authoritative business operations, state, authentication, coordination; API operations via REST and realtime delivery via SSE.
- `apps/agent-worker`: consumes approved execution jobs, runs official CLI adapters with constrained filesystem/network/process permissions, publishes results and status. **Must not receive the Docker host socket.**
- `apps/environment-controller`: narrow privileged interface for validated and authorized Docker Compose operations. Do not expose a generic arbitrary shell/Docker command interface.
- `packages/contracts`: extract a cross-process contract here **only if** multiple runtime apps need it; retain one source of truth and do not duplicate schema definitions in a module and a shared package.

## 6. Integration events and reliable messaging

- Domain events are **not** a required MVP concept. Use **integration events** when modules need asynchronous communication.
- The publishing module owns the event contract (e.g. `ExecutionCompletedV1`), including versioned schema, exported publicly. Prefer Zod schema + inferred TypeScript type.
- Application handler changes business state and writes an event to a **PostgreSQL transactional outbox** in one DB transaction when both writes use the same DB.
- Outbox dispatcher delivers with **at-least-once** semantics; consumers use an inbox / processed-event marker for idempotency and per-consumer delivery tracking. Do not claim exactly-once delivery.
- `consumers/<event>/consumer.ts` validates/maps events and delegates to a local feature handler. Business logic stays in handlers; read projection handlers can update a projection directly when appropriate.
- Git/Docker/CLI side effects are **not** transactionally atomic with PostgreSQL. Model state transitions, retries, reconciliation, and partial failure explicitly.
- BullMQ handles long-running job delivery. Durable execution history and live SSE progress are separate from outbox retention.

## 7. Git and project collaboration

- Each running coding agent uses an assigned worktree and branch with scoped filesystem permissions.
- Outputs are examined as diffs, tested and reviewed before controlled merge to `dev`.
- The project has **one shared default Preview**, reflecting the integration branch `dev` following approved merges. It is **not** a Preview per agent.
- Merge/production deployment are protected operations, never direct worker privileges.

## 8. Deployment and trust boundaries

- Target deployment: Docker Compose on a standard VPS, Traefik, PostgreSQL, Redis, API, web, workers and controller.
- No mandatory GPU, Kubernetes, multi-tenant infrastructure, or microVM/KVM dependency for MVP.
- The default Compose-based approach is a starting point, **not a security equivalence to a sandbox/microVM**. Stronger isolation can be introduced after risk assessment.
- Separate Studio administrative session from untrusted Preview origins. Restrict exposed ports, networking, filesystem mounts and privileges.
- Secret material stays outside Git and outside agent-visible prompts, logs and ordinary config exports. See [Security](../engineering/security.md).

## 9. Bootstrap implementation decisions (P0 v2 baseline)

These are the selected **implementation baselines**, not claims that the code or controls already exist. Their implementing Technical Tasks must pass before the Create Project User Story becomes Ready.

| Area | Decision | Why |
| --- | --- | --- |
| Operator auth | Single-operator password login, Argon2id hash configured as a secret, Redis-backed opaque server-side sessions, secure HttpOnly cookie | Meets authenticated/unauthorized acceptance without full identity platform |
| Database | PostgreSQL with Prisma ORM, Prisma Migrate and explicit persistence adapters | One standard schema and migration path for the monorepo |
| REST contracts | Zod 4 source schemas → `nestjs-zod` + `@nestjs/swagger` OpenAPI → `@hey-api/openapi-ts` generated Fetch client | Contract-first path with no duplicated handwritten frontend DTOs |
| Repository | `main` is the **GitHub default** and stable/release branch; `dev` is the **PR integration branch** (PRs set `--base dev` explicitly) | One unambiguous PR target; Issues are closed explicitly after DoD rather than by `Closes #...` |
| Agent execution | Official Claude Code and Codex CLI binaries behind a small provider-specific runner interface; no API/SDK runners in MVP; automated execution enabled per provider only after its auth/execution model is validated against current terms | Preserves native CLI behavior while keeping the provider-policy risk gated; see [Security](../engineering/security.md) §2 |
| Agent SDLC roles | Operator coordinates in a primary Claude Code session; implementer uses a fresh Claude Code or Codex CLI context; reviewer uses a separate context | No imaginary take-ticket automation or agent framework required at bootstrap |

Auth details: the API owns login, session validation and authorization; Next.js remains presentation and calls a same-origin `/api` route through a trusted proxy. Use HTTPS in deployment, login rate limiting, origin/CSRF checks for state-changing operations, session rotation on login, secure cookies and a server-side session TTL. No OAuth, SSO, registration, multi-user identity or RBAC in Story 1. Never store the password or hash in the repository.

Prisma lives under `packages/database/` and infrastructure adapters; generated Prisma types do not enter `domain/`. Zod schemas remain owned by each feature, not by the generated client. `packages/contracts` is still reserved for justified cross-process runtime contracts; generated browser API code can reside in `apps/web/src/platform/api/generated/`.

Implementation sequencing, exact bootstrap commands, and agent role ownership: see [Bootstrap](../engineering/bootstrap-plan.md) and [Agent roles](../engineering/agent-roles.md). Security details: [Security](../engineering/security.md).

## 10. Decisions intentionally deferred

- Exact server/container isolation strategy, worker credentials, network egress policies, and resource budgets.
- Outcome of the per-provider CLI terms/auth validation, provider credential handling and throttling (the CLI-only approach and its acceptance gate are decided; see [Security](../engineering/security.md) §2).
- External identity integration (OAuth/SSO, multi-operator RBAC) and precise production domain/TLS topology; the minimal single-operator session strategy above is **not deferred**.
- Exact scope and configuration semantics of MCP management in the first release.
- Workflow versioning/step state machine and failure/compensation policies.
- Scalability, multi-workspace API gateways, deployment stages and microVM sandboxes.

## 11. References

- [Backend architecture](backend.md)
- [Frontend architecture](frontend.md)
- [Security guardrails](../engineering/security.md)
- [Quality & architecture gates](../engineering/quality.md)
- [Bootstrap prerequisites and branches](../engineering/bootstrap-plan.md)
- [Agent roles and take-ticket procedure](../engineering/agent-roles.md)
- [Main architecture decision record (Notion)](https://app.notion.com/p/3fad4d814eb0817a9ba8c264625b4faa) — **later sections supersede earlier historical proposals**.
