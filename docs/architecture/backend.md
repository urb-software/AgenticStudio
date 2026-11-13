# Backend Architecture — NestJS / VSA

**Status:** approved module boundaries and core conventions; code examples are architectural targets, not implemented files.

## 1. Style and decision hierarchy

**NestJS Modular Monolith + Vertical Slice Architecture + Lightweight Clean Architecture.**

Exactly six business modules under `apps/api/src/modules/`:

1. `projects` (**including Git**)
2. `agents` (**including skills**, with distinct domain models and lifecycle)
3. `workflows`
4. `executions`
5. `environments`
6. `mcp` (independent registry and bindings)

Superseded: earlier proposals that separated `git` or `skills`, used Python/FastAPI, or mandated `command.ts` / `query.ts` files.

## 2. Canonical directory convention

```text
apps/api/src/
  modules/     # projects, agents, workflows, executions, environments, mcp
  platform/    # auth, database, queue, messaging, config, logging
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

**No empty mandatory directories.** `handler.ts` is the default feature entry point; `endpoint.ts`, `schema.ts`, `input.ts`, consumers, ports and domain folders exist only when needed.

**A schema shared by several features of one module** (e.g. the `Project` response used by `create-project` and `list-projects`) is part of the module's public HTTP contract: it lives in `contracts/http/` and is exported from `contracts/index.ts`. Features never import another feature's `schema.ts`. Like all of `contracts/`, it is self-contained: no import of the module's `domain/` (a response mapper takes a plain shape, not a domain type). A schema used by one feature stays in that feature's `schema.ts`.

## 3. Dependency rules

- **Domain stays framework-independent.** `domain/` never imports NestJS, Prisma, database connections, Redis, BullMQ, Git CLI, Docker, or HTTP types.
- **Handlers own use-case business logic.** They depend on domain abstractions and ports, never on concrete infrastructure implementations.
- **HTTP endpoints and event consumers are thin adapters:** validate/map input, invoke the local handler, map output/errors. No business flows or transaction rules there.
- **Infrastructure implements interfaces.** Bind via NestJS DI tokens at the composition root; wiring dependencies allowed at module setup must be explicit and narrowly scoped.
- **Modules expose public contracts.** A module never imports a sibling's private `features/`, `domain/`, `infrastructure/` or repositories.
- **No cycles** across modules or architecture layers.
- Business-specific behavior never goes into `platform/` or `shared/` to bypass module boundaries.

```typescript
// Allowed: public publisher-owned contract in another module
import { ExecutionCompletedV1Schema } from '@modules/executions/contracts';

