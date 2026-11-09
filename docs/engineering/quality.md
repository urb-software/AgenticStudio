# Quality, Testing & Architecture Guardrails

**Status:** approved target policy. The commands, scripts, jobs and test suites described here must still be **implemented** during the SDLC bootstrap; no claim of passing checks is valid until they run.

## 1. Quality principle

**Markdown explains → agents execute deterministic checks locally → CI independently reruns required checks → independent review evaluates semantics → controlled merge.** Security-critical actions require actual runtime permissions, not prompts.

Do not treat a clean unit-test result as proof of architectural correctness or safe behavior.

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

- **Deterministic static checks:** Prettier check, ESLint, TypeScript typecheck, dependency-graph rules, structural assertions, schema validation and reproducible build, assuming fixed inputs and pinned dependencies.
- **Controlled tests:** unit/integration/E2E can be reproducible with isolated DBs/containers, fixed fixtures and controlled clocks, but are not intrinsically guaranteed deterministic.
- **Nondeterministic integrations:** actual LLM/CLI responses, external services and human code review must not be assumed stable. Use **Fake Runner** implementations for regular CI; run real CLI smoke tests in a separate controlled stage.
- Never silently retry flaky tests until green without tracking and fixing the underlying cause.

## 4. Mandatory architecture test categories

These are **separate required gates**, not mere rules buried inside lint.

### `architecture:api` — NestJS

**Dependency rules** (Dependency Cruiser or equivalent):

- Private files of one business module cannot be imported from another; use explicit public contracts.
- `domain/` must not import NestJS, ORM, database, queue, infrastructure, HTTP or framework details.
- Feature handlers must depend on interfaces/ports rather than concrete adapters/repository implementations.
- Domain repository contracts live in `domain/repositories/`; read ports and other service interfaces in `ports/`.
- No prohibited cycles between modules or layers.
- Event consumers use the owning module's public contract and do not bypass module boundaries.
- Composition-root DI wiring exceptions must be narrowly scoped and explicitly tested, not broad allowlists.

**Structural rules** (Vitest assertions or equivalent):

- A present use-case feature has a `handler.ts`; `endpoint.ts`, `schema.ts`, `input.ts`, `__tests__/` are optional as appropriate.
- Concrete read/write repository implementations belong in `infrastructure/repositories/` and adapters in `infrastructure/adapters/`.
- Public integration event definitions are versioned and publisher-owned.
- Do **not** require empty folders, mandatory `command.ts`/`query.ts`, or `domain/events/`.
- Static checks cannot prove where all business logic lives; add behavior tests and review for thin consumer/endpoint rules.

### `architecture:web` — Next.js

**Dependency rules:**

- Cross-module consumers use a public `index.ts` or another explicitly approved entrypoint.
- No imports of private stores, hooks, editor internals or services from another module.
- `shared/` does not import `modules/`; `platform/` does not import business modules. Avoid cycles.
- `app/` composes feature APIs rather than reaching into private feature files.
- Frontend/client bundles must not import backend implementations, secrets, privileged controller code or Node-only server modules.

**Structural/behavioral rules:**

- Consistent feature-first layout, no mandatory empty `store.ts` or generic layered scaffolding.
- One owner for state: API cache, editor draft, form values, navigation and live buffer are not unwittingly mirrored into competing mutable stores.
- Server/Client Component boundaries and critical UI interaction rules require build and behavior tests, not only import scans.

### `architecture:monorepo` — workspace

- Validate cross-app/package dependency graph for `apps/api`, `apps/web`, `apps/agent-worker`, `apps/environment-controller`, and `packages/*`.
- No web imports of server or privileged implementations.
- Shared public contracts must have a single canonical source; avoid duplicate event definitions.
- No prohibited package cycles, hidden app-to-app implementation imports, or shortcuts bypassing published interfaces.

**All three architecture checks inspect the entire appropriate dependency graph on code/config PRs**, even if affected unit tests run on a subset.

## 5. Guardrail rules must be tested

Maintain positive and negative fixtures that prove the rules catch violations:

| Fixture | Expected |
| --- | --- |
| Handler imports a port from its own module | PASS |
| Handler imports another module's private repository | FAIL |
| Domain imports ORM/NestJS | FAIL |
| Consumer imports publisher-owned public versioned event | PASS |
| Web imports `@/modules/agents` public entrypoint | PASS |
| Web deep-imports another module's private Zustand store | FAIL |
| Two modules introduce a dependency cycle | FAIL |

A change to architecture tooling must run the fixtures; **do not** allow a configuration edit to silently disable enforcement.

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

Feature tests live **near the feature** in `__tests__/` where practical. System-level E2E/security/contract suites can live at repo-level `tests/`. Reusable fixtures and fakes can be put in `packages/testing/` if shared by multiple apps.

No rigid overall coverage percentage at the beginning. Measure it, but prioritize critical behavior and failure cases. Set numerical thresholds only after the first slices, if they help.

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
- Tests, relevant builds and scanners are blocking according to change scope and agreed severity policy. Security-critical findings are not waived casually.
- Keep the required PR check name stable. Avoid skip configurations that leave required status checks indefinitely pending or inadvertently mark incomplete work as green.
- `affected` selection may skip irrelevant tests only after computing dependency impact. Full architecture graphs are always checked for applicable application changes.
- The repository is **public**, so GitHub rulesets enforce required status checks on the Free plan. Once B5 exists, `ci:required` is a required check on `dev`; until then, do not claim the platform enforces CI. Merge remains a **manual operator decision** on top of enforced checks (see [Security](security.md) §4).
- For doc-only PRs, limit code checks only via explicitly tested policy; do not automatically skip when changing architecture tooling or core configuration.

