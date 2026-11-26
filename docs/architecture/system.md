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
  └◄─────── Preview work calls ── environment-controller
            (controller → API only)   host, Preview user
                                       │
                                       └── controlled Docker Compose in the
                                           Preview user's rootless Docker
                                           for the project Preview

The reverse proxy (Caddy, `deploy/Caddyfile`) exposes only Studio's own hostname and the per-Preview hostnames `preview-<12 hex>.<preview domain>` (`deploy/Caddyfile.preview`), which it routes to one socket per Preview after checking the Preview password.
```

Conceptual diagram. The exact network, queue, auth, and deployment boundaries must be implemented and tested.

## 3. Business module ownership

| Module | Owns | Does not own |
| --- | --- | --- |
| `projects` | Project lifecycle, repository connection, the Clone and its fetch, Git branches, the merge method setting | Agent definitions, raw Docker privilege, the pull request, its review and merge |
| `agents` | Agent definitions read from the definitions Repository's Integration branch, the list of agents with their validation, the Default agents, drafts and publishing; Skill definitions (a model distinct from Agent definitions, [ADR 0006](adr/0006-skill-definitions.md)) | The Repository connection and the Clone, Runs and their queue, Git credentials |
| `workflows` | Workflow definitions, step dependencies, ordering, conditions, human approval semantics | Individual worker/process execution plumbing |
| `executions` | Runs, their working copies, state transitions, queue scheduling, progress/log/result records, the pull request, its review diff, the Merge approval and the merge | Direct Docker host control or unrelated project Git internals |
| `environments` | A Project's Preview settings, the shared Preview and its states, builds and their logs, Compose stack abstraction | CLI agent definitions, Runs, the Project's Clone |
| `mcp` | Reusable MCP server definitions, bindings, validation/connection checks, CLI tool configuration | Project repository internals or a full gateway in MVP |

**Agent definitions** ([ADR 0005](adr/0005-agent-definitions-in-git.md), Epic #298) are files in one definitions Repository, not rows in the database. The database holds pointers and drafts only: which Repository it is, each Project's default agent, what a Run used, and unpublished changes. The definitions Repository is a Project of its own kind that accepts no Run, no Preview and no Environment file. `agents` reads and writes its Clone only through the public face of `projects` and publishes with that Repository's Deploy key. `executions` records which agent, commit and model a Run used through the public face of `agents`, and hands the agent's folder at that commit to the agent worker with the Run. A Run's commit is the version: whatever is on the definitions Repository's Integration branch is published.

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
- `apps/agent-worker`: runs on the host as the agent user, outside Studio's containers ([ADR 0002](adr/0002-agent-run-isolation.md)). It always calls the API, with a token limited to handling runs, to take approved runs and report status, events and results; the API never reaches into the host, and the worker has no access to the database or Redis. It runs official CLI adapters in a working copy per run ([behaviour notes](agent-worker.md)). **Never gets access to the system Docker daemon or its socket**; agents may use the agent user's rootless Docker daemon ([Security](../engineering/security.md) §2).
- `apps/environment-controller`: runs on the host as the Preview user, a third user with its own rootless Docker daemon, outside Studio's containers ([ADR 0004](adr/0004-preview-isolation.md)). Like the agent worker it always calls the API, with its own token limited to Preview work, to claim Preview work and report state and build logs; the API never reaches into the host. Its token cannot handle Runs and the worker's token cannot handle Previews. It starts Docker Compose only in the Preview user's daemon. No generic shell/Docker command interface, no access to the system Docker daemon, and no Git credential or Working copy.
- `packages/contracts`: a cross-process contract is extracted here **only if** multiple runtime apps need it. One source of truth; never the same schema in both a module and a shared package. It holds the worker protocol and the shared kernel ([Backend](backend.md) §6) and no Integration Event: a cross-process Integration Event needs a decision first, and `architecture:monorepo` rejects an event-versioned export name there.

## 6. Integration events and reliable messaging

- Domain events are **not** a required MVP concept. Modules that need asynchronous communication use **integration events**.
- The publishing module owns and publicly exports the versioned event contract (e.g. `ExecutionCompletedV1`); prefer a Zod schema + inferred TypeScript type.
- The application handler changes business state and writes the event to a **PostgreSQL transactional outbox** in one DB transaction (when both writes use the same DB).
- The outbox dispatcher delivers **at-least-once**; consumers use an inbox / processed-event marker for idempotency and per-consumer delivery tracking. Never claim exactly-once delivery.
- `entry-points/consumers/<event>/consumer.ts` validates/maps the event and calls a handler of its own module, where business logic lives. Read projection handlers may update a projection directly when appropriate.
- Git/Docker/CLI side effects are **not** transactionally atomic with PostgreSQL: model state transitions, retries, reconciliation, and partial failure explicitly.
- BullMQ delivers long-running jobs. Durable execution history and live SSE progress are separate from outbox retention.

## 7. Git and project collaboration

- Each run gets its own working copy: a clone made from a per-project cache, at the exact commit Studio recorded, on a branch named for the run ([ADR 0002](adr/0002-agent-run-isolation.md)).
- The agent worker pushes run branches and opens draft pull requests through the agent account ([ADR 0002](adr/0002-agent-run-isolation.md)), whose token is limited to the managed repositories; branch protection keeps protected branches under the operator's approval. Studio's own Git operations use its Git adapter and the Project's Deploy key, which never reaches the agent ([Security](../engineering/security.md) §4). An operator's merge or close of a Run's pull request is the one use of Studio's Merge credential, a token limited to the managed repositories ([ADR 0002](adr/0002-agent-run-isolation.md#merge-decisions-2026-11-21)).
- Outputs are examined as diffs, tested and reviewed before a controlled merge to the project's integration branch (default `dev`).
- Each project has **one shared default Preview** reflecting the project's integration branch (default `dev`) after approved merges; **not** a Preview per agent.
- Merge and production deployment are protected operations, never direct worker privileges. The operator merges from Studio with the Merge credential; the Agent account never merges.

## 8. Deployment and trust boundaries

- Target: one dedicated server, single operator, with no production credentials on it and backups kept off it ([ADR 0002](adr/0002-agent-run-isolation.md)).
- **Studio's side:** the reverse proxy, database, queue, API and web run as a Docker Compose stack under the system Docker daemon, which only root controls.
- **The agent side:** the agent worker and the agents run on the host as an ordinary user (the agent user), not in the `docker` group and without passwordless `sudo`, with their own rootless Docker daemon. This operating-system boundary is the security boundary; CLI hooks and permission rules are guardrails only.
- **The Preview side:** the environment-controller and the Previews run on the host as the Preview user, not in the `docker` group and without passwordless `sudo`, with their own rootless Docker daemon used only for Previews ([ADR 0004](adr/0004-preview-isolation.md)). The agent side has no access to the Preview user's credentials or daemon.
- Server setup and the boundary checks run as the agent user: [Deployment](../engineering/deployment.md) (#107).
- MVP has no mandatory GPU, Kubernetes, multi-tenant infrastructure, or microVM/KVM dependency.
- Compose is a starting point, **not security-equivalent to a sandbox/microVM**; stronger isolation can follow a risk assessment.
- Keep the Studio administrative session separate from untrusted Preview origins: the preview domain is never Studio's hostname or a name under it. Restrict exposed ports, networking, filesystem mounts and privileges.
- Secret material stays outside Git and outside agent-visible prompts, logs and ordinary config exports. See [Security](../engineering/security.md).

## 9. Bootstrap implementation decisions (P0 v2 baseline)

Selected **implementation baselines**, not claims that code or controls exist. Their implementing Technical Tasks must pass before the Create Project User Story becomes Ready.

The decision table (approach, exclusions, rationale) is canonical in [Bootstrap](../engineering/bootstrap-plan.md) §2. It covers operator auth, database, REST contracts, repository branches, agent execution and agent SDLC roles. Architectural consequences:

**Auth:** the API owns login, session validation and authorization. Next.js is presentation only and calls a same-origin `/api` route through a trusted proxy. Story 1 excludes OAuth, SSO, registration, multi-user identity and RBAC. The password and its hash never enter the repository. Session, cookie, CSRF and rate-limit requirements are canonical in [Security](../engineering/security.md) §8.

**Persistence and contracts:** Prisma lives under `packages/database/` and infrastructure adapters; generated Prisma types do not enter `domain/`. Zod schemas are owned by each endpoint or contract, not by the generated client; an HTTP shape shared by several endpoints of one module lives in that module's `entry-points/http/shared/` ([Backend](backend.md) §2). `packages/contracts` stays reserved for justified cross-process runtime contracts; generated browser API code can live in `apps/web/src/platform/api/generated/`.

Sequencing, exact bootstrap commands and role ownership: [Bootstrap](../engineering/bootstrap-plan.md), [Agent roles](../engineering/agent-roles.md).

## 10. Decisions intentionally deferred

- Network egress policies for Runs and resource budgets. (A Preview's network access is decided: [ADR 0004](adr/0004-preview-isolation.md#network-decision-2026-11-23).) The run isolation model is decided in [ADR 0002](adr/0002-agent-run-isolation.md); its pending inputs are listed there.
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