// Forbidden: bypassing another module's encapsulation
// import { PrismaExecutionRepository } from '../executions/infrastructure/repositories/...';
```

The `@modules/*` alias is conceptual; define aliases in tooling before using them.

## 4. Feature boundaries and CQRS semantics

- Commands **change state**; queries **read state**. Keep the semantic distinction, but **no** mandatory command/query bus or `command.ts`/`query.ts` files.
- Default: one feature folder per use case, one `handler.ts`. A command and a query with different behavior are separate features.
- Commands may persist aggregates and schedule external work through ports. Queries must not change business state.
- Queries may use a read repository port and return read DTOs directly, without reconstructing rich aggregates. The read model stays in the **same PostgreSQL** initially; no event sourcing or separate CQRS database.
- Interfaces: aggregate repositories in `domain/repositories/`; read repositories and non-domain abstractions in `ports/`. Implementations: `infrastructure/repositories/` or `infrastructure/adapters/`.
- Transport-specific request validation is local to the HTTP feature (`schema.ts`). Handler input types are transport-independent, colocated in the handler or optional `input.ts`. No global DTO dump.
- **REST contract bridge:** Zod 4 schemas are authoritative for request and response data, converted to NestJS DTOs by `nestjs-zod` (v5-family) and documented via `@nestjs/swagger`. Run the version-appropriate `cleanupOpenApiDoc` step before emitting the canonical OpenAPI 3.1 JSON. Validate both request and response behavior where necessary. No parallel `class-validator` DTOs for the same endpoint.
- The OpenAPI document generates the browser client via `@hey-api/openapi-ts` (Fetch). Generation is reproducible and checked in CI; see [Bootstrap](../engineering/bootstrap-plan.md). The browser never imports private backend feature code.

## 5. PostgreSQL persistence and migrations

- **Prisma ORM + Prisma Migrate**, with version-compatible Prisma configuration and PostgreSQL driver adapter. Check the current Prisma major-version setup during scaffolding; do not paste legacy v6 `datasource.url` patterns into newer versions.
- The canonical Prisma schema and migration history live in `packages/database/prisma/`. Migrations are reviewed, versioned code: no unreviewed production `db push` or destructive reset. Local development generates migrations; deployment applies committed ones.
- `platform/database` creates and manages the Prisma connection; repositories receive it through DI. Concrete Prisma repositories live in the owning module's `infrastructure/repositories/`. `domain/` and handlers never depend on Prisma classes or generated database types.
- Testcontainers-backed PostgreSQL integration tests cover repository behavior and migrations before Story 1. Simple CRUD does not justify a second ORM or separate query database.

## 6. Cross-module contracts & integration events

- The publishing module defines **one canonical, versioned Integration Event contract**, exported through its public `contracts/index.ts`.
- Prefer Zod runtime validation with inferred static TS types, plus a shared platform event envelope (e.g. `eventId`, `eventType`, `occurredAt`, optional correlation and causation IDs, `payload`).
- The handler publishes the event through the transactionally persisted outbox when the business change uses the same PostgreSQL transaction.
- Dispatcher + inbox give at-least-once, idempotent processing; multiple consumers need independent delivery tracking. See [System](system.md) §6.
- Consumers validate/map received data and delegate to their own feature; never import another module's private handler as a shortcut.
- **No** `domain/events/` by default in the MVP.
- An event contract crossing process boundaries is extracted to `packages/contracts` only when justified. **Never keep two competing definitions.**

### Example flow

```text
executions/features/complete-execution/handler.ts
  └── DB transaction + ExecutionCompletedV1 in outbox
       └── platform/messaging/outbox dispatcher
            └── workflows/consumers/execution-completed/consumer.ts
                 └── workflows/features/complete-workflow-step/handler.ts
```

## 7. Worker, Git and privileged infrastructure

- Jobs flow through Redis + BullMQ to `apps/agent-worker`, which operates through a narrowly defined CLI runner adapter and an assigned Git worktree.
- The runner port is small and provider-agnostic; each provider (Claude Code CLI, Codex CLI) gets its own adapter. API/SDK runners are out of scope for MVP.
- Provider gate (canonical in [Security](../engineering/security.md) §2): the worker checks the fail-closed per-provider flag (`CLAUDE_CODE_ENABLED`, `CODEX_CLI_ENABLED`) before spawning any CLI subprocess, and never extracts, intercepts, shares or proxies subscription credentials.
- Workers have **no Docker socket**, privileged Compose access, production DB credentials or unrestricted filesystem access.
- Docker Compose actions go through `apps/environment-controller`, behind authorization and approved operations.
- Git belongs to `projects`; other modules consume its public interfaces, not its adapter or repositories.
- External Git/Docker/CLI operations cannot be rolled back by a DB transaction: expose explicit states, timeouts, error handling and reconciliation.
- `agents` owns separate `AgentDefinition` and `SkillDefinition` models; `mcp` owns reusable server definitions/bindings.

## 8. Test requirements

- Unit: handler/domain behavior, error cases and transitions using controlled fakes.
- Integration: repositories, API validation/auth, PostgreSQL transaction behavior, outbox/inbox, Redis/BullMQ where used (Testcontainers when appropriate).
- HTTP integration tests that build the whole app (`AppModule`, real database client) live in `apps/api/src/__tests__/`, outside `src/modules/`: building the app reaches the database client, which `architecture:api` forbids for anything under a feature folder, tests included. Unit tests of a feature stay in its `__tests__/` with fakes of the ports.
- Contract: REST DTO/schema compatibility and event versions.
- Architecture: full dependency graph and structural rules in **`architecture:api`**.
- Security/reliability: authorization failures, duplicate events, retry, cancellation, filesystem/worktree isolation, privileged-action rejection.

Preferred runner: **Vitest**; supporting tools: `@nestjs/testing`, Supertest, Testcontainers. No global coverage percentage target at bootstrap; prioritize meaningful business cases. Architecture tests block merge once CI is implemented.

See [Quality](../engineering/quality.md) and [Security](../engineering/security.md).

## 9. Avoid overengineering

No mandatory generic `BaseRepository`, mediator/message bus for every feature, separate event-sourced models, mandatory extra layers, one module per table, domain events by default, or six microservices. Introduce abstractions where there is a tested reason.

Decision provenance: [backend architecture hub](https://app.notion.com/p/3fad4d814eb0817a9ba8c264625b4faa), especially decisions 14–15.
