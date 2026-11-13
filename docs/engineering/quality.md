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

**Dependency rules** (Dependency Cruiser or equivalent):

- No imports of another business module's private files; use explicit public contracts.
- `domain/` does not import NestJS, ORM, database, queue, infrastructure, HTTP or framework details.
- Feature handlers depend on interfaces/ports, not concrete adapters/repository implementations.
- Domain repository contracts live in `domain/repositories/`; read ports and other service interfaces in `ports/` (naming convention in [Backend](../architecture/backend.md) §4).
- No prohibited cycles between modules or layers.
- Event consumers use the owning module's public contract and do not bypass module boundaries.
- Composition-root DI wiring exceptions are narrowly scoped and explicitly tested, not broad allowlists.

**Structural rules** (Vitest assertions or equivalent):

- A present use-case feature has a `handler.ts`; `endpoint.ts`, `schema.ts`, `input.ts`, `__tests__/` are optional.
- Concrete read/write repository implementations belong in `infrastructure/repositories/`, adapters in `infrastructure/adapters/`.
- Public integration event definitions are versioned and publisher-owned: `contracts/events/<event-name>-v<n>.ts` exporting only `<EventName>V<n>` / `<EventName>V<n>Schema`, with no duplicate event definitions across modules (convention in [Backend](../architecture/backend.md) §6).
- Do **not** require empty folders, mandatory `command.ts`/`query.ts`, or `domain/events/`.
- Static checks cannot prove where all business logic lives; thin consumer/endpoint rules need behavior tests and review.

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
| Web imports `@/modules/agents` public entrypoint | PASS |
| Web deep-imports another module's private Zustand store | FAIL |
| Two modules introduce a dependency cycle | FAIL |

A change to architecture tooling must run the fixtures; a configuration edit must **never** silently disable enforcement.

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
pnpm architecture:api
pnpm architecture:web
pnpm architecture:monorepo
pnpm contracts:check     # CI job test:contracts
pnpm check:affected
```

Current state (root `package.json`, `.github/workflows/ci.yml`): `check:api` and `check:web` exist and run in the CI jobs `quality:api` and `quality:web`; `test:api`, `test:web` and the three `architecture:*` scripts exist and run as the CI jobs of the same names. Contract checks run as `pnpm contracts:check` (CI job `test:contracts`); there is no `pnpm test:contracts` script. `pnpm format:check` (whole repository, in CI `quality:web`) and `pnpm e2e:smoke` (CI `e2e:smoke`) also exist, and CI `security` runs the pnpm built-in command `pnpm audit --audit-level high` (not a package script). `pnpm check:affected` is **not implemented**. A missing script is recorded as `NOT IMPLEMENTED`, not `PASS`.

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

Test that prohibited operations **fail**; the scenario list is canonical in [Security](security.md) §9 (worktree/cross-project escape, Docker access from worker, unapproved MCP tools and controller actions, forbidden merge, secret visibility, production DB access, prompt-injection-driven tool use). A model refusing an instruction is **not** a replacement for enforced privilege boundaries.

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
