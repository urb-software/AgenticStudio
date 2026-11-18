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
    entities/              aggregate roots and their child entities: classes; beside each entity its type-only companions <aggregate>-snapshot.ts, -data.ts, -facts.ts and <aggregate>-<operation>-facts.ts
    errors/                the aggregate's error classes, one <aggregate>-errors.ts per aggregate
    value-objects/         classes that validate on creation; policies; rules. A value object's own validation error stays beside it
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

**Reference module.** `tests/architecture/fixtures/api/reference-module/` (the module `catalog`) is the complete approved layout in a few small files: an aggregate root with its snapshot, errors file and value object, a repository interface and its in-memory implementation, two features with their handlers (input and result types, no entity class returned) and a test with fakes, HTTP endpoints with a schema and a shared response shape, a port with its adapter, `contracts/`, and the module file. Every `architecture:api` check passes on it and its pinned records match it. Copy it when you add a module; the gate applies to any `src/modules/<module>/` without being edited ([Quality](../engineering/quality.md) §4).

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
9. **Same role, same form** (API): state with rules or with dependencies gets a class; everything else is a function or plain data. The table is in §10. A record that has a rule (a limit, a format, a cut, a redaction) is not plain data: it becomes a value object class with a non-public constructor, and its limits are `static readonly` members of that class. A class is built through static factories that return the class: `of`, `create` or `from…` validate, `restore` rebuilds a value from storage without validating again. A factory enforces what was enforced before, at the same moment and with the same result. A factory's name says what it does: `of`, `create`, `from…` or `restore`, or a descriptive name such as `load` (redact, cut and keep what a Git host answered) or `afterWaiting`. The second form of factory is an instance method of an aggregate root that creates a child (a Run adding a Run step). There is no standalone factory class or function: it would be a stateless domain object, and a creation that outgrows its class signals a missing concept, which is named and given the rule. A list of allowed values is a union type derived from a list of literals, not a class. A public static method of an entity or value object is a factory and declares its own class as its return type; a private static may only prepare data for a factory. Every other rule is an instance method of the object it is about, and a policy is an instance built with its configuration (limits, lease, the time). A class has at least one instance member, so a class that is only a namespace is not allowed. No `factories/` directory exists, and no class only builds other classes.
10. **Handlers own their input and result.** Every handler declares its own input type and result type. A result is built from the entity's readable fields and contains ids, values and view types the application layer owns, and only what the callers of that handler use. An input holds plain data only: primitives, lists of allowed values and nested shapes the input declares, with no class from `domain/`, no worker protocol type and no snapshot; the handler builds the value objects and entities it needs from it, so domain rules run in the application layer and not in an entry point. An entity class never leaves the application layer, and a handler never builds an HTTP shape. A snapshot is the shape between an entity and its repository: only the entity, the repository interface and the repository's implementation use it, and `application/`, `entry-points/` and `contracts/` never import one. A view shown whole by more than one feature is a named collaborator of `application/` (rule 3, last resort): a type and a pure mapping from the entity, with no rule and no repository or port call. What each kind of handler returns is in the table below.
11. **One aggregate root, one file, one repository.** Anything with its own repository is an aggregate root and lives in `domain/entities/`. A repository interface serves exactly one root.
12. **Aggregates refer to each other by id.** A root never holds or loads another root. A rule that needs facts from another aggregate receives them as values (consistent with rule 6).
13. **One concept per file.** An entity file holds the entity class and nothing else. Each value object, an aggregate's errors and its fact types have their own files. `domain/` exports no loose functions other than type guards; an unexported top-level function is allowed only as a technical helper of at most ten lines that names no domain type, and a rule never lives there. The domain imports no runtime module (`fs`, `dns`, `timers` and the like) and, from `crypto`, only `createHash` (deterministic, no I/O): time, randomness and files come in as values, and generating a key or reading a file is an adapter's work. There is no line limit; size is reported, not enforced.

Rules 10 to 13 apply to the API only, as rules 1 to 9 do.

### Rule 14: comments

**Comments explain why, briefly, and only when the code cannot.** Unlike rules 1 to 13, this rule is repository-wide: it covers every package and tests, not the API only. The full text, the planned enforcement and an example are in [Quality](../engineering/quality.md) §5 (rule 14) and in [AGENTS.md](../../AGENTS.md) §2a.

