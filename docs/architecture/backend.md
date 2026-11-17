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
  platform/    # auth, database, secrets, queue, messaging, config, logging
  shared/

modules/{module}/
  application/
    features/{feature}/    handler and its tests; one use case each
    ports/                 interfaces the handlers need from outside
    <collaborator>.ts      rare, specifically named, last resort (rule 3)
  domain/
    entities/              aggregate roots and their child entities: classes
    value-objects/         classes that validate on creation; policies; records of a root with no behaviour
    repositories/          interfaces only
  entry-points/
    http/
      shared/              response shapes and problems used by several endpoints
      <caller>/            endpoints with their schemas, grouped by who calls them
    jobs/  schedulers/  startup/  consumers/
  infrastructure/
    adapters/  repositories/
  contracts/
    index.ts               what other modules may use
    events/                integration events, when a module publishes any
  {module}.module.ts
```

An **entry point** is any code that receives outside input and calls a handler (an HTTP endpoint, job processor, scheduler, start-up routine or event consumer); clean architecture calls it an interface adapter and hexagonal architecture calls it a driving adapter.

The layers sit at the top of a module (clean architecture); the vertical slices are inside the application layer, one folder per use case ([ADR 0003](adr/0003-api-module-layout.md)). This replaces the earlier decision on Issue #30 that placed shared HTTP shapes in `contracts/http/`.

**Secrets are a platform capability** ([ADR 0001](adr/0001-secret-store.md), Issue #57). `platform/secrets/` owns the `SecretStore` port, its PostgreSQL adapter, the AES-256-GCM code and the `secrets` table. A business module stores only the opaque reference. It injects `SECRET_STORE` from `platform/secrets/index.ts` (the port and its typed errors), and its `{module}.module.ts` imports `SecretsModule` from `platform/secrets/secrets.module.ts`. Nothing outside `platform/secrets/` imports any other file there, uses the Prisma `secret` model, or reads `secretsKey` from the configuration (only `platform/config/` and `platform/secrets/` do). `architecture:api` enforces these rules. Each secret carries its module's owner label, so a module can list its own unreferenced secrets (references only) and delete them (ADR 0001 amendment, Issue #76).

**No empty mandatory directories.** `handler.ts` is the default feature file; `input.ts`, ports, collaborators, value objects, the entry-point folders other than `http/`, and `contracts/events/` exist only when needed.

**A response shape used by several endpoints** of one module (e.g. the `Project` response used by `create-project` and `list-projects`) lives in that module's `entry-points/http/shared/`. A schema used by one endpoint stays beside that endpoint. `contracts/` is not used for HTTP shapes: it is self-contained, holds only `index.ts` and `events/`, and imports nothing from the module's `domain/` (rule 8).

## 3. Dependency rules and structure rules

### Dependency rules

- **Domain stays framework-independent.** `domain/` never imports NestJS, Prisma, database connections, Redis, BullMQ, Git CLI, Docker, or HTTP types.
- **Handlers own the orchestration of a use case.** They load, call the domain and save. They depend on domain abstractions and ports, never on concrete infrastructure implementations.
- **Entry points are thin:** validate and map input, invoke the handler, map output and errors. No business flows or transaction rules there.
- **Infrastructure implements interfaces.** Bind via NestJS DI tokens at the composition root; wiring dependencies allowed at module setup must be explicit and narrowly scoped.
- **Modules expose public contracts.** A module never imports a sibling's private `application/`, `domain/`, `entry-points/`, `infrastructure/` or repositories.
- **No cycles** across modules or architecture layers.
- Business-specific behavior never goes into `platform/` or `shared/` to bypass module boundaries.

```typescript
// Allowed: public publisher-owned contract in another module
import { ExecutionCompletedV1Schema } from '@modules/executions/contracts';

