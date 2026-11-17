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

The module layout and the nine structure rules are canonical in [Backend](../architecture/backend.md) §2 and §3 ([ADR 0003](../architecture/adr/0003-api-module-layout.md)). Checks below that the layout tickets of Epic #160 have not yet delivered are marked "(added by #n)"; the ticket that adds a check removes its marker, so this document never claims a check exists before it does. The rules that name features, ports, entry points and contracts use the new paths (`application/features/`, `application/ports/`, `entry-points/`, `contracts/`).

**Dependency rules** (Dependency Cruiser or equivalent):

- No imports of another business module's private files; use explicit public contracts.
- `domain/` does not import NestJS, ORM, database, queue, infrastructure, HTTP or framework details.
- Feature handlers depend on interfaces/ports, not concrete adapters/repository implementations.
- Domain repository contracts live in `domain/repositories/`; read ports and other service interfaces in `ports/` (naming convention in [Backend](../architecture/backend.md) §4).
- No prohibited cycles between modules or layers.
- Event consumers use the owning module's public contract and do not bypass module boundaries.
- Composition-root DI wiring exceptions are narrowly scoped and explicitly tested, not broad allowlists.
- `application/` imports no HTTP, schema, OpenAPI, queue or scheduler API: no `nestjs-zod`, `@nestjs/swagger`, `class-validator`, `class-transformer`, `express`, `@nestjs/platform-express`, `bullmq`, `@nestjs/bullmq`, `@nestjs/schedule`, `node-cron`, `cron`, Node `http`/`https`/`http2`, and no controller, route or parameter decorator from `@nestjs/common` (`Controller`, `Get`, `Body`, `UseGuards`, …). Plain `zod` and `platform/queue/` stay allowed for now; #164 tightens `platform/queue/` for `application/`.
- `entry-points/` imports nothing from `infrastructure/`, and from a repository interface or port file only domain error classes (imported names ending in `Error`), so an entry point reaches the application through handlers. **One pinned exemption, removed by #166:** `executions/entry-points/http/operator/stream-run-events/endpoint.ts` injects the `operator-sessions` and `run-log-settings` ports itself; the same import from any other file fails.
- No import from one feature folder into another feature folder of the same module (added by #164 for `projects`; for `executions` by #166; for all modules, by path pattern, by #170).
- `domain/` imports nothing from `application/ports/` (added by #168).
- Domain tests import no database client or container tooling (added by #168).
- An application collaborator never imports `application/features/` (added by #170).

**Structural rules** (Vitest assertions or equivalent):

- A present use-case feature has a `handler.ts`; `endpoint.ts`, `schema.ts`, `input.ts`, `__tests__/` are optional.
- Concrete read/write repository implementations belong in `infrastructure/repositories/`, adapters in `infrastructure/adapters/`.
- Public integration event definitions are versioned and publisher-owned: `contracts/events/<event-name>-v<n>.ts` exporting only `<EventName>V<n>` / `<EventName>V<n>Schema`, with no duplicate event definitions across modules (convention in [Backend](../architecture/backend.md) §6).
- `contracts/` holds only `index.ts` and `events/`.
- No directory named `shared`, `common`, `utils` or `helpers` inside a module; the one exemption is exactly `entry-points/http/shared/`.
- Every file in `domain/entities/` exports a class with a non-public constructor (added by #165 for `projects`; for `executions` by #167; for all modules, by path pattern, by #170).
- No `domain/services/` directory (added by #168).
- The list of repository methods is pinned: a new method fails until the list is changed in review (added by #170).
- The list of application collaborators is pinned: a new one fails until the list is changed in review (added by #170).
- Do **not** require empty folders, mandatory `command.ts`/`query.ts`, or `domain/events/`.
- Static checks cannot prove where all business logic lives; thin consumer/endpoint rules need behavior tests and review.

**Structure report** (not a check; added by #170): a script prints, for the API, the largest source files, the number of methods per repository interface, the number of public methods per handler, the number of collaborators per module and the number of files per feature. CI shows it in the pull request's job summary, with the change against the base branch, and it never fails the build (§7); it runs locally with one command that #170 documents here.

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
| An entry-point file other than the pinned one imports a pinned port (one pinned exemption, removed by #166) | FAIL |
| The pinned entry-point file imports a port other than its two (removed by #166) | FAIL |
| `contracts/` holds `index.ts` and `events/` only | PASS |
| `contracts/` holds another file | FAIL |
| `contracts/` holds another directory | FAIL |
| A module has `entry-points/http/shared/` (the one exemption) | PASS |
| A module has a `shared`, `common`, `utils` or `helpers` directory, e.g. `application/shared/` | FAIL |
| A subdirectory of `entry-points/http/shared/` is named `shared`, `common`, `utils` or `helpers` | FAIL |
| A feature imports another feature of its module | FAIL (added by #164 for `projects`; `executions` by #166; all modules by #170) |
| A feature imports a port, the domain or its own files | PASS (added by #164 for `projects`; `executions` by #166; all modules by #170) |
| `domain/entities/` file exports a class with a non-public constructor | PASS (added by #165 for `projects`; `executions` by #167; all modules by #170) |
| `domain/entities/` file exports a class with a public constructor, or no class | FAIL (added by #165 for `projects`; `executions` by #167; all modules by #170) |
| A module has no `domain/services/` directory | PASS (added by #168) |
| A module has a `domain/services/` directory | FAIL (added by #168) |
| `domain/` imports only `domain/` and plain libraries | PASS (added by #168) |
| `domain/` imports from `application/ports/` | FAIL (added by #168) |
| A domain test imports only the domain and test helpers | PASS (added by #168) |
| A domain test imports a database client or container tooling | FAIL (added by #168) |
| An application collaborator imports ports and the domain | PASS (added by #170) |
| An application collaborator imports `application/features/` | FAIL (added by #170) |
| Repository methods and application collaborators match the pinned lists | PASS (added by #170) |
| A repository method or application collaborator is added, renamed or removed without updating its pinned list | FAIL (added by #170) |
| The reference module fixture (the complete approved layout) | PASS with every check (added by #170) |
| Web imports `@/modules/agents` public entrypoint | PASS |
| Web deep-imports another module's private Zustand store | FAIL |
| Two modules introduce a dependency cycle | FAIL |

A change to architecture tooling must run the fixtures; a configuration edit must **never** silently disable enforcement.

### How each API structure rule is enforced

One row per rule of [Backend](../architecture/backend.md) §3. A rule cannot be listed without the enforcement cell filled in: **gate check** (`architecture:api`), **pinned test** (a test that fails when a pinned list changes) or **review only** (the review checklist and the review skill's third brief, no tool).

| # | Rule | Enforcement |
| --- | --- | --- |
| 1 | Features are independent | Gate check: no import between feature folders (added by #164 for `projects`; `executions` by #166; all modules by #170) |
| 2 | Entry points call handlers; handlers never call each other | Gate checks: `application/` imports no HTTP, schema, queue or scheduler API, and `entry-points/` imports no repository, port or infrastructure file; handlers never call each other, through the check of rule 1 (added by #164). Review only: that an entry point holds no business rule |
| 3 | Shared application logic is the exception | Gate check: no shared, common, utils or helpers directory, collaborators never import features (added by #170); pinned test: the list of application collaborators (added by #170); the six-step order is review only |
| 4 | Behaviour lives on the object it is about | Gate check: entity files export a class with a non-public constructor (added by #165 for `projects`; `executions` by #167; all modules by #170); where a rule sits is review only |
| 5 | There is no `domain/services/` | Gate check: no `domain/services/` directory (added by #168) |
| 6 | The domain receives facts and never fetches them | Gate check: `domain/` imports nothing from `application/ports/` and no database client in domain tests (added by #168); pinned test: the list of repository methods (added by #170); that no business rule is written in the database adapter is review only |
| 7 | Validation has two homes | Review only |
| 8 | `contracts/` is a module's public face | Gate check: `contracts/` holds only `index.ts` and `events/`, and the existing check that other modules import only `contracts/index.ts` |
| 9 | Same role, same form | Review only; entity classes are also covered by the check of rule 4 |

Rules that are review only are covered by the specific backend items of the review report ([template](../templates/review-report.md) §2) and by the review skill's third brief, which checks only the nine rules against the diff. The architecture review skill (`studio-improve-codebase-architecture`) runs at the end of each Epic ([Agent roles](agent-roles.md) §6).

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
pnpm check:affected
```

Current state (root `package.json`, `.github/workflows/ci.yml`): `check:api` and `check:web` exist and run in the CI jobs `quality:api` and `quality:web`; `test:api`, `test:web` and the three `architecture:*` scripts exist and run as the CI jobs of the same names. Contract checks run as `pnpm contracts:check` (CI job `test:contracts`); there is no `pnpm test:contracts` script. `pnpm format:check` (whole repository, in CI `quality:web`), `pnpm design:test` (design-system viewer server tests, in CI `quality:web`) and `pnpm e2e:smoke` (CI `e2e:smoke`) also exist, and CI `security` runs the pnpm built-in command `pnpm audit --audit-level high` (not a package script). `check:agent-worker` and `test:agent-worker` run as the CI jobs `quality:agent-worker` and `test:agent-worker` (Issue #96). The CI job `deploy:server` (Issue #107) runs ShellCheck and the `deploy/tests/` suites; they need Linux, Docker and a throwaway VM, so there is no local script ([Deployment](deployment.md) §8). `pnpm check:affected` is **not implemented**. A missing script is recorded as `NOT IMPLEMENTED`, not `PASS`.

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