### What a handler returns (rule 10)

| Handler | Returns |
| --- | --- |
| A command the caller needs the result of | The ids and values the caller needs, never the whole aggregate |
| A command with nothing to show | Nothing, or only the id of what it created |
| A query for one aggregate | A view type: the shared read model of the aggregate when several features show it whole (the Run, the Project, the Repository connection, the Environment file), otherwise one owned by the feature, built from the entity's readable fields |
| A query that combines or computes | A view type owned by the feature that produces it (a read shape is not a domain concept) |

The entry point (endpoint, job processor, scheduler, start-up routine or consumer) maps from the result to its own shape; the handler never does.

**The Run commands** answer with what the caller cannot know otherwise, and the caller reads the Run from `GET /api/runs/:runId`. Start a Run answers 201 with `{ id }`. Cancel answers 202 with `{ outcome }`: `cancelled` when the Run was cancelled at once, `cancel_requested` when the agent worker still has to confirm. Answer, resume, retry delivery, follow-up and bring up to date answer 202 with no body. Their errors are 404, 409, 422 and 429.

### Aggregate root, child entity or value object

The deciding question: **is there a rule that must hold at every moment across both objects?** If yes, they are one aggregate, and one of them is its root. If no, they are separate roots, and each refers to the other by id (rule 12).

Practical tests for a candidate root:

- It has its own id that other objects use to refer to it.
- It has its own repository.
- It is changed in its own transaction.
- Other aggregates refer to it.

A **child entity** has an identity only within its root and is created, changed and bounded through that root. A **value object** has no identity: it is defined by its values, is immutable (a change returns a new value) and validates on creation; where it owns no rule beyond its shape it may be a plain type (§10).

**An aggregate root is always a class in `domain/entities/`**; at minimum it produces its snapshot. A record with no behaviour that is not a root lives in `domain/value-objects/`. The snapshot, stored data shape and fact types of an aggregate are type-only files beside its entity (see "Direction of references" below), and its errors are in `domain/errors/`.

**When unsure, make them separate roots.** Joining two things into one aggregate needs a stated rule that spans them; keeping them apart needs none.

### Direction of references inside `domain/`

References point one way ([ADR 0003](adr/0003-api-module-layout.md) amendment): an entity may use value objects, errors and its companions; a value object may use smaller value objects; an error may use value objects; nothing under `value-objects/` or `errors/` imports from `entities/`, and `domain/` has no import cycle. A rule or policy that needs facts about an entity takes an input type it declares itself (the retention policy takes `RetentionFacts`, the sweep rules `RunSweepFacts`); the entity and the handlers map into it. A number shown in an error message is passed to the error by whoever raises it. A value object's own validation error (for example `InvalidProjectNameError`) stays beside it in `value-objects/`.

The type-only companions of an entity are recognised by file suffix: `<aggregate>-snapshot.ts`, `<aggregate>-data.ts` (the stored shape), `<aggregate>-facts.ts` and, when the facts are split by the operation they serve, `<aggregate>-<operation>-facts.ts` (for example `run-resume-facts.ts`). A companion exports types and interfaces only; every other file in `domain/entities/` is an entity file with the existing checks.

### Current aggregates

