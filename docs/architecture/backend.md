# Backend Architecture — NestJS / VSA

**Status:** approved module boundaries and core conventions; code examples are architectural targets, not proof of implemented files.

## 1. Style and decision hierarchy

**NestJS Modular Monolith + Vertical Slice Architecture + Lightweight Clean Architecture.**

The application has exactly six business modules under `apps/api/src/modules/`:

1. `projects` (**including Git**)
2. `agents` (**including skills**, with distinct domain models and lifecycle)
3. `workflows`
4. `executions`
5. `environments`
6. `mcp` (independent registry and bindings)

Earlier proposals that separated `git` or `skills`, used Python/FastAPI, or mandated `command.ts` / `query.ts` files are superseded.

## 2. Canonical directory convention

```text
apps/api/src/
  modules/
    projects/
    agents/
    workflows/
    executions/
    environments/
    mcp/
  platform/
    auth/
    database/
    queue/
    messaging/
    config/
    logging/
  shared/

modules/{module}/
  features/
    {feature}/
      handler.ts             # application use case, query OR command
      endpoint.ts            # optional thin HTTP adapter
      schema.ts              # optional HTTP schema, e.g. Zod
      input.ts               # optional complex use-case input type
      __tests__/
  consumers/
    {event-name}/
      consumer.ts            # thin integration event adapter
      __tests__/
  domain/
    entities/
    value-objects/
    services/
    repositories/           # aggregate repository INTERFACES
  ports/                    # read repositories, external services, runner ports, etc.
  infrastructure/
    repositories/            # concrete read/write repository implementations
    adapters/                # Git, CLI, secret store, infrastructure adapters
  contracts/
    events/                 # publisher-owned versioned Integration Events
    index.ts                # public contract exports
  {module}.module.ts
```

**Do not create empty mandatory directories.** `handler.ts` is the default feature implementation entry point. `endpoint.ts`, `schema.ts`, `input.ts`, consumers, ports and domain folders exist only when needed.

## 3. Dependency rules

- **Domain stays framework-independent.** Never import NestJS, Prisma, database connections, Redis, BullMQ, Git CLI, Docker, or HTTP types into `domain/`.
- **Handlers own use-case business logic.** Depend on domain abstractions and ports; do not reach directly into concrete infrastructure implementations.
- **HTTP endpoints and event consumers are thin adapters.** Validate/map input, invoke the appropriate local handler, map output/errors. Do not place business flows or transaction rules there.
- **Infrastructure implements interfaces.** Use NestJS DI tokens/bindings at the composition root; allowed wiring dependencies at module setup must be explicit and narrowly scoped.
- **Modules expose public contracts.** Other modules must not import private `features/`, `domain/`, `infrastructure/` or repositories from a sibling.
- **No cycles** across modules or architecture layers.
- Do not put business-specific behavior into `platform/` or generic `shared/` just to bypass module boundaries.

Examples:

```typescript
// Allowed: public publisher-owned contract in another module
import { ExecutionCompletedV1Schema } from '@modules/executions/contracts';

// Forbidden: bypassing another module's encapsulation
// import { PrismaExecutionRepository } from '../executions/infrastructure/repositories/...';
```

The `@modules/*` alias is conceptual; define aliases in tooling before using them.

## 4. Feature boundaries and CQRS semantics

- Commands **change state**; queries **read state**. Keep this semantic distinction, but **do not** mandate a command/query bus or `command.ts`/`query.ts` files.
- Default: one feature folder per use case, one `handler.ts`. A command and a query with different behavior have separate features.
- Commands may persist aggregates and schedule external work through ports; queries must not cause business state changes.
- Queries may use a read repository port and return read DTOs directly without reconstructing rich domain aggregates. Keep the read model in the **same PostgreSQL** initially — no event sourcing or separate CQRS database.
- Aggregate repository **interfaces** live in `domain/repositories/`, concrete implementations in `infrastructure/repositories/`.
- Read repository interfaces and non-domain abstractions live in `ports/`, implementations in `infrastructure/repositories/` or `infrastructure/adapters/`.
- Transport-specific request validation is local to the HTTP feature (`schema.ts`); handler input types are transport-independent, colocated in the handler or optional `input.ts`. Avoid a global DTO dump.
- **Selected REST contract bridge:** Zod 4 schemas are authoritative for request and response data, converted to NestJS DTOs by `nestjs-zod` (v5-family) and documented via `@nestjs/swagger`. Use the version-appropriate `cleanupOpenApiDoc` step before emitting the canonical OpenAPI 3.1 JSON. Validate both request and response behavior where necessary. Do not maintain parallel `class-validator` DTO definitions for the same endpoint.
- The OpenAPI document generates the browser client via `@hey-api/openapi-ts` (Fetch). Generate and check reproducible artifacts in CI; see [Bootstrap](../engineering/bootstrap-plan.md). The browser must never import private backend feature code.

