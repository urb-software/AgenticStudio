# Quality, Testing & Architecture Guardrails

**Status:** approved target policy. The commands, scripts, jobs and test suites below must still be **implemented** during the SDLC bootstrap; no claim of passing checks is valid until they run.

## 1. Quality principle

**Markdown explains → agents execute deterministic checks locally → CI independently reruns required checks → independent review evaluates semantics → controlled merge.** Security-critical actions require actual runtime permissions, not prompts.

A clean unit-test result proves neither architectural correctness nor safe behavior.

## 2. Validation layers and ownership

| Layer | Purpose | Mechanism |
| --- | --- | --- |
| Documentation | Defines standards and DoR/DoD | `AGENTS.md`, `CLAUDE.md`, `docs/engineering/*` |
| Local agent checks | Fast feedback before handoff | Workspace scripts, static architecture checks, tests |
| Pull Request CI | Independent repeatable validation | Separate BE/FE/monorepo architecture jobs, quality, tests, contracts, security |
| Code review | Semantics, adequacy, scope, maintainability | Independent reviewer and operator approval |
| Runtime | Prevent prohibited operations | Access controls, sandbox boundaries, Git policies, secret isolation |

`AGENTS.md`/`CLAUDE.md` do **not** enforce security or architecture by themselves. See [Security](security.md).

## 3. Determinism and test doubles

- **Deterministic static checks:** Prettier check, ESLint, TypeScript typecheck, dependency-graph rules, structural assertions, schema validation, reproducible build (given fixed inputs and pinned dependencies).
- **Controlled tests:** unit/integration/E2E are reproducible with isolated DBs/containers, fixed fixtures and controlled clocks, but not intrinsically deterministic.
- **Nondeterministic integrations:** real LLM/CLI responses, external services and human code review are never assumed stable. Regular CI uses **Fake Runner** implementations; real CLI smoke tests run in a separate controlled stage.
- A flaky test is tracked and its cause fixed; never silently retried until green.

## 4. Mandatory architecture test categories

**Separate required gates**, not rules buried inside lint.

### `architecture:api` — NestJS

The module layout and the thirteen structure rules are canonical in [Backend](../architecture/backend.md) §2 and §3 ([ADR 0003](../architecture/adr/0003-api-module-layout.md)). Every check below exists and runs inside `architecture:api`, and each applies to every module under `src/modules/` by path pattern, with no module list, so a new module is covered without editing the gate; the reference module fixture (named in [Backend](../architecture/backend.md) §2) shows the complete approved layout and passes every check. The rules that name features, ports, entry points and contracts use the new paths (`application/features/`, `application/ports/`, `entry-points/`, `contracts/`).

**Dependency rules** (Dependency Cruiser or equivalent):

- No imports of another business module's private files; use explicit public contracts.
- `domain/` does not import NestJS, ORM, database, queue, infrastructure, HTTP or framework details.
- Feature handlers depend on interfaces/ports, not concrete adapters/repository implementations.
- Domain repository contracts live in `domain/repositories/`; read ports and other service interfaces in `ports/` (naming convention in [Backend](../architecture/backend.md) §4).
- No prohibited cycles between modules or layers.
- Event consumers use the owning module's public contract and do not bypass module boundaries.
- Composition-root DI wiring exceptions are narrowly scoped and explicitly tested, not broad allowlists.
- `application/` imports no HTTP, schema, OpenAPI, queue or scheduler API: no `nestjs-zod`, `@nestjs/swagger`, `class-validator`, `class-transformer`, `express`, `@nestjs/platform-express`, `bullmq`, `@nestjs/bullmq`, `@nestjs/schedule`, `node-cron`, `cron`, Node `http`/`https`/`http2`, and no controller, route or parameter decorator from `@nestjs/common` (`Controller`, `Get`, `Body`, `UseGuards`, …). Plain `zod` stays allowed for now. `application/` also imports nothing from `platform/queue/`: a job is started and cancelled through a port whose adapter lives in `infrastructure/`, and its events reach a handler through an entry point. The tests of `application/` (`__tests__/`) are not checked: they may import the queue's error classes to make a fake adapter fail the way the real one does.
- `entry-points/` imports nothing from `infrastructure/`, and from a repository interface or port file (at any depth under `domain/repositories/` and `application/ports/`) only domain error classes (imported names ending in `Error`), so an entry point reaches the application through handlers. A port token or repository interface that another file, a handler for example, re-exports is the same import in disguise and is refused too. The in-memory fakes under `ports/__tests__/` are not interfaces: production code importing one is refused by the test-import check below.
- No production file of a module imports a test file (a file in `__tests__/` or named `*.test.ts`); this keeps the `__tests__/` exemption of the feature check from reaching production code.
- No import from one feature folder into another feature folder of the same module, in every module. The shared import parser sees every route: `import`, `export … from`, side-effect imports (`import './x.js'`), `import x = require()`, dynamic `import()` and import types. The tests of a feature (`__tests__/`) are not checked: a round-trip test may build the handler that produces what the handler under test reads.
- `domain/` imports nothing from `application/ports/`, in every module (by path pattern).
- Domain tests import no database client or container tooling (the ORM, concrete clients, `testcontainers`, `@testcontainers/*`, `@agentic-studio/database` and `@agentic-studio/testing`), in every module.
- An application collaborator (a file directly in `application/`) never imports `application/features/`, by any route (its tests are not checked): shared logic that features call must not call a feature back.

