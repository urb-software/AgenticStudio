# Repository Bootstrap & Story 1 Prerequisites

**Status:** decisions selected for bootstrapping; no command or service is considered operational until it has been implemented and tested. This is a practical execution plan, not a promise of automated work.

## 1. Branches: one explicit policy

- `main`: stable/release branch; updated only via approved release integration (a later concern).
- `dev`: **GitHub default branch** and everyday integration target for feature/technical-task/bug PRs. New PRs propose `dev` as base, and GitHub reads Issue Forms and the PR template from `dev`.
- Because `Closes #...` would close an Issue as soon as its PR merges into `dev` (before DoD verification), PRs use `Refs #...` and the operator closes Issues explicitly after DoD.
- Agents must not merge, force-push or change the default branch. The repository is **public**, so GitHub rulesets are enforced on the Free plan: protect `main` and `dev` (see [Security](security.md) §4). The operator still performs the final merge after CI and independent review.

For a **brand-new empty remote** and an uninitialized local folder containing your downloaded documents:

```bash
# Run once; adjust REMOTE_URL and the current directory for your repository.
git init -b main
git remote add origin REMOTE_URL
git add .
git commit -m "docs: initialize architecture and SDLC"
git push -u origin main
git switch -c dev
git push -u origin dev
```

Then in GitHub **Settings → General → Default branch**, choose `dev`. Verify `git ls-remote --heads origin main dev`, and verify GitHub displays `dev` as default. If a Git repository or remote already exists, **inspect it first** and adapt rather than reinitializing or rewriting history. Do not force-push.

After this step, do routine changes on issue branches and PRs into `dev`; do not continue committing directly to `main` or `dev`.

## 2. Fixed tooling decisions for the initial implementation

| Concern | Minimal selected approach | Explicit exclusion |
| --- | --- | --- |
| Identity | One operator; API password verified against an Argon2id secret hash; Redis-backed opaque server-side session | OAuth, SSO, signup, database of users, roles |
| Persistence | PostgreSQL, Prisma ORM / Prisma Migrate in `packages/database`, feature-owned repository adapters | Second ORM, event sourcing, generic base repositories |
| HTTP schemas | Zod 4 as authoritative runtime/TypeScript schema; `nestjs-zod` and `@nestjs/swagger` to OpenAPI 3.1 | Duplicated `class-validator` DTOs or hand-maintained OpenAPI |
| Browser client | `@hey-api/openapi-ts` generated typed Fetch client in `apps/web/src/platform/api/generated/` | Browser imports of NestJS internals; handwritten duplicate DTOs |
| Agent coordination | Human operator with a primary Claude Code session; fresh implementer and reviewer contexts; Codex CLI may fill either task role | Automation called `take-ticket` without actual implementation |

Lock compatible **exact versions** in `pnpm-lock.yaml` during the respective Technical Task. Verify NestJS/`nestjs-zod`/Swagger interoperability with one real endpoint and an offline OpenAPI generator before generalizing. Prisma major-version configurations change; use the current version's officially supported config and PostgreSQL adapter instead of copying stale examples.

## 3. Dependency-ordered Technical Tasks (each under the bootstrap Epic)

| Sequence | Technical Task | Verification gate |
| --- | --- | --- |
| B0 | Repository first commit, `main`, GitHub-default `dev`, SDLC v3 forms, baseline rulesets and secret scanning | Both remote branches exist; `dev` is the GitHub default; rulesets block direct push/force-push/deletion on `main` and `dev`; secret push protection on; first sample PR targets `dev` |
| B1 | pnpm workspace, NestJS/Next.js boot and basic TypeScript/lint/build | `pnpm install --frozen-lockfile`, build and typecheck succeed |
| B2 | PostgreSQL + Redis local Compose, Prisma schema/migrations and DB DI | Committed migration applies to empty DB; repository integration test with PostgreSQL passes |
| B3 | Minimal operator auth with Redis sessions and route guard | Auth/login/session/logout + 401 + rate-limit/origin rejection integration tests pass |
| B4 | API Zod/OpenAPI and generated typed client pipeline | Generated OpenAPI and client reflect one endpoint and deterministic drift check passes |
| B5 | Architecture checks API/Web/Monorepo, Vitest baseline and PR CI | Separate relevant gates execute on PR to `dev`; no checks are silently skipped; `ci:required` is a required status check in the `dev` ruleset |
| S1 | **User Story — Create Project** | End-to-end form → authenticated REST → real PostgreSQL → reload works; required checks pass |