This is the model the code follows (the tickets of Epic #160: #182 and #185 for `projects`, #183 and #184 for `executions`). The roots are pinned in `tests/architecture/api/pinned/aggregate-roots.json`, so adding or removing one is a reviewed decision. The snapshot, stored record and fact types of an aggregate sit beside its entity as type-only companion files, and its errors in `domain/errors/`; `domain/value-objects/` holds value objects, policies and rules only.

| Module | Aggregate roots | Child entities | Value objects and plain records |
| --- | --- | --- | --- |
| `projects` | Project; Repository connection; Environment file | none | Of the Repository connection (#185), classes: lifecycle (its states and allowed transitions), failure, URL, remote address, host key, trusted host keys, Deploy key, Deploy key sweep policy, integration branch; the Project's name and id. Plain type: state list. Beside the entity: snapshots, stored data and facts (connect attempt, changes). Errors are in `domain/errors/` |
| `executions` | Run; Run lookup (requested, claimed, completed, failed); Prepared Follow-up; Review comments of a Run; Run diff | Run step, bounded by the Run's step limit | Of the Run (#184), classes: lifecycle (its state with the allowed transitions, and how it ended), delivery, pull request status, conversation, worker claim, progress (with its limits). Plain types: cancellation, failure, working copy, commit, limits and the reported failing checks. The Run keeps its identity and one field per concept; its snapshot stays flat, as storage holds it |

The Run log's events are append-only records and not an aggregate: no rule changes or spans them, and nothing refers to one event on its own.

## 4. Feature boundaries and CQRS semantics

- Commands **change state**; queries **read state**. Keep the semantic distinction, but **no** mandatory command/query bus or `command.ts`/`query.ts` files.
- Default: one folder per use case in `application/features/`, one `handler.ts`. A command and a query with different behavior are separate features.
- Commands may persist aggregates and schedule external work through ports. Queries must not change business state.
- Queries may use a read repository port and return read DTOs directly, without reconstructing rich aggregates. The read model stays in the **same PostgreSQL** initially; no event sourcing or separate CQRS database.
- Interfaces: aggregate repositories in `domain/repositories/`; read repositories and non-domain abstractions in `application/ports/`. Implementations: `infrastructure/repositories/` or `infrastructure/adapters/`.
- **A store serves one root and touches its table only** (rule 11). An operation that needs two roots asks each store; a Project's existence, or the name of the Project that holds a remote, is a read of `ProjectRepository`, not a join in the Repository connection's store. Only an operation that must change two roots in one transaction goes through a module-owned transaction port in `application/ports/`, whose adapter runs a callback with transaction-bound stores; the callback is orchestration only, the rules stay on the entities, and the lock order is fixed and documented there (the parent before the child, for example the Project before its Repository connection). No operation in `projects` needs such a port: the Project never changes after it is created.
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
- **Operator operations on a Run (Issue #167).** A Run changes at the same time by the operator and by the agent worker. What the operator triggers (answer, Follow-up, cancel, delivery retry, resume after the usage limit) is a method of the `Run` class: it checks its preconditions against the Run's own state and the facts passed in, refuses with a domain error, and records what changed. The handler calls `RunRepository.change` (or `changeSerializedWithClaims` for a resume, or the module's `RunTransactions` for a Follow-up, see below), which in one transaction loads the Run `FOR UPDATE`, calls the handler's pure callback, and saves the recorded changes. The row lock serializes the change with every other change of the Run: what the agent worker reports for the Run is a method of `Run` run through the same `change` (Issue #169), and the set-wide sweeps and the hand-out are single statements that wait for the lock and then re-check the row, so two simultaneous requests cannot both win. No version column and no retry loop are needed.
- **Worker-triggered operations on a Run (Issue #169).** What the agent worker reports for one Run (a state, including a delivery retry's outcome and a bring-up-to-date request that changed nothing; a Run step with its Question, step limit and usage; a heartbeat; the removal of a Working copy; the Environment file of a claim) is also a method of `Run`, which checks that the reporting worker holds the Run (a late report from a worker that lost its claim is refused with `RunNotHeldError`). The handler uses the same locked `change`. Two kinds of operation stay in the repository, each paired with a named rule in the domain that supplies its selection and its result, and a test that runs the store's statement over fixture rows and compares it with the rule: the hand-out of the next Run (`claimNext`, one atomic statement under the claim lock that locks the row it selects, waits for another transaction that holds it and re-checks it, so the queue order is strict and a cancelled Run is never claimed; `HandOutRule`) and the sweeps over many Runs (lost workers, `LostWorkerRule`; overdue steps, `OverdueStepRule`; Runs waiting too long, `LongWaitRule`; gone workers, `GoneWorkerRule`; the once-per-lease renewal, `LeaseRenewalRule`). The handlers build these rule objects and pass what they supply to the store.
- **Operations across aggregates (Issue #183).** No repository reads or writes another root's table, and no root holds or loads another (rules 11 and 12). The few operations that must change a Run and another root in one transaction go through the module-owned port `RunTransactions` (`application/ports/`): its adapter opens one transaction, locks the Run's row first, and hands the callback transaction-bound repositories; the callback only orchestrates (it loads, calls entity methods with facts passed as values, saves), and every rule stays on an entity. **Lock order, everywhere: the Run, then the lookup, then the other roots** (Review comments, prepared Follow-up, Run diff), so two operations on one Run run one after the other and cannot deadlock. The operations: the Follow-up (the Run's `followUp` takes what the selection of Review comments came to as values and returns what it used up; the set or the prepared Follow-up is removed in the same transaction); requesting a lookup (the lookup and the Run's pull request marks; the collaborator `RunLookupRequests`); answering a lookup (the lookup's own `complete` or `fail` decides, then the Run's pull request status, the prepared Follow-up or the Review comments are changed); reporting diffs (the Run's `assertDiffReportableBy`, then the Run diff). Handing out lookups stays one atomic statement of `RunLookupRepository.claim`, which joins the Run read-only for what the worker needs, paired with the named rule `LookupHandOutRule` and a test that runs the statement over fixture rows and compares it with the rule. The Run step is a child entity: only the Run creates one (`Run.reportStep` checks the number and the limit from its own `stepCount`), steps are stored in their own table and counted with every Run that is loaded, and listing them is a query. The Run log's events are append-only records, stored through the `RunLog` port (not an aggregate repository).
- **Run hand-out, reports, streaming and snapshots in `executions`.**
  - *Hand-out.* A Run with an agent session or a delivery retry goes only to the worker that last claimed it, because that worker alone has its Working copy. A Run holds a place while it is active, while a worker holds a `failed` Run for a retry, and while an answered Run waits in the queue; at most two places across the server and one per Project, and a Run's own place does not count against it. A lookup claimed for at least the lease goes back to `requested`; lookups whose rate-limit wait has not ended are skipped; a lookup is handed out only when its Run has a pull request and a known Run branch (oldest first, ties by id).
  - *Reports.* A `cancelled` report without a cancel request is refused. A step that ends `waiting_for_operator` after a cancel request ends the Run as `cancelled`. A `succeeded` report keeps its delivery. A bring-up-to-date Follow-up that changed nothing returns the Run to its earlier result. A rate-limited lookup returns to the queue; a failed lookup keeps the last known state and records the redacted reason; a repeated answer changes nothing.
  - *Review comments.* With `since_last_result` a comment is new when created after the end of the Run's latest part; a Run that has not finished counts every unresolved comment. They load only for a Run that can take a Follow-up now.
  - *Environment file snapshot.* The snapshot is deleted once the Run is final, except while a failed delivery can be retried or a Run can resume after the usage limit; otherwise on give-up or after retention. A resume goes only to the worker that holds the Working copy; a Follow-up takes the current snapshot, replacing the earlier one. Log redaction: lines that are not `KEY=VALUE` are redacted whole from 8 characters, known values under 4 characters are left out, and the values of commented-out pairs are redacted too.
  - *Streaming.* The run event stream opens with a `: connected` comment and sends `: keep-alive` every 15 seconds; a final Run ends with an `end` event, so a stream that closes without it was dropped. At most 5 streams per session and 50 in total (429 beyond); the session check is timed because a busy stream never idles.
  - *Request bodies.* Endpoints that type the body as `unknown` skip the global validation pipe; the endpoint's schema turns an invalid body into a 422, not a 400.
  - *Limits and retention.* The defaults of the Run limits (`STUDIO_RUN_STEP_MINUTES`, `STUDIO_RUN_MAX_STEPS` per part, `STUDIO_RUN_WAITING_DAYS`, `STUDIO_RUN_MAX_TOTAL_STEPS`, `STUDIO_WORKER_LEASE_SECONDS`, `STUDIO_RUN_SNAPSHOT_RETENTION_DAYS`) are in `.env.example`; Working copy retention is in the [deployment guide](../engineering/deployment.md#working-copy-retention-and-disk).
  - *Lease renewal.* At API start the held Run leases are renewed, so a short outage does not fail Runs with `worker_lost`; a gone worker is noticed one lease later. Renewal happens at most once per lease period, so an API that keeps restarting cannot keep a dead worker's Run alive. The sweeps run every half lease, at most every 30 seconds.
- The worker and its agents have **no access to the system Docker daemon or socket**, privileged Compose access, production DB credentials, Studio's files or unrestricted filesystem access. Agents may use the agent user's rootless Docker daemon ([Security](../engineering/security.md) §2).
- Docker Compose actions go through `apps/environment-controller`, behind authorization and approved operations.
- Git belongs to `projects`; other modules consume its public interfaces, not its adapter or repositories. The agent worker pushes run branches through the agent account, not through the adapter ([Security](../engineering/security.md) §4).
- External Git/Docker/CLI operations cannot be rolled back by a DB transaction: expose explicit states, timeouts, error handling and reconciliation.
- `agents` owns separate `AgentDefinition` and `SkillDefinition` models; `mcp` owns reusable server definitions/bindings.

### The `projects` module: behaviour of the Repository connection

Rules live on the `RepositoryConnection` entity and `RepositoryLifecycle` (which transitions are allowed lives there only); handlers order the steps. Every state-changing write of a background job is conditional on the Repository still being in the state the job started from, so a late write changes nothing.

- **Lifecycle.** A Repository starts in `awaiting_key` (SSH) or `connecting` (HTTPS); `awaiting_host_key` is reached through Verify, and a verified SSH Repository goes to `connecting`; `connecting` ends `ready` or `failed` (a clone result); `ready`, or `failed` with a Clone, goes to `fetching` and back to `ready` or `failed` (a fetch result); `failed` takes a new attempt (a Retry); any state goes to `disconnecting`, which forgets its key material and is then removed. The state is the last operation, not whether a Clone exists (`hasClone`).
- **Connect.** Order: input (field errors on every platform), platform, the store's transition (the real duplicate guard: unique indexes on the Project and on the remote's identity decide simultaneous connects), then the job. Over HTTPS the Repository is `connecting` and the clone is scheduled; over SSH it is `awaiting_key` with the Project's Deploy key and nothing is scheduled. A Retry of a failed Repository replaces it and keeps its Deploy key (and pinned host key while the host stays the same); otherwise a new key is generated and an unused key deleted. If the job cannot be scheduled after the transition, the attempt is failed again (keeping the failure a same-settings Retry replaced, else "could not be started") and the error is rethrown, so nothing stays `connecting`. A Deploy-key delete failure is logged (redacted), not thrown, and triggers an immediate sweep; the key is deleted once past the grace period. The Project must exist before a key is created.
- **Verify (SSH).** A trusted host (`STUDIO_SSH_KNOWN_HOSTS` or pinned) is cloned at once. Another host: Studio retrieves its host key in the request (time-limited); any `GitOperationError` of that scan fails the Repository, otherwise it waits in `awaiting_host_key`. With `acceptHostKeyFingerprint` the value must equal the pending key's fingerprint exactly. Starting the clone is a separate step: the Repository becomes `connecting` (pinning a confirmed key) in one conditional write, then the clone is scheduled; if that fails the Repository is `failed` again, as in Connect. With no trusted key a job fails with `host_key_mismatch` before Git runs (host-key rules: [Security](../engineering/security.md) §4).
- **Clone and Fetch jobs.** A clone job removes any leftover Clone, inspects the remote (so `branch_not_found` names the remote's default branch), clones, then marks `ready` or `failed`. A fetch fetches the Integration branch into the existing Clone, then marks `ready` with the new commit and time. A failed fetch keeps the Clone and its previous commit, except `size_limit`: the adapter removes the Clone, and only a Retry repairs it (`hasClone` is false). If a Fetch job cannot be scheduled the previous state is restored. `reconcile` at start-up fails every Repository still `connecting` or `fetching` as `interrupted`; a killed fetch leaves the Clone usable. An SSH job reads the Deploy key from the secret store for this job only. A non-Git error is unexpected: the queue stores `unknown`.
- **Disconnect.** The only destructive action. Order: project id and platform, the Repository becomes `disconnecting` from any state (the guard that keeps a running job from writing `ready` or `failed`; the Project's existence is checked only when no row is found), the job is cancelled and waited for (its id is free and no late write can touch a new Repository), then the cleanup steps in order: the Clone (only through the Git adapter's `removeClone(projectId)`, which derives the path from the project id and checks it is inside the data directory), the Deploy key (secret first, then reference, public key, host key), and the record last. A failing step is logged (redacted) and leaves the Repository `disconnecting`; a repeated Disconnect and start-up (`resumeAll`) retry. Disconnect is never refused as busy. Zero rows deleted means a concurrent cleanup finished first.
- **Start-up recovery** (`RepositoryStartupRecovery`, when the repository queue is reconciled: after the Git adapter's sweep, before the worker starts): interrupted Repositories fail, `disconnecting` ones resume, then orphaned Deploy keys and Environment file contents are swept.
- **Sweeps.** A secret is orphaned when the process stops between storing it and saving its reference, or a delete fails. Candidates are secrets under the owner label older than the grace period (by the secret store's clock; both grace periods default to one hour); a secret any record references is never deleted. A kept Deploy key is saved by a Retry only while its Repository still references it (`keepsDeployKey`), so a key found unreferenced is never saved again. Deletes are logged by secret id only; a sweep never throws.
- **Environment file.** Content goes to the secret store; the Project keeps the reference (path, size, time) and the replaced content is deleted; removing the file deletes its content from the secret store, and Runs claimed earlier keep their own snapshot. When the Clone is ready, a path tracked at the Integration branch's current commit is refused (the worker re-checks against the Run's start commit). A Run reads the content again if it was replaced between row and secret (twice at most). Only a `ready` Repository is a Run start point.
- **Git adapter.** Operations on one project are serialized by an in-process lock (one API process). Any failure beyond the port's typed errors and `AbortError` becomes `GitOperationError('unknown')`; the raw error goes, redacted, to the server log. If the API process dies, the detached Git process group is orphaned until Git ends; start-up removes stale per-operation directories (with any SSH key) and partial Clones. Remote address checks and pinning: [Security](../engineering/security.md) §4. `scanHostKey` runs `ssh-keyscan` in the same isolated environment within the caller's timeout (verify: 30 s), preferring ed25519, then ECDSA, then RSA.
- **Test seam.** `ProjectsModuleOptions.platform` is settable only from code (`main.ts` passes none); HTTP suites use it to prove the 501 path on a Linux runner. It can only make the Linux-only guard refuse more. A provider override would need a second way to build the app for those suites alone, so the option stays.
- **Persistence.** `head_sha` is set exactly while a usable Clone exists. Only a `disconnecting` Repository is deleted. The `connect` step is one atomic database step; `change` locks the row (`FOR UPDATE`), its callback does no I/O, and a domain refusal rolls back, so a late job write waits for a Disconnect and then finds the state it left. A Project never changes after creation, so no operation needs a transaction across the Project and Repository stores.
- **Value objects.** `RepositoryUrl` identity is the lower-cased host plus path without scheme, user, default port, trailing `/` or `.git`, so https, ssh and scp-like forms of one repository are one remote; a non-default port stays and the path keeps its case. `ProjectName` is NFC-normalized and its length counted in code points, matching PostgreSQL `char_length`.

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

**Same role, same form** (rule 9). State with rules or with dependencies gets a class; everything else is a function or plain data. A file holds one concept (rule 13): a file under `domain/value-objects/` holds one class or one record, plus the lists of allowed values, union types, type guards and typed-id brands that describe it; a class may keep its own input, stored and options types (named after the class) and its own validation error beside it.

| Role | Form |
| --- | --- |
| Aggregate root; child entity; value object that owns rules; policy | Class (a root at minimum produces its snapshot) |
| Handler; endpoint, job processor, scheduler, start-up routine, consumer | Class with injected dependencies |
| Adapter, repository implementation | Class implementing an interface |
| Port, repository contract | Interface |
| Error | Class extending `Error` |
| Record with a rule (limit, format, cut, redaction) | Value object class: private constructor, `static readonly` limits, factories (`of`, `create`, `from…`, or a descriptive name) that validate and `restore` that does not; an aggregate root creates its children through an instance method |
| Policy or rule (hand-out, sweep, retention, lease) | Class built by a factory from its configuration; its checks are instance methods, not statics |
| List of allowed values | Union type derived from a list of literals |
| Record with no behaviour; data crossing a boundary | Plain type |
| Pure helper | Function (not in `domain/`: rule 13 allows only type guards there, plus an unexported technical helper of at most ten lines with no domain type; the rule goes on the object it is about) |

Naming follows §4 (repository and port contracts: `<Aggregate>Repository`, `<Name>Reader`) and §6 (events: `<EventName>V<n>`).


Decision provenance: [backend architecture hub](https://app.notion.com/p/3fad4d814eb0817a9ba8c264625b4faa), especially decisions 14–15.