// Forbidden: bypassing another module's encapsulation
// import { PrismaExecutionRepository } from '../executions/infrastructure/repositories/...';
```

The `@modules/*` alias is conceptual; define aliases in tooling before using them.

### The thirteen structure rules

Rules 1 to 9 and rules 10 to 13 were approved by the operator on 2026-11-17 (Epic #160, [ADR 0003](adr/0003-api-module-layout.md)). How each is enforced is in [Quality](../engineering/quality.md) §5.

1. **Features are independent.** A feature never imports another feature of its module.
2. **Entry points call handlers; handlers never call each other.** Everything that receives outside input (HTTP endpoints, job processors, schedulers, start-up routines, event consumers) lives in `entry-points/`, is thin, and holds no business rules. The application layer knows nothing about HTTP, queues or timers. Entry points are what clean architecture calls interface adapters and hexagonal architecture calls driving adapters.
3. **Shared application logic is the exception.** When two features need the same logic, try in this order: (1) move it into the domain, onto the object it is about; (2) if it is an infrastructure capability, put it behind a port; (3) if the two features share most of their steps, they are one use case with several entry points, so merge them; (4) if it is a separate step that can happen later, request it as a job or event; (5) if what is left is small, repeat it; (6) only then extract a collaborator with a specific name into `application/`. Never a generic "shared", "common" or "utils" folder, and never one handler calling another.
4. **Behaviour lives on the object it is about.** An entity with a lifecycle is a class: non-public constructor, a factory to create and one to restore, methods for what can happen to it. It cannot be built in an invalid state. A rule about one object is a method on it, with outside facts passed as parameters.
5. **There is no `domain/services/`.** A rule that seems to belong to no object means a concept is missing: name it, usually as a policy or a value object, and put the rule there. A pure function beside the type it works on is the rare exception.
6. **The domain receives facts and never fetches them.** Nothing in the domain takes a repository or a port, or reads or writes. Handlers load, call the domain, and save. Business rules are never written in the database adapter.
7. **Validation has two homes.** A schema beside its endpoint validates the shape of a request and produces field errors; it contains no business rule of its own, and where it repeats a limit it takes it from the domain. Business rules are enforced by the entity or value object they belong to, so they hold for every entry point.
8. **`contracts/` is a module's public face** for other modules, and nothing else.
9. **Same role, same form** (API): state with rules or with dependencies gets a class; everything else is a function or plain data. The table is in §10.
10. **Handlers own their input and result.** Every handler declares its own input type and result type and builds the result itself. A result contains plain data only: snapshots, ids, values and view types. An entity class never leaves the application layer, and a handler never builds an HTTP shape. A snapshot is the entity's current values as read-only plain data, produced by the entity; where a result contains a whole aggregate it reuses the snapshot type and does not repeat its fields. What each kind of handler returns is in the table below.
11. **One aggregate root, one file, one repository.** Anything with its own repository is an aggregate root and lives in `domain/entities/`. A repository interface serves exactly one root.
12. **Aggregates refer to each other by id.** A root never holds or loads another root. A rule that needs facts from another aggregate receives them as values (consistent with rule 6).
13. **One concept per file.** An entity file holds the entity class and nothing else. Each value object, an aggregate's errors and its fact types have their own files. `domain/` exports no loose functions other than type guards. There is no line limit; size is reported, not enforced.

Rules 10 to 13 apply to the API only, as rules 1 to 9 do.

### What a handler returns (rule 10)

| Handler | Returns |
| --- | --- |
| A command the caller needs the result of | The snapshot of the aggregate it changed, or the ids and values the caller needs |
| A command with nothing to show | Nothing, or only the id of what it created |
| A query for one aggregate | That aggregate's snapshot, read from the repository directly where it can return one, without building the entity class to read it |
| A query that combines or computes | A view type owned by the feature that produces it (a read shape is not a domain concept) |

The entry point (endpoint, job processor, scheduler, start-up routine or consumer) maps from the result to its own shape; the handler never does.

### Aggregate root, child entity or value object

The deciding question: **is there a rule that must hold at every moment across both objects?** If yes, they are one aggregate, and one of them is its root. If no, they are separate roots, and each refers to the other by id (rule 12).

Practical tests for a candidate root:

- It has its own id that other objects use to refer to it.
- It has its own repository.
- It is changed in its own transaction.
- Other aggregates refer to it.

A **child entity** has an identity only within its root and is created, changed and bounded through that root. A **value object** has no identity: it is defined by its values, is immutable (a change returns a new value) and validates on creation; where it owns no rule beyond its shape it may be a plain type (§10).

**An aggregate root is always a class in `domain/entities/`**; at minimum it produces its snapshot. A record with no behaviour that is not a root lives in `domain/value-objects/`.

**When unsure, make them separate roots.** Joining two things into one aggregate needs a stated rule that spans them; keeping them apart needs none.

### Current aggregates (target)

This is the target model that the tickets of Epic #160 implement (#182 and #185 for `projects`, #183 and #184 for `executions`). Until they are merged the code differs: some of these still sit under `domain/value-objects/`, and the groupings of the Run's and the Repository connection's value objects are confirmed against the code in their tickets.

| Module | Aggregate roots | Child entities | Value objects and plain records |
| --- | --- | --- | --- |
| `projects` | Project; Repository connection; Environment file | none | The concepts that are part of a Repository connection, listed by #185 |
| `executions` | Run; Run lookup (requested, claimed, completed, failed); Prepared Follow-up; Review comments of a Run; Run diff | Run step, bounded by the Run's step limit | Of the Run, classes: state with its transitions, delivery, pull request status, conversation, worker claim, progress and limits. Plain types: cancellation, working copy, failure, commit (as set by #184) |

The Run log's events are append-only records and not an aggregate: no rule changes or spans them, and nothing refers to one event on its own.

## 4. Feature boundaries and CQRS semantics

- Commands **change state**; queries **read state**. Keep the semantic distinction, but **no** mandatory command/query bus or `command.ts`/`query.ts` files.
- Default: one folder per use case in `application/features/`, one `handler.ts`. A command and a query with different behavior are separate features.
- Commands may persist aggregates and schedule external work through ports. Queries must not change business state.
- Queries may use a read repository port and return read DTOs directly, without reconstructing rich aggregates. The read model stays in the **same PostgreSQL** initially; no event sourcing or separate CQRS database.
- Interfaces: aggregate repositories in `domain/repositories/`; read repositories and non-domain abstractions in `application/ports/`. Implementations: `infrastructure/repositories/` or `infrastructure/adapters/`.
- **Contract naming (enforced by `architecture:api`):** an aggregate repository contract (interface, type alias or abstract class) is named `<Aggregate>Repository` and lives only in `domain/repositories/`; a read repository port is named `<Name>Reader` or `<Name>ReadRepository` and lives only in `application/ports/`. Every other contract that an `infrastructure/` class implements (`implements X`, or `extends` an abstract class) and that is declared in a business module (followed through re-exporting barrels) lives in `domain/repositories/` or `application/ports/`, never in `application/features/`, other `domain/` folders or the adapter file itself. Concrete classes such as `PrismaProjectRepository` are implementations, not contracts.
- Transport-specific request validation is local to the HTTP endpoint (a schema beside it in `entry-points/http/<caller>/`, rule 7). Handler input types are transport-independent, colocated in the handler or optional `input.ts`. No global DTO dump.
- **REST contract bridge:** Zod 4 schemas are authoritative for request and response data, converted to NestJS DTOs by `nestjs-zod` (v5-family) and documented via `@nestjs/swagger`. Run the version-appropriate `cleanupOpenApiDoc` step before emitting the canonical OpenAPI 3.1 JSON. Validate both request and response behavior where necessary. No parallel `class-validator` DTOs for the same endpoint.
- The OpenAPI document generates the browser client via `@hey-api/openapi-ts` (Fetch). Generation is reproducible and checked in CI; see [Bootstrap](../engineering/bootstrap-plan.md). The browser never imports private backend feature code.

## 5. PostgreSQL persistence and migrations

- **Prisma ORM + Prisma Migrate**, with version-compatible Prisma configuration and PostgreSQL driver adapter. Check the current Prisma major-version setup during scaffolding; do not paste legacy v6 `datasource.url` patterns into newer versions.
- The canonical Prisma schema and migration history live in `packages/database/prisma/`. Migrations are reviewed, versioned code: no unreviewed production `db push` or destructive reset. Local development generates migrations; deployment applies committed ones.
- `platform/database` creates and manages the Prisma connection; repositories receive it through DI. Concrete Prisma repositories live in the owning module's `infrastructure/repositories/`. `domain/` and handlers never depend on Prisma classes or generated database types.
- CHECK constraints and partial indexes are not modelled by Prisma; they live only in the migration SQL and are named in a `///` note on their model. With Prisma 7.10, `prisma migrate diff` proposes dropping neither (e.g. `runs_one_active_per_project_key`, the backstop of one active Run per project, Issue #96); the database integration test checks this and that the committed migrations keep the index. If a later Prisma version proposes such a drop, the author deletes that statement from the generated migration.
- Testcontainers-backed PostgreSQL integration tests cover repository behavior and migrations before Story 1. Simple CRUD does not justify a second ORM or separate query database.

## 6. Cross-module contracts & integration events

- The publishing module defines **one canonical, versioned Integration Event contract**, exported through its public `contracts/index.ts`.
- Prefer Zod runtime validation with inferred static TS types, plus a shared platform event envelope (e.g. `eventId`, `eventType`, `occurredAt`, optional correlation and causation IDs, `payload`).
- The handler publishes the event through the transactionally persisted outbox when the business change uses the same PostgreSQL transaction.
- Dispatcher + inbox give at-least-once, idempotent processing; multiple consumers need independent delivery tracking. See [System](system.md) §6.
- Consumers (`entry-points/consumers/`) validate/map received data and call a handler of their own module; never import another module's private handler as a shortcut.
- **No** `domain/events/` by default in the MVP.
- **Event naming and location (enforced by `architecture:api`):** each version of an event is one file `modules/<publisher>/contracts/events/<event-name>-v<n>.ts` (kebab-case name, version `n` ≥ 1, directly in `events/`). It exports only `<EventName>V<n>Schema` (the Zod schema) and/or `<EventName>V<n>` (the type), where `<EventName>` is the PascalCase file name, e.g. `execution-completed-v1.ts` → `ExecutionCompletedV1Schema` and `ExecutionCompletedV1`. The definition is local to that file: no re-export of another file's definition, no `export *`, no default export. A breaking change adds a new `-v<n+1>` file; the old version stays until its consumers have moved. `contracts/index.ts` re-exports the event for other modules.
- **One definition, one publisher:** once `<EventName>V<n>` or `<EventName>V<n>Schema` is published in a `contracts/events/` file, declaring that name anywhere else in `apps/api/src` (for example a consumer redefining the payload locally) is a competing definition and fails the gate. A published event leaves its publisher only under its own name and only through the publisher's `contracts/index.ts`: renaming re-exports (`export { ExecutionCompletedV1 as ExecutionCompletedEvent }`), alias declarations (`type ExecutionCompleted = ExecutionCompletedV1`, `const X = ExecutionCompletedV1Schema`, `interface X extends ExecutionCompletedV1 {}`, also through a namespace import such as `E.ExecutionCompletedV1`), `export default` of an event and re-exports by any other file (including `import * as E` + `export { E }`) (another module's `contracts/index.ts`, a consumer) fail; consumers import from the publisher's `contracts/index.ts`, never by deep-importing its `contracts/events/<file>`. The same `<EventName>` in the `contracts/events/` of two modules, in any versions, fails as a duplicate. An event-like declaration (`…Event`, `…EventSchema`) elsewhere in a module's `contracts/` is an unversioned event and fails too; the within-module HTTP/SSE shapes in `entry-points/http/shared/` (§2, e.g. an `ExecutionLogEvent` stream item) are outside `contracts/` and not subject to this. `contracts/events/` holds only event files (no `index.ts` barrel). Other versioned public types (e.g. a `ProjectSummaryV1` DTO) are not reserved.
- An event contract crossing process boundaries is extracted to `packages/contracts` only when justified. **Never keep two competing definitions.**
- **Shared kernel (Issue #101):** the provider vocabulary in `@agentic-studio/contracts` (`PROVIDERS`, `PROVIDER_NAMES`, `providerSwitchesSchema` / `ProviderSwitches`, `WorkerStatusReport`) is deliberately shared by the API and the agent worker, and the `executions` domain may import it directly instead of keeping its own copy. It holds plain values, types and Zod schemas only, no behaviour; anything else from that package stays in feature, contract or adapter code.

### Example flow

```text
executions/application/features/complete-execution/handler.ts
  └── DB transaction + ExecutionCompletedV1 in outbox
       └── platform/messaging/outbox dispatcher
            └── workflows/entry-points/consumers/execution-completed/consumer.ts
                 └── workflows/application/features/complete-workflow-step/handler.ts
```

## 7. Worker, Git and privileged infrastructure

- `apps/agent-worker` runs on the host as the agent user, outside Studio's containers ([ADR 0002](adr/0002-agent-run-isolation.md)). It always calls the API, with a token limited to handling runs; the API never reaches into the host, and the worker has no access to the database, Redis or BullMQ. It operates through a narrowly defined CLI runner adapter in a working copy per run.
- A run is a sequence of non-interactive CLI steps. Each step streams events, ends with a structured result, and can be resumed by session id. An agent question pauses the run ("waiting for operator"); the operator's answer resumes the same session.
- **Non-agent background work** (e.g. cloning and fetching a repository) runs in BullMQ processors **hosted inside the API process**, through the platform queue capability in `platform/queue/`: a module injects the `JobQueues` port, registers a named queue with its processor during module initialisation, and enqueues jobs under deterministic ids (a duplicate waiting or running id raises `JobAlreadyActiveError`). Jobs run at most once (no automatic retries), can be cancelled and time-limited through an abort signal, and report failures to the owning module; jobs interrupted by a crash are handed to the owner's `reconcile` hook on startup and never re-run. Payloads carry identifiers only; keys live under `studio:queue`; BullMQ types stay inside `platform/queue/`. Reconciliation assumes a single API instance (the MVP deployment): it treats every job still active at startup as interrupted. `apps/agent-worker` remains reserved for CLI agent execution.
- The runner port is small and provider-agnostic; each provider (Claude Code CLI, Codex CLI) gets its own adapter. API/SDK runners are out of scope for MVP.
- Provider gate (canonical in [Security](../engineering/security.md) §2): the worker checks the fail-closed per-provider flag (`CLAUDE_CODE_ENABLED`, `CODEX_CLI_ENABLED`) before spawning any CLI subprocess, and never extracts, intercepts, shares or proxies subscription credentials.
- **Lookups (Issue #142).** Studio never reads the Git host: `executions` records a `run_lookups` request (kinds `pull_request_state`, since Issue #145 `failing_check_logs` and since Issue #146 `review_comments`; later stories add kinds; at most one open request per Run and kind), any connected worker claims up to five over `POST /api/worker/lookups/claim` (a claim not answered within two minutes is handed out again) and answers with `POST /api/worker/lookups/:id/result` (a result of the kind, or a failure: `scope_mismatch`, `rate_limited` with how long to wait, or `failed`). The Run keeps the last known state in its `pr_*` columns, with the Pull request checks of the pull request's latest commit (`pr_checks`, Issue #145). A `failing_check_logs` result is not stored on the Run: it becomes the Run's one prepared Follow-up (`run_prepared_follow_ups`, a port of its own), which the operator reviews and sends through the normal Follow-up route with `source: "pull_request_checks"`; the lookup marks the Run as preparing (`pr_prepare_requested_at`, `pr_prepare_error`) without touching the state refresh's throttle. A `review_comments` lookup (Issue #146; `scope` and `since` on the lookup row) replaces the Run's one loaded set of Review comments (`run_review_comment_sets`, a port of its own: redacted and capped, validated by the shared contract on read, removed when a Follow-up prepared from it is sent); its state (loading, last error) is read from the lookups, not from Run columns. The page-open refresh is asked at most once a minute per Run, Refresh at any time, and an API schedule asks daily for Runs whose pull request is open or unknown.
- **Operator operations on a Run (Issue #167).** A Run changes at the same time by the operator and by the agent worker. What the operator triggers (answer, Follow-up, cancel, delivery retry, resume after the usage limit) is a method of the `Run` class: it checks its preconditions against the Run's own state and the facts passed in, refuses with a domain error, and records what changed. The handler calls `RunRepository.change` (or `changeWithReviewComments` for a Follow-up, `changeSerializedWithClaims` for a resume), which in one transaction loads the Run `FOR UPDATE`, calls the handler's pure callback, and saves the recorded changes. The row lock serializes the change with every other change of the Run: what the agent worker reports for the Run is a method of `Run` run through the same `change` (Issue #169), and the set-wide sweeps and the hand-out are single statements that wait for the lock and then re-check the row, so two simultaneous requests cannot both win. No version column and no retry loop are needed.
- **Worker-triggered operations on a Run (Issue #169).** What the agent worker reports for one Run (a state, including a delivery retry's outcome and a bring-up-to-date request that changed nothing; a Run step with its Question, step limit and usage; a heartbeat; the removal of a Working copy; the Environment file of a claim) is also a method of `Run`, which checks that the reporting worker holds the Run (a late report from a worker that lost its claim is refused with `RunNotHeldError`). The handler uses the same locked `change`. Two kinds of operation stay in the repository, each paired with a named rule in the domain that supplies its selection and its result, and a test that runs the store's statement over fixture rows and compares it with the rule: the hand-out of the next Run (`claimNext`, one atomic statement under the claim lock that locks the row it selects, waits for another transaction that holds it and re-checks it, so the queue order is strict and a cancelled Run is never claimed; `HandOutRule`) and the sweeps over many Runs (lost workers, `LostWorkerRule`; overdue steps, `OverdueStepRule`; Runs waiting too long, `LongWaitRule`; gone workers, `GoneWorkerRule`; the once-per-lease renewal, `LeaseRenewalRule`). The handlers build these rule objects and pass what they supply to the store.
- The worker and its agents have **no access to the system Docker daemon or socket**, privileged Compose access, production DB credentials, Studio's files or unrestricted filesystem access. Agents may use the agent user's rootless Docker daemon ([Security](../engineering/security.md) §2).
- Docker Compose actions go through `apps/environment-controller`, behind authorization and approved operations.
- Git belongs to `projects`; other modules consume its public interfaces, not its adapter or repositories. The agent worker pushes run branches through the agent account, not through the adapter ([Security](../engineering/security.md) §4).
- External Git/Docker/CLI operations cannot be rolled back by a DB transaction: expose explicit states, timeouts, error handling and reconciliation.
- `agents` owns separate `AgentDefinition` and `SkillDefinition` models; `mcp` owns reusable server definitions/bindings.

## 8. Test requirements

- Unit: domain behavior (entity and value-object rules, transitions) needs no database, container or fake of a port; handler behavior and error cases use controlled fakes of the ports.
- Integration: repositories, API validation/auth, PostgreSQL transaction behavior, outbox/inbox, Redis/BullMQ where used (Testcontainers when appropriate).
- HTTP integration tests that build the whole app (`AppModule`, real database client) live in `apps/api/src/__tests__/`, outside `src/modules/`: building the app reaches the database client, which `architecture:api` forbids for anything under `application/`, tests included. Unit tests of a feature stay beside its handler in `application/features/<feature>/` with fakes of the ports.
- Contract: REST DTO/schema compatibility and event versions.
- Architecture: full dependency graph and structural rules in **`architecture:api`**.
- Security/reliability: authorization failures, duplicate events, retry, cancellation, filesystem/working-copy isolation, privileged-action rejection.

Preferred runner: **Vitest**; supporting tools: `@nestjs/testing`, Supertest, Testcontainers. No global coverage percentage target at bootstrap; prioritize meaningful business cases. Architecture tests block merge once CI is implemented.

See [Quality](../engineering/quality.md) and [Security](../engineering/security.md).

## 9. Avoid overengineering

No mandatory generic `BaseRepository`, mediator/message bus for every feature, separate event-sourced models, mandatory extra layers, one module per table, domain events by default, or six microservices. Introduce abstractions where there is a tested reason.

## 10. Code conventions

**Same role, same form** (rule 9). State with rules or with dependencies gets a class; everything else is a function or plain data. A file holds one concept (rule 13).

| Role | Form |
| --- | --- |
| Aggregate root; child entity; value object that owns rules; policy | Class (a root at minimum produces its snapshot) |
| Handler; endpoint, job processor, scheduler, start-up routine, consumer | Class with injected dependencies |
| Adapter, repository implementation | Class implementing an interface |
| Port, repository contract | Interface |
| Error | Class extending `Error` |
| Record with no behaviour; data crossing a boundary | Plain type |
| Pure helper | Function (not in `domain/`: rule 13 allows only type guards there; the rule goes on the object it is about) |

Naming follows §4 (repository and port contracts: `<Aggregate>Repository`, `<Name>Reader`) and §6 (events: `<EventName>V<n>`).


Decision provenance: [backend architecture hub](https://app.notion.com/p/3fad4d814eb0817a9ba8c264625b4faa), especially decisions 14–15.