B2 and B4 may proceed in parallel after B1 where dependencies permit. B3 needs Redis from B2 and an API app from B1. B5 may begin as soon as the workspace exists. **S1 must not move to Ready until B1–B5 results and its own detailed acceptance criteria are verified.** B0 is a manual setup step; it does not need a fake PR before a branch exists.

**Provider validation (not Story 1 prerequisites):** these gate the agent worker, not the walking skeleton. B6 and B7 are independent Technical Tasks and can run whenever the operator chooses; each provider is approved separately.

| Sequence | Technical Task | Verification gate |
| --- | --- | --- |
| B6 | Validate Claude Code CLI Authentication, Terms and Headless Execution | Dated decision record in `docs/engineering/provider-compliance/` with all required fields and an operator-accepted decision |
| B7 | Validate Codex CLI Authentication, Terms and Headless Execution | Same as B6, for Codex CLI; B6 approval does not imply B7 approval |

- Required record fields and the runtime enablement policy are canonical in [Security](security.md) §2; use the template in [`provider-compliance/README.md`](provider-compliance/README.md).
- Neither task blocks S1. Each must have an `Approved`, still-applicable record before its provider is enabled in `agent-worker`; an unapproved provider stays disabled (`CLAUDE_CODE_ENABLED` / `CODEX_CLI_ENABLED` unset or `false`).
- The existence of a headless CLI command is not evidence that every subscription-based automation scenario is permitted. Record only what the reviewed terms and the controlled test actually show; use `Needs Clarification` instead of guessing.

## 4. Minimal login and API contract

### Authentication

- `POST /api/auth/login`: receives `{ password }` over HTTPS (localhost HTTP is development only), validates Argon2id hash, rotates session, sets an HttpOnly cookie, rate-limits failures.
- `GET /api/auth/session`: returns a non-secret indication of authentication for the UI; requires a valid session.
- `POST /api/auth/logout`: invalidates Redis session and clears cookie; protected against cross-site mutation.
- All project routes and future SSE routes require API-side authentication; anonymous calls get HTTP 401. Mutations require same-origin/Origin validation and an appropriate CSRF defense, not only SameSite cookies.
- Use same-origin UI plus `/api` reverse proxy, no wildcard CORS, no credentials in Git. Choose and document cookie attribute details as part of B3; deployment always uses HTTPS.

### Starter Create Project contract (S1 must refine before Ready)

- `POST /api/projects`, JSON input `{ name: string }`, trimmed, 1–100 characters; success 201 `{ id: UUID, name, createdAt: ISO-8601 string }`.
- `GET /api/projects`, success 200 `{ items: Project[] }`, deterministic newest-first ordering.
- Invalid input 400, anonymous 401; document standard error payload and duplicate-name semantics in the issue before S1 enters Ready.
- Zod feature schemas produce OpenAPI and the typed frontend client. Avoid stub contracts maintained separately from request validation; test that generated output matches source.

## 5. Story 1 Definition of Ready gate

Before moving Story 1 to `Ready`, verify:

- [ ] `dev` exists remotely and is the GitHub default; Story issue is attached to a native Epic parent.
- [ ] B1–B5 are complete, merged through reviewed PRs where applicable, and CI checks actually execute.
- [ ] Auth can log in and log out, API rejects anonymous project calls (401), mutation CSRF/Origin defense has negative tests.
- [ ] A real PostgreSQL Prisma migration and repository integration tests run.
- [ ] Zod → OpenAPI → generated frontend Fetch client pipeline is reproducible in CI.
- [ ] Story acceptance criteria, field rules, validation/error shapes and duplicate-name semantics are agreed in GitHub Issue.
- [ ] `Workflow Stage = Ready` is explicit and no open native `Blocked by` dependencies or `blocked:external` label remain.
- [ ] The operator has identified the implementer context, reviewer context and relevant handoff docs.

## 6. Scope restraint

Do not build a custom agent orchestrator, login IdP, OAuth infrastructure, release platform, worker/container sandbox, full workflow engine, or deployed per-project Preview as a prerequisite for Story 1. These belong to later vertical slices. Record unmet controls honestly: planned scripts/role policies are not executable enforcement.