## 5. PostgreSQL persistence and migrations

- **Selected tool: Prisma ORM + Prisma Migrate**, using version-compatible Prisma configuration and PostgreSQL driver adapter. Consult current Prisma major-version setup during scaffolding; do not paste legacy v6 `datasource.url` patterns into newer versions.
- Canonical Prisma schema and migration history belong in `packages/database/prisma/`. Treat migrations as reviewed versioned code; no unreviewed production `db push` / destructive reset. Local development generates migrations; deployment applies committed migrations.
- `platform/database` creates and manages the Prisma connection; repositories use it through DI. Concrete Prisma-based repositories live in owning modules' `infrastructure/repositories/`; `domain/` and application handlers never depend on Prisma classes or generated database types.
- Testcontainers-backed PostgreSQL integration tests cover repository behavior and migrations before Story 1; simple CRUD does not justify a second ORM or separate query database.

## 6. Cross-module contracts & integration events

- The publishing module defines **one canonical, versioned Integration Event contract**, exported through its own public `contracts/index.ts`.
- Prefer Zod runtime validation with inferred static TS types, plus a shared platform event envelope (e.g. `eventId`, `eventType`, `occurredAt`, optional correlation and causation IDs, `payload`).
- The application handler publishes the integration event directly via a transactionally persisted outbox, if the business change uses the same PostgreSQL transaction.
- Dispatcher and inbox provide at-least-once + idempotent processing; multiple consumers need independent delivery tracking.
- Consumers validate/map received data and delegate to their own feature. Never import another module's private handler as a shortcut.
- Do **not** add `domain/events/` by default in the MVP.
- If an event contract crosses process boundaries, extract it to `packages/contracts` only when justified. **Never keep two competing definitions.**

### Example flow

```text
executions/features/complete-execution/handler.ts
  └── DB transaction + ExecutionCompletedV1 in outbox
       └── platform/messaging/outbox dispatcher
            └── workflows/consumers/execution-completed/consumer.ts
                 └── workflows/features/complete-workflow-step/handler.ts
```

## 7. Worker, Git and privileged infrastructure

- Jobs flow through Redis + BullMQ to `apps/agent-worker`; the worker operates through a narrowly defined CLI runner adapter and an assigned Git worktree.
- Keep the runner port small and provider-agnostic; each provider (Claude Code CLI, Codex CLI) gets its own adapter. API/SDK runners are out of scope for MVP. The worker never extracts, intercepts, shares or proxies subscription credentials, and a provider's adapter stays disabled until its auth/execution model passes the acceptance gate in [Security](../engineering/security.md) §2. The worker enforces this at runtime with fail-closed per-provider flags (`CLAUDE_CODE_ENABLED`, `CODEX_CLI_ENABLED`) checked before any CLI subprocess is spawned.
- Workers have **no Docker socket**, privileged Compose access, production DB credentials or unrestricted filesystem access.
- Docker Compose actions go through `apps/environment-controller` behind authorization and approved operations.
- Git belongs to `projects`; other modules consume its public interfaces, not its adapter or repositories.
- External Git/Docker/CLI operations cannot be rolled back by a DB transaction; expose explicit states, timeouts, error handling and reconciliation.
- `agents` owns separate `AgentDefinition` and `SkillDefinition` models; `mcp` owns reusable server definitions/bindings.

## 8. Test requirements

- Unit tests: handler/domain behavior, error cases and transitions using controlled fakes.
- Integration tests: repositories, API validation/auth, PostgreSQL transaction behavior, outbox/inbox, Redis/BullMQ where used (Testcontainers when appropriate).
- Contract tests: REST DTO/schema compatibility and event versions.
- Architecture tests: full dependency graph and structural rules in **`architecture:api`**.
- Security/reliability: authorization failures, duplicate events, retry, cancellation, filesystem/worktree isolation and privileged-action rejection.

Use **Vitest** as the preferred TypeScript runner; `@nestjs/testing`, Supertest, and Testcontainers are recommended supporting tools. Avoid a global coverage percentage target at bootstrap; prioritize meaningful business cases.

See [Quality](../engineering/quality.md) and [Security](../engineering/security.md). Architecture tests must block merge once CI is implemented.

## 9. Avoid overengineering

No mandatory generic `BaseRepository`, mediator/message bus for every feature, separate event-sourced models, mandatory extra layers, one module per table, domain events by default, or six microservices. Introduce abstractions where there is a tested reason.

Decision provenance: [backend architecture hub](https://app.notion.com/p/3fad4d814eb0817a9ba8c264625b4faa), especially decisions 14–15.
