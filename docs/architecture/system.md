# System Architecture — AI Agent Studio

**Status:** approved high-level target architecture. Nothing is implemented yet; specifics not explicitly agreed below are subject to User Story refinement.

## 1. Architectural principles

- **One TypeScript stack:** NestJS API and Next.js App Router UI.
- API: **Modular Monolith + Vertical Slice Architecture (VSA) + Lightweight Clean Architecture**. Frontend: feature-first, modular.
- Exactly **six business modules** in the API, not six microservices.
- Separate **technical processes** for background execution and narrowly privileged environment management.
- Git-first / file-native configuration of coding agents and skills where their CLIs support it.
- Human-controlled changes: isolated branches and working copies, tests, review, and approval before merge.
- Self-hosted, single operator; least privilege, isolation, observability, recoverability.
- Abstractions answer a concrete use case; no empty scaffolding.

## 2. Logical context

```text
Human operator
  │
  ▼
Next.js Studio (apps/web)
  │  REST + SSE (via approved auth)
  ▼
NestJS API (apps/api) ───────── PostgreSQL, Redis + BullMQ
  │  projects / agents / workflows / executions / environments / mcp
  │
  ├◄─────── run handling calls ── agent-worker (apps/agent-worker)
  │         (worker → API only)    host, agent user
  │                                 │
  │                                 └── Official Claude/Codex CLI
  │                                     in a working copy per run
  │
  └── Authorized environment actions → environment-controller
                                          │
                                          └── controlled Docker Compose
                                              for project Preview

Traefik exposes only explicitly approved UI/Preview entrypoints.
```

Conceptual diagram. The exact network, queue, auth, and deployment boundaries must be implemented and tested.

## 3. Business module ownership

| Module | Owns | Does not own |
| --- | --- | --- |
| `projects` | Project lifecycle, repository connection, Git branches, diff, approval and merge | Agent definitions, raw Docker privilege |
| `agents` | `AgentDefinition`, `SkillDefinition`, assignment, native-file definitions, validation and publishing | Task queue execution |
| `workflows` | Workflow definitions, step dependencies, ordering, conditions, human approval semantics | Individual worker/process execution plumbing |
| `executions` | Runs, state transitions, queue scheduling, progress/log/result records | Direct Docker host control or unrelated project Git internals |
| `environments` | Project environment lifecycle, Compose stack abstraction, health/logs, shared Preview | CLI agent definitions |
| `mcp` | Reusable MCP server definitions, bindings, validation/connection checks, CLI tool configuration | Project repository internals or a full gateway in MVP |

Frontend navigation may cross these boundaries (`/skills` is part of `agents`; `/projects/:id/preview` shows `environments` in a project context). Backend boundaries remain authoritative.

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

`shared/` holds only domain-neutral helpers; business use cases belong to their owning modules.

## 5. Processes and cross-process contracts

- `apps/web`: UI only; never connects directly to privileged infrastructure or the agent worker.
- `apps/api`: authoritative business operations, state, authentication, coordination; REST for operations, SSE for realtime delivery.
- `apps/agent-worker`: runs on the host as the agent user, outside Studio's containers ([ADR 0002](adr/0002-agent-run-isolation.md)). It always calls the API, with a token limited to handling runs, to take approved runs and report status, events and results; the API never reaches into the host, and the worker has no access to the database or Redis. It runs official CLI adapters in a working copy per run. **Never gets access to the system Docker daemon or its socket**; agents may use the agent user's rootless Docker daemon ([Security](../engineering/security.md) §2).
- `apps/environment-controller`: narrow privileged interface for validated, authorized Docker Compose operations; no generic shell/Docker command interface.
- `packages/contracts`: a cross-process contract is extracted here **only if** multiple runtime apps need it. One source of truth; never the same schema in both a module and a shared package.

## 6. Integration events and reliable messaging