**Structural rules** (Vitest assertions or equivalent):

- Nothing under `entry-points/` imports a class from `domain/entities/`; types are allowed. Since rule 13 an entity file exports no error, so an entry point takes a domain error from the root's errors file under `domain/errors/`, which the check does not cover (it looks at classes in entity files only): a fixture proves that an entry point may import an error class from such a file (rule 10).
- No public method of a handler returns an entity class (also behind a local type alias, a namespace import `ns.Entity` or an import type), every public method declares its return type, and every handler file exports its input type (when it takes input) and its result type (when it returns something) (rule 10).
- Each repository interface refers to exactly one file in `domain/entities/`, and no type under `domain/value-objects/`, and no companion file (`-data`, `-facts` or the snapshot of another root), is the main type a repository returns, except the snapshot of its own entity, `entities/<entity>-snapshot.ts`, or of its root's pinned child entity (the snapshot of another root, or any other value object, still fails). The read shapes of one repository contract (for example `RunStateView`, `StoredRunDiff`, `ClaimedLookup`) are declared in that repository's file (rule 11). A property typed as a function counts as a method, and a qualified name (`ns.Type`) is followed to its file. A root's child entities, pinned in the check (the Run step of the Run), belong to its aggregate and do not count as another entity file.
- No entity file imports another entity file except for an id type, or a root's own pinned child entity (rule 12).
- The four checks above apply to every module, including one with no `domain/entities/` directory: a repository interface there refers to no entity file and fails, since anything with its own repository is a root in `domain/entities/`. The fixtures use a module name the app does not have (`billing`).
- Nothing under `domain/value-objects/` or `domain/errors/` imports from `domain/entities/`, by any route (import, type-only import, `export … from`, dynamic import), in every module (Issue #203).
- No import cycle exists inside a module's `domain/`: static `import` and `export … from`, type-only imports included, tests excluded (Issue #203; `api-no-circular` also covers the whole `src/` tree).
- A type-only companion in `domain/entities/` (suffix `-snapshot.ts`, `-data.ts` or `-facts.ts`) exports types only: no class, function, value or `export *`; fixtures prove that a class and a function fail. Every other file of `domain/entities/` keeps the entity checks unchanged (Issue #203).
- A file under `domain/entities/` exports at most one class (error classes count, and so does `export const X = class {}`) and no functions; a file with no class is refused by the entity-class check above (rule 13).
- No file under `domain/` exports a function other than a type guard, tests excluded: an overloaded function counts once (and is a type guard when its overload signatures are), and an arrow function behind `as` or `satisfies` counts (rule 13).
- The aggregate roots of each module are pinned in `tests/architecture/api/pinned/aggregate-roots.json`, each with the one-line reason it is a root: adding or removing one fails `pinned.test.ts` until the record is changed in review (rule 11). A root's child entity (pinned in `aggregate-rules.ts`) is not a root.
- A present use-case feature has a `handler.ts`; `endpoint.ts`, `schema.ts`, `input.ts`, `__tests__/` are optional.
- Concrete read/write repository implementations belong in `infrastructure/repositories/`, adapters in `infrastructure/adapters/`.
- Public integration event definitions are versioned and publisher-owned: `contracts/events/<event-name>-v<n>.ts` exporting only `<EventName>V<n>` / `<EventName>V<n>Schema`, with no duplicate event definitions across modules (convention in [Backend](../architecture/backend.md) §6).
- `contracts/` holds only `index.ts` and `events/`.
- No directory named `shared`, `common`, `utils` or `helpers` inside a module; the one exemption is exactly `entry-points/http/shared/`.
- Every file in `domain/entities/` exports a class with a non-public constructor, in every module (an aggregate root is always such a class, declared or as `export const X = class {}`; records without behaviour that are not roots live in `domain/value-objects/`); the type-only companions recognised by their suffix are the exception (see above).
- No `domain/services/` directory, in every module (by path pattern).
- A file under `domain/value-objects/` exports a constant that is not a list of allowed values (an array or object of literals written `as const`) only if it also exports a class (Issue #215).
- A file under `domain/value-objects/` exports at most one class (error classes aside) or, with no class, at most one record; with a class, any record it exports is named after the class. Lists of allowed values, the union types derived from them, type guards and typed-id brands are not records (Issue #215).
- No directory named `factories` under a module's `domain/` or `application/` (tests are not checked), and no class under `domain/` whose public members are all methods returning a different class (Issue #215). The check for static methods that do not return an instance of their class is Issue #216.
- In `domain/`, tests not checked: a public static method of a class under `entities/` or `value-objects/` declares its own class as its return type (optionally with `| undefined` or `| null`), and a public static function property or accessor is refused; private statics may only prepare data for a factory. A top-level function is an exported type guard, or unexported, at most ten lines and naming no type declared in or imported from `domain/`. A class other than an `Error` subclass has at least one instance member. Nothing imports `node:crypto` or `crypto`, `fs`, `fs/promises`, `child_process`, `net`, `dns`, `dns/promises`, `http`, `https`, `tls`, `dgram`, `timers`, `timers/promises` or `worker_threads`, in the `node:` or the bare form. From `crypto` the domain may import only `createHash`, which is deterministic and does no I/O (the SHA-256 fingerprint of a public host key); `randomBytes`, `randomUUID`, `generateKeyPair*`, any other name, and a default or namespace import fail. No path is exempt.
- The methods of every repository interface are pinned in `tests/architecture/api/pinned/repository-methods.json`, each with its kind (`load`, `save`, `query`, `atomic` or `set-wide`): adding, renaming or removing a method fails `pinned.test.ts` until the record is changed in review, and each atomic or set-wide method carries a one-line reason it cannot be a load, a call on the domain object and a save. The failure message names the file and says what to do.
- The files directly in a module's `application/` folder are pinned in `tests/architecture/api/pinned/application-collaborators.json`, each with the step of rule 3 that was tried and why it did not apply: a new one fails until the record is changed in review. The Epic aimed for none; one remains (`executions/application/run-lookup-requests.ts`, with its reason in the record).
- The three pinned records state decisions and are never an allowlist: no entry makes a violation of a gate check pass. The pull request template's checkbox points to them.
- Do **not** require empty folders, mandatory `command.ts`/`query.ts`, or `domain/events/`.
- Static checks cannot prove where all business logic lives; thin consumer/endpoint rules need behavior tests and review.

**Structure report** (not a check): `pnpm run structure:report` (`scripts/structure-report.mjs`) prints, for the API, the largest source files, every file under a module's `domain/` over 400 lines (rule 13: size is reported, not enforced), the number of methods per repository interface, the number of public methods per handler, the number of collaborators per module, the number of files per feature, and the comment-to-code ratio per production file of the API, the agent worker and the shared packages (tests excluded) (files above 0.25 are flagged: the count and the top 30; rule 14). With `--base-ref <git ref>` it also shows the change against that ref (for the ratio, the change in the number of flagged files). CI runs it as a step of the `architecture:api` job and writes it to the pull request's job summary with the change against the base branch; the step never fails the build and adds no required check (§7, §8).

### `architecture:web` — Next.js

**Dependency rules:**

- Cross-module consumers use a public `index.ts` or another explicitly approved entrypoint.
- No imports of private stores, hooks, editor internals or services from another module.
- `shared/` does not import `modules/`; `platform/` does not import business modules. No cycles.
- `app/` composes feature APIs rather than reaching into private feature files.
- Frontend/client bundles do not import backend implementations, secrets, privileged controller code or Node-only server modules.

**Structural/behavioral rules:**

- Consistent feature-first layout; no mandatory empty `store.ts` or generic layered scaffolding.
- One owner per state: API cache, editor draft, form values, navigation and live buffer are not mirrored into competing mutable stores.
- Server/Client Component boundaries and critical UI interaction rules require build and behavior tests, not only import scans.

### `architecture:monorepo` — workspace

- Validate the cross-app/package dependency graph for `apps/api`, `apps/web`, `apps/agent-worker`, `apps/environment-controller`, and `packages/*`.
- No web imports of server or privileged implementations.
- Shared public contracts have a single canonical source; no duplicate event definitions.
- No prohibited package cycles, hidden app-to-app implementation imports, or shortcuts bypassing published interfaces.
- Rule 14 comment checks (§5): no Issue or pull request number in a comment, and no comment block longer than three lines without `@long-comment <reason>`.

**All three checks inspect the entire relevant dependency graph on code/config PRs**, even when affected unit tests run on a subset.

## 5. Guardrail rules must be tested

Positive and negative fixtures prove the rules catch violations:

| Fixture | Expected |
| --- | --- |
| Handler imports a port from its own module | PASS |
| Handler imports another module's private repository | FAIL |
| Domain imports ORM/NestJS | FAIL |
| Consumer imports publisher-owned public versioned event | PASS |
| Module publishes an unversioned integration event | FAIL |
| Two modules define the same integration event | FAIL |
| Integration event re-exported by another module or under another name | FAIL |
| Repository contract declared outside `domain/repositories/` | FAIL |
| `application/` imports an HTTP, schema, OpenAPI, queue or scheduler API | FAIL |
| `application/` imports only domain, ports and its own files | PASS |
| `entry-points/` imports a handler | PASS |
| `entry-points/` imports a repository interface, port or infrastructure file | FAIL |
| `contracts/` holds `index.ts` and `events/` only | PASS |
| `contracts/` holds another file | FAIL |
| `contracts/` holds another directory | FAIL |
| A module has `entry-points/http/shared/` (the one exemption) | PASS |
| A module has a `shared`, `common`, `utils` or `helpers` directory, e.g. `application/shared/` | FAIL |
| A subdirectory of `entry-points/http/shared/` is named `shared`, `common`, `utils` or `helpers` | FAIL |
| A feature imports another feature of its module | FAIL |
| A feature imports a port, the domain or its own files | PASS |
| A test of a feature imports another feature (tests are not checked) | PASS |
| A test of `application/` imports `platform/queue/` (tests are not checked) | PASS |
| A production file of a module imports a test file (`__tests__/` or `*.test.ts`) | FAIL |
| A test file imports a test helper | PASS |
| `domain/entities/` file exports a class with a non-public constructor | PASS |
| `domain/entities/` file exports a class with a public constructor, or no class | FAIL |
| `entry-points/` imports a type from `domain/entities/` | PASS |
| `entry-points/` imports a class from `domain/entities/` | FAIL |
| `entry-points/` imports an error class from an errors file in `domain/errors/` | PASS |
| A handler returns a snapshot, ids, values or a view type, and exports its input and result types | PASS |
| A handler returns an entity class, does not export its result type, or has a public method with no declared return type | FAIL |
| A repository interface refers to one entity file | PASS |
| A repository interface refers to two entity files, or its main type is under `domain/value-objects/` | FAIL |
| Nothing under `domain/value-objects/` or `domain/errors/` imports from `domain/entities/` | PASS |
| A file under `domain/value-objects/` or `domain/errors/` imports (or re-exports from) `domain/entities/` | FAIL |
| A module's `domain/` has no import cycle | PASS |
| A module's `domain/` has an import cycle, type-only imports and `export … from` included | FAIL |
| A type-only companion of an entity (`-snapshot`, `-data`, `-facts`) exports types only | PASS |
| A companion file exports a class, a function, a value or `export *` | FAIL |
| A repository interface returns the snapshot of its own entity, or of its root's pinned child entity | PASS |
| A repository interface returns another value object, or the snapshot of another root | FAIL |
| An entity file imports another entity file for an id type | PASS |
| An entity file imports another entity file for anything else | FAIL |
| A structure rule is broken in a module the app does not have (`billing`) | FAIL |
| An entry point imports a repository interface or port file by any route (nested, side-effect, dynamic, re-exported by a handler) | FAIL |
| An entry point imports an error class through a handler, or a test imports a fake from `ports/__tests__/` | PASS |
| A `domain/entities/` file exports exactly one class and no function | PASS |
| A `domain/entities/` file exports a second class or any function | FAIL |
| `domain/` exports only classes, types, constants and type guards | PASS |
| `domain/` exports a function other than a type guard | FAIL |
| The aggregate roots match the pinned record | PASS |
| An aggregate root is added or removed without updating its pinned record | FAIL |
| A module has no `domain/services/` directory | PASS |
| A module has a `domain/services/` directory | FAIL |
| A `domain/value-objects/` file exports one class or one record, with the lists and guards that describe it | PASS |
| A `domain/value-objects/` file exports a constant that is not a list of allowed values and no class | FAIL |
| A `domain/value-objects/` file exports two classes, two records, or a record not named after its class | FAIL |
| A module has no `factories` directory under `domain/` or `application/` (tests are not checked) | PASS |
| A module has a `factories` directory under `domain/` or `application/` | FAIL |
| A `domain/value-objects/` file exports a constant that is not a list beside a class | PASS |
| A `domain/` class only has methods returning another class | FAIL |
| A `domain/` class has state, or methods returning its own class | PASS |
| A public static method of an entity or value object returns its own class | PASS |
| A public static method of an entity or value object returns something else, or declares no return type | FAIL |
| A `domain/` top-level function is an exported type guard, or a short unexported helper without domain types | PASS |
| A `domain/` unexported function is over ten lines or names a domain type | FAIL |
| A `domain/` class has an instance member, or is an error class | PASS |
| A `domain/` class has no instance member | FAIL |
| `domain/` imports no runtime module (tests are not checked) | PASS |
| `domain/` imports `node:crypto`, `fs`, `dns`, `timers` or another runtime module | FAIL |
| `domain/` imports only `domain/` and plain libraries | PASS |
| `domain/` imports from `application/ports/` | FAIL |
| A domain test imports only the domain and test helpers | PASS |
| A domain test imports a database client or container tooling | FAIL |
| An application collaborator imports ports and the domain | PASS |
| An application collaborator imports `application/features/` | FAIL |
| Repository methods and application collaborators match the pinned lists | PASS |
| A repository method or application collaborator is added, renamed or removed without updating its pinned list | FAIL |
| The reference module fixture (the complete approved layout) | PASS |
| Web imports `@/modules/agents` public entrypoint | PASS |
| Web deep-imports another module's private Zustand store | FAIL |
| Two modules introduce a dependency cycle | FAIL |

A change to architecture tooling must run the fixtures; a configuration edit must **never** silently disable enforcement.

### How each API structure rule is enforced

One row per rule of [Backend](../architecture/backend.md) §3. A rule cannot be listed without the enforcement cell filled in: **gate check** (`architecture:api`), **pinned test** (a test that fails when a pinned list changes) or **review only** (the review checklist and the review skill's third brief, no tool).

| # | Rule | Enforcement |
| --- | --- | --- |
| 1 | Features are independent | Gate check: no import between feature folders, in every module |
| 2 | Entry points call handlers; handlers never call each other | Gate checks: `application/` imports no HTTP, schema, queue or scheduler API, and `entry-points/` imports no repository, port or infrastructure file; handlers never call each other, through the check of rule 1, and `application/` imports nothing from `platform/queue/`. Review only: that an entry point holds no business rule |
| 3 | Shared application logic is the exception | Gate check: no shared, common, utils or helpers directory, collaborators never import features; pinned test: the list of application collaborators; the six-step order is review only |
| 4 | Behaviour lives on the object it is about | Gate check: entity files export a class with a non-public constructor, in every module; where a rule sits is review only |
| 5 | There is no `domain/services/` | Gate check: no `domain/services/` directory |
| 6 | The domain receives facts and never fetches them | Gate check: `domain/` imports nothing from `application/ports/` and no database client in domain tests; pinned test: the list of repository methods; that no business rule is written in the database adapter is review only |
| 7 | Validation has two homes | Review only |
| 8 | `contracts/` is a module's public face | Gate check: `contracts/` holds only `index.ts` and `events/`, and the existing check that other modules import only `contracts/index.ts` |
| 9 | Same role, same form | Gate checks: a `domain/value-objects/` file exports a non-list constant only beside a class and exports one class or one record, no `factories/` directory exists under `domain/` or `application/` (tests are not checked), and no class under `domain/` has only methods returning another class; entity classes are also covered by the check of rule 4. That a record with a rule is a class, and that a static method that is not a factory is an instance method, is review only until Issue #216 adds its check |
| 10 | Handlers own their input and result | Gate checks: nothing under `entry-points/` imports an entity class, no handler returns an entity class, and every handler exports its input and result types; that a handler builds no HTTP shape is review only (rule 2 keeps HTTP APIs out of `application/`) |
| 11 | One aggregate root, one file, one repository | Gate check: a repository interface refers to exactly one entity file and no value object is its main type; pinned test: the aggregate roots of each module; that anything with its own repository is a root is review only |
| 12 | Aggregates refer to each other by id | Gate check: no entity file imports another entity file except for an id type; that no root loads another is review only |
| 13 | One concept per file | Gate checks: an entity file exports exactly one class and no function; `domain/` exports no function other than a type guard. Size is reported by the structure report (§4), not enforced; that each file is one named concept is review only |

Rules that are review only are covered by the specific backend items of the review report ([template](../templates/review-report.md) §2) and by the review skill's third brief, which checks only the thirteen rules against the diff. The architecture review skill (`studio-improve-codebase-architecture`) runs at the end of each Epic ([Agent roles](agent-roles.md) §6).

### Rule 14: comments

Rule 14 is not a structure rule: it is about readability and applies to the whole repository (API, agent worker, shared packages and tests). It is recorded beside rules 1 to 13 so there is one list ([Backend](../architecture/backend.md) §3). Existing code is brought in line by the clean-up tickets of Epic #160; the web app follows later.

**Comments explain why, briefly, and only when the code cannot.**

A comment is for:

- a constraint or invariant the code does not show;
- a security reason;
- a concurrency or atomicity guarantee;
- a workaround, with its cause;
- the contract of a port or repository method: what it guarantees, what an empty result means, what it throws.

A comment is never for:

- what the name and types already say;
- history: what changed, moved or was removed;
- an Issue or pull request number, written as `#<digits>` or as a link to either (`#` followed by digits only is a reference, so rewrite any other such use, such as "step #1");
- the definition of a glossary term;
- restating an architecture rule.

Form:

- At most three lines. Anything longer belongs in a document, with a one-line pointer.
- A class or file header is one sentence or absent.
- Tests rely on the test name and follow the same rule.
- Exception: a longer comment is allowed when it contains the tag `@long-comment <reason>`. The reason is required and must not be empty.

What counts as a comment block: one block comment (`/* */`, `/** */`), or a run of consecutive `//` line comments. Its length is its lines of text; lines that are only `/**`, `/*` or `*/`, and lines with no text (only `*` or empty), do not count. A trailing comment on a code line is not part of a run of `//` comments. These are not comments for this rule: tool directives (`eslint-disable...`, `@ts-expect-error` and `@ts-ignore` with their reason, `prettier-ignore`, triple-slash references), shebangs, and decorator or OpenAPI description text.

Before:

```ts
/**
 * Added in #123 to fix duplicate charges. Previously the balance was
 * read outside the transaction. Moved here from PaymentService.
 * A Wallet is the holder of a customer's balance (see glossary).
 * Debits the wallet by the given amount.
 */
async debit(walletId: WalletId, amount: Money): Promise<void> {
  // lock the row, then debit
  await this.repository.withLock(walletId, (wallet) => wallet.debit(amount));
}
```

After:

```ts
// The row lock makes read-check-write atomic: two concurrent debits must not both pass the balance check.
async debit(walletId: WalletId, amount: Money): Promise<void> {
  await this.repository.withLock(walletId, (wallet) => wallet.debit(amount));
}
```

Enforcement:

| Check | What it does | Where it runs |
| --- | --- | --- |
| Comment length | Fails a comment block longer than three lines without a `@long-comment <reason>` tag, and a tag with an empty reason | `pnpm architecture:monorepo` (CI `architecture:monorepo`, inside `ci:required`) |
| Issue or pull request reference | Fails a comment that contains `#<digits>` or a link to an Issue or pull request | the same run |
| Structure report figure | Reports the comment-to-code ratio per production file and flags files above 0.25; reported, not blocking | `pnpm structure:report` (§4) |

Both checks read comments with the TypeScript scanner (never a pattern over code), so a string or template literal that contains `//` or `#123` is not a comment. They are `tests/architecture/monorepo/comment-rules.test.ts` over `scripts/comment-rules.mjs`, with passing and failing fixtures in `tests/architecture/fixtures/comments/`, and they run locally with `pnpm architecture:monorepo`. They cover `apps/api/src`, `apps/agent-worker`, `packages/*` and `tests/architecture` (JavaScript and TypeScript files, hand-written declaration files included). Excluded: `apps/web`, until its own clean-up; generated code (any `generated/` directory, or a file with a generated-file header such as `@generated`); build output and `node_modules`; and the gate fixtures in `tests/architecture/fixtures/`, which violate on purpose. The `@long-comment` tag is a budgeted exception: a pull request that adds one lists it with its reason.

## 6. Test stack and placement

| Area | Target tools | What to verify |
| --- | --- | --- |
| Backend unit | Vitest + `@nestjs/testing` where useful | Handler rules, domain transitions, negative cases |
| Backend integration | Vitest + Supertest + Testcontainers | HTTP/auth/validation, PostgreSQL repositories and transactions, Redis/BullMQ where needed |
| Frontend component/feature | Vitest + React Testing Library | Forms, loading/errors, hooks, accessibility-sensitive interactions |
| API/event contracts | Zod + OpenAPI typed contracts | Payload validity, version compatibility, contract generation |
| Full user flow | Playwright | Key Next.js → API → DB workflows, smoke tests |
| Security/reliability | Negative tests + scanners | Forbidden paths, unauthorized actions, secrets, duplicate messages, cancellation/timeouts |
| CLI adapter | Fake Runners in regular CI; separate real CLI smoke | Process invocation, exit codes, redaction, failure/retry, true integration compatibility |

Platform: repository features (Git adapter, Clones) are **Linux only**; their tests skip on other platforms with a clear reason and must run, not skip, in Linux CI.

Placement: feature tests **near the feature** in `__tests__/` where practical; system-level E2E/security/contract suites at repo-level `tests/`; fixtures and fakes shared by multiple apps in `packages/testing/`.

Coverage: no rigid overall percentage at the beginning. Measure it, prioritize critical behavior and failure cases, and set numerical thresholds only after the first slices, if they help.

## 7. PR CI contract

**Target jobs (names are a proposed stable interface):**

```text
quality:api           # Format + ESLint + typecheck + build
architecture:api      # Dependency graph + structural rules
 test:api             # Unit + integration
quality:web           # Format + ESLint + typecheck + build
architecture:web      # Dependency graph + structural rules
 test:web             # Unit + component/accessibility checks
architecture:monorepo # Cross-app and package boundaries
 test:contracts       # REST and Integration Events
 e2e:smoke            # Critical affected user journeys
quality:agent-worker  # Format + ESLint + typecheck + build of apps/agent-worker
 test:agent-worker    # Unit + worker loop against the real API (Linux)
deploy:server         # Server setup script and isolation boundary checks (Linux, #107)
security              # Secrets, dependency audit, SAST and critical checks
ci:required           # Final policy aggregation
```

- Architecture checks are **blocking** even when all unit tests pass.
- Tests, relevant builds and scanners block according to change scope and the agreed severity policy. Security-critical findings are not waived casually.
- Keep the required PR check name stable. Skip configurations must not leave required checks indefinitely pending or mark incomplete work green.
- `affected` selection may skip irrelevant tests only after computing dependency impact. Full architecture graphs are always checked for applicable application changes.
- The repository is **public**, so GitHub rulesets enforce required status checks on the Free plan. Once B5 exists, `ci:required` is a required check on `dev`; until then, do not claim the platform enforces CI. Merge remains a **manual operator decision** on top of enforced checks (see [Security](security.md) §4).
- Doc-only PRs limit code checks only via an explicitly tested policy; never auto-skip when architecture tooling or core configuration changes.
- **CODEOWNERS is deferred** (operator decision on #28, 2026-11-13) until the reviewer machine user exists: with one GitHub account, required code-owner review would block every CI change, and an unenforced CODEOWNERS adds no control. A PR runs its own workflow and policy, so until then any change to `.github/**` or `scripts/ci/**` needs an independent review and operator authorization to merge.

## 8. Local agent checks (target command interface)

```bash
pnpm check:api
pnpm test:api
pnpm check:web
pnpm test:web
pnpm check:agent-worker
pnpm test:agent-worker
pnpm architecture:api
pnpm architecture:web
pnpm architecture:monorepo
pnpm contracts:check     # CI job test:contracts
pnpm structure:report    # the API structure report (a step of CI architecture:api, never a check)
pnpm check:affected
```

Current state (root `package.json`, `.github/workflows/ci.yml`): `check:api` and `check:web` exist and run in the CI jobs `quality:api` and `quality:web`; `test:api`, `test:web` and the three `architecture:*` scripts exist and run as the CI jobs of the same names. Contract checks run as `pnpm contracts:check` (CI job `test:contracts`); there is no `pnpm test:contracts` script. `pnpm structure:report` prints the structure report (§4; in CI a step of `architecture:api` that writes it to the job summary, with the change against the base branch, and always exits 0; locally add `--base-ref <git ref>` for the change against a ref). `pnpm format:check` (whole repository, in CI `quality:web`), `pnpm design:test` (design-system viewer server tests, in CI `quality:web`) and `pnpm e2e:smoke` (CI `e2e:smoke`) also exist, and CI `security` runs the pnpm built-in command `pnpm audit --audit-level high` (not a package script). `check:agent-worker` and `test:agent-worker` run as the CI jobs `quality:agent-worker` and `test:agent-worker` (Issue #96). The CI job `deploy:server` (Issue #107) runs ShellCheck and the `deploy/tests/` suites; they need Linux, Docker and a throwaway VM, so there is no local script ([Deployment](deployment.md) §8). `pnpm check:affected` is **not implemented**. A missing script is recorded as `NOT IMPLEMENTED`, not `PASS`.

For every substantive task, the implementer runs all relevant existing checks and reports exact commands, exit status, commit SHA, skips, and blockers.

## 9. Review, PR and Definition of Done

The step-by-step flow is canonical in [Issue workflow](issue-workflow.md) and [Agent roles](agent-roles.md) §2. Quality requirements on it:

- DoR (`docs/engineering/definition-of-ready.md`) precedes implementation.
- The implementer self-reviews before opening the **Draft PR** to `dev`.
- The **independent reviewer** checks the diff, architecture semantics, security, acceptance criteria and missing tests, and may run targeted checks.
- After fixes, CI reruns and the review covers the **current commit**, not a stale SHA.
- No separate full review/PR per subtask by default.

The canonical three-step DoD is `docs/engineering/definition-of-done.md`: **Implementation Done → Review Done → Story Done**. Do not keep a second divergent checklist here.

## 10. Runtime security tests

Test that prohibited operations **fail**; the scenario list is canonical in [Security](security.md) §9 (working-copy/cross-project escape, Docker access from worker, unapproved MCP tools and controller actions, forbidden merge, secret visibility, production DB access, prompt-injection-driven tool use). A model refusing an instruction is **not** a replacement for enforced privilege boundaries.

**Provider enablement gate** (agent worker; see [Security](security.md) §2). Required negative tests:

1. Both providers are disabled when configuration is missing.
2. Explicitly disabled (`false`) providers cannot execute.
3. Malformed flag values (e.g. empty, `1`, `yes`, `TRUE`) fail closed.
4. A disabled provider never spawns a CLI subprocess (assert on the process-spawn boundary, not only on the returned status).
5. Enabling Claude Code does not enable Codex, and vice versa.
6. An execution request (including workflow definition or agent configuration content) cannot override provider enablement.
7. A disabled execution returns a clear, non-sensitive error (no credentials, environment dumps or internal paths).
8. A previously enabled provider can be disabled through configuration alone, without changing execution requests; subsequent executions are rejected.

These tests mock the process-spawning boundary and need no real provider credentials or network access; they run in regular CI, separate from controlled real-CLI smoke tests.

## 11. Specific bootstrap gates before Story 1

Documenting these decisions does **not** make the first functional User Story Ready: Technical Tasks B0–B5 must deliver verifiable, working outputs. Tasks, verification gates and the Story 1 DoR checklist are canonical in [Bootstrap](bootstrap-plan.md) §3 and §5. Quality-specific additions:

- [ ] PostgreSQL + Redis are available in local development **and** in the Testcontainers/test environment; the initial migration applies to an empty database in CI.
- [ ] Auth integration tests prove successful login, invalid password, no-session 401, logout and CSRF/Origin rejection.
- [ ] The three architecture checks and essential PR CI are operational, not just described.
- [ ] Manual orchestration, implementer and independent-reviewer responsibilities ([Agent roles](agent-roles.md)) have been used in a dry-run PR.

Implemented scripts: `pnpm db:migrate:dev`, `pnpm db:migrate:deploy`, `pnpm contracts:generate` and `pnpm contracts:check`. `contracts:check` regenerates OpenAPI and the generated web client and fails if they differ from the committed version; it is required in CI as `test:contracts`. Use pinned compatible library versions and deterministic output.

## 12. Remaining implementation decisions

- GitHub Actions workflows and precise affected-check logic.
- Exact tool versions, scripts, dependency-rule files, fixture generators.
- Security severity thresholds and full-E2E/release test schedules.
- Real provider CLI smoke-test prerequisites, cost controls and licensing verification.
- Whether a second GitHub account (e.g. a bot account for agents) is introduced so rulesets can separate agent and operator permissions.

Decision provenance: [Notion guardrails](https://app.notion.com/p/413d4d814eb0819499faecf3fe7f4afe) and [GitHub workflow](https://app.notion.com/p/413d4d814eb08175b243ca84f1191271).