## 8. Local agent checks (target command interface)

```bash
pnpm check:api
pnpm test:api
pnpm check:web
pnpm test:web
pnpm architecture:api
pnpm architecture:web
pnpm architecture:monorepo
pnpm test:contracts
pnpm check:affected
```

These are **planned package scripts, not currently executable commands**. The bootstrap Technical Tasks must implement them and ensure their output agrees with CI. If missing, record `NOT IMPLEMENTED`, not `PASS`.

For every substantive task, the implementer should run all relevant existing checks and submit a report listing exact commands, exit status, commit SHA, skips, and blockers.

## 9. Review, PR and Definition of Done

- Discovery/refinement and DoR precede implementation. See `docs/engineering/definition-of-ready.md` in the English SDLC template pack.
- The implementer performs self-review, then opens a **Draft PR** targeting `dev` for the integrated User Story or independent Technical Task.
- CI begins on PR updates; an **independent reviewer** checks the diff, architecture semantics, security, acceptance criteria and missing tests. Reviewer may run targeted checks.
- Fix findings, rerun CI, and review the **current commit**, not a stale SHA.
- After required checks, review and human approval, controlled merge to `dev` occurs. Verify Preview or the appropriate equivalent; close the Issue according to DoD.
- Do not require separate full reviews/PRs for every subtask by default.

The canonical three-step DoD is in `docs/engineering/definition-of-done.md` from the SDLC template pack: **Implementation Done → Review Done → Story Done**. Do not keep a second divergent checklist here.

## 10. Runtime security tests

Test that prohibited operations **fail**: access outside worktree, cross-project file access, unexpected MCP tools, Docker access from worker, forbidden branch merge, unapproved controller actions, secret visibility, production DB access, and prompt-injection-driven tool use. A model refusing an instruction is **not** a replacement for enforcing privilege boundaries.

**Provider enablement gate** (agent worker; see [Security](security.md) §2). Required negative tests:

1. Both providers are disabled when configuration is missing.
2. Explicitly disabled (`false`) providers cannot execute.
3. Malformed flag values (e.g. empty, `1`, `yes`, `TRUE`) fail closed.
4. A disabled provider never spawns a CLI subprocess (assert on the process-spawn boundary, not only on the returned status).
5. Enabling Claude Code does not enable Codex, and vice versa.
6. An execution request (including workflow definition or agent configuration content) cannot override provider enablement.
7. A disabled execution returns a clear, non-sensitive error (no credentials, environment dumps or internal paths).
8. A previously enabled provider can be disabled through configuration alone, without changing execution requests; subsequent executions are rejected.

These tests use a mocked process-spawning boundary and must not require real provider credentials or network access; they belong in regular CI, separate from controlled real-CLI smoke tests.

## 11. Specific bootstrap gates before Story 1

The first functional User Story is **not Ready** merely because these decisions are documented. Required independent Technical Tasks must deliver verifiable, working outputs:

- [ ] PostgreSQL + Redis available in local development and Testcontainers/test environment.
- [ ] Prisma Client generated, initial migration committed, migration applied to an empty database in CI.
- [ ] Operator login/session/logout implemented on NestJS with API guard; integration tests prove successful login, invalid password, no-session 401, logout and CSRF/Origin rejection.
- [ ] A reproducible pipeline converts Zod schemas → NestJS Swagger/OpenAPI → typed generated browser client, with contract drift check.
- [ ] Three distinct architecture checks and essential PR CI are operational, not just described.
- [ ] Repository has real GitHub-default `main` and integration `dev` branches; PRs target `dev`; rulesets protect both branches with `ci:required` as a required check on `dev`; the operator retains the final merge decision.
- [ ] Manual orchestration, implementer and independent-reviewer responsibilities are documented and used in a dry-run PR.

Planned script names (to be created, not yet runnable): `pnpm db:migrate:dev`, `pnpm db:migrate:deploy`, `pnpm contracts:generate`, and `pnpm contracts:check`. `contracts:check` must fail if OpenAPI or generated client output differs from the committed version. Use pinned compatible library versions and deterministic output. See [Bootstrap](bootstrap-plan.md) and [Agent roles](agent-roles.md).

## 12. Remaining implementation decisions

- GitHub Actions workflows and precise affected-check logic.
- Exact tool versions, scripts, dependency-rule files, fixture generators.
- Security severity thresholds and full-E2E/release test schedules.
- Real provider CLI smoke-test prerequisites, cost controls and licensing verification.
- Whether a second GitHub account (e.g. a bot account for agents) is introduced so rulesets can separate agent and operator permissions.

Decision provenance: [Notion guardrails](https://app.notion.com/p/413d4d814eb0819499faecf3fe7f4afe) and [GitHub workflow](https://app.notion.com/p/413d4d814eb08175b243ca84f1191271).