- Domain events are **not** a required MVP concept. Modules that need asynchronous communication use **integration events**.
- The publishing module owns and publicly exports the versioned event contract (e.g. `ExecutionCompletedV1`); prefer a Zod schema + inferred TypeScript type.
- The application handler changes business state and writes the event to a **PostgreSQL transactional outbox** in one DB transaction (when both writes use the same DB).
- The outbox dispatcher delivers **at-least-once**; consumers use an inbox / processed-event marker for idempotency and per-consumer delivery tracking. Never claim exactly-once delivery.
- `consumers/<event>/consumer.ts` validates/maps the event and delegates to a local feature handler, where business logic lives. Read projection handlers may update a projection directly when appropriate.
- Git/Docker/CLI side effects are **not** transactionally atomic with PostgreSQL: model state transitions, retries, reconciliation, and partial failure explicitly.
- BullMQ delivers long-running jobs. Durable execution history and live SSE progress are separate from outbox retention.

## 7. Git and project collaboration

- Each run gets its own working copy: a clone made from a per-project cache, at the exact commit Studio recorded, on a branch named for the run ([ADR 0002](adr/0002-agent-run-isolation.md)).
- Agents push their run branches and open pull requests through the agent account, whose token is limited to the managed repositories; branch protection keeps protected branches under the operator's approval. Studio's own Git operations use its Git adapter and the Project's Deploy key, which never reaches the agent ([Security](../engineering/security.md) §4).
- Outputs are examined as diffs, tested and reviewed before a controlled merge to the project's integration branch (default `dev`).
- Each project has **one shared default Preview** reflecting the project's integration branch (default `dev`) after approved merges; **not** a Preview per agent.
- Merge and production deployment are protected operations, never direct worker privileges.

## 8. Deployment and trust boundaries

- Target: one dedicated server, single operator, with no production credentials on it and backups kept off it ([ADR 0002](adr/0002-agent-run-isolation.md)).
- **Studio's side:** the reverse proxy, database, queue, API, web and environment-controller run as a Docker Compose stack under the system Docker daemon, which only root controls.
- **The agent side:** the agent worker and the agents run on the host as an ordinary user (the agent user), not in the `docker` group and without passwordless `sudo`, with their own rootless Docker daemon. This operating-system boundary is the security boundary; CLI hooks and permission rules are guardrails only.
- MVP has no mandatory GPU, Kubernetes, multi-tenant infrastructure, or microVM/KVM dependency.
- Compose is a starting point, **not security-equivalent to a sandbox/microVM**; stronger isolation can follow a risk assessment.
- Keep the Studio administrative session separate from untrusted Preview origins. Restrict exposed ports, networking, filesystem mounts and privileges.
- Secret material stays outside Git and outside agent-visible prompts, logs and ordinary config exports. See [Security](../engineering/security.md).

## 9. Bootstrap implementation decisions (P0 v2 baseline)

Selected **implementation baselines**, not claims that code or controls exist. Their implementing Technical Tasks must pass before the Create Project User Story becomes Ready.

The decision table (approach, exclusions, rationale) is canonical in [Bootstrap](../engineering/bootstrap-plan.md) §2. It covers operator auth, database, REST contracts, repository branches, agent execution and agent SDLC roles. Architectural consequences:

**Auth:** the API owns login, session validation and authorization. Next.js is presentation only and calls a same-origin `/api` route through a trusted proxy. Story 1 excludes OAuth, SSO, registration, multi-user identity and RBAC. The password and its hash never enter the repository. Session, cookie, CSRF and rate-limit requirements are canonical in [Security](../engineering/security.md) §8.

**Persistence and contracts:** Prisma lives under `packages/database/` and infrastructure adapters; generated Prisma types do not enter `domain/`. Zod schemas are owned by each feature, not by the generated client; an HTTP schema shared by several features of one module lives in that module's `contracts/http/` and is not consumed by other modules ([Backend](backend.md) §2). `packages/contracts` stays reserved for justified cross-process runtime contracts; generated browser API code can live in `apps/web/src/platform/api/generated/`.

Sequencing, exact bootstrap commands and role ownership: [Bootstrap](../engineering/bootstrap-plan.md), [Agent roles](../engineering/agent-roles.md).

## 10. Decisions intentionally deferred

- Network egress policies and resource budgets. The run isolation model is decided in [ADR 0002](adr/0002-agent-run-isolation.md); its open decisions are listed there.
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
