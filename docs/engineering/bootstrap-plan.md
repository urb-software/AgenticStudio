# Repository Bootstrap & Story 1 Prerequisites

**Status:** decisions selected for bootstrapping. No command or service is operational until implemented and tested. This is an execution plan, not a promise of automated work.

## 1. Branches: one explicit policy

- `main`: stable/release branch; updated only via approved release integration (a later concern).
- `dev`: **GitHub default branch** and everyday integration target for feature/technical-task/bug PRs. New PRs propose `dev` as base; GitHub reads Issue Forms and the PR template from `dev`.
- `Closes #...` would close an Issue as soon as its PR merges into `dev`, before DoD verification. PRs use `Refs #...`; the operator closes Issues explicitly after DoD.
- Agents must not merge, force-push or change the default branch. The repository is **public**, so GitHub rulesets are enforced on the Free plan: protect `main` and `dev` (see [Security](security.md) §4). The operator still performs the final merge after CI and independent review.

For a **brand-new empty remote** and an uninitialized local folder containing the downloaded documents:

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

Then set `dev` in GitHub **Settings → General → Default branch**. Verify with `git ls-remote --heads origin main dev` and confirm GitHub shows `dev` as default. If a Git repository or remote already exists, **inspect it first** and adapt; never reinitialize, rewrite history or force-push.

From then on, routine changes go through issue branches and PRs into `dev`; no direct commits to `main` or `dev`.

## 2. Fixed tooling decisions for the initial implementation

Canonical decision table (the P0 v2 baseline referenced by [System](../architecture/system.md) §9). These are selected baselines, not claims that code or controls exist.

| Concern | Minimal selected approach | Explicit exclusion | Why |
| --- | --- | --- | --- |
| Identity | One operator; API password verified against an Argon2id secret hash; Redis-backed opaque server-side session; secure HttpOnly cookie | OAuth, SSO, signup, database of users, roles | Meets authenticated/unauthorized acceptance without a full identity platform |
| Persistence | PostgreSQL, Prisma ORM / Prisma Migrate in `packages/database`, feature-owned repository adapters | Second ORM, event sourcing, generic base repositories | One standard schema and migration path for the monorepo |
| HTTP schemas | Zod 4 as authoritative runtime/TypeScript schema; `nestjs-zod` and `@nestjs/swagger` to OpenAPI 3.1 | Duplicated `class-validator` DTOs or hand-maintained OpenAPI | Contract-first path |
| Browser client | `@hey-api/openapi-ts` generated typed Fetch client in `apps/web/src/platform/api/generated/` | Browser imports of NestJS internals; handwritten duplicate DTOs | No duplicated handwritten frontend DTOs |
| Repository | `main` stable/release; `dev` GitHub default and PR integration branch (§1) | `Closes #...` in PRs | One unambiguous PR target; Issue Forms and PR template served from `dev`; Issues closed explicitly after DoD |
| Agent execution | Official Claude Code and Codex CLI binaries behind a small provider-specific runner interface; enabled per provider only after validation ([Security](security.md) §2) | API/SDK runners in MVP | Preserves native CLI behavior while keeping the provider-policy risk gated |
| Agent coordination | Human operator with a primary Claude Code session; fresh implementer and reviewer contexts; Codex CLI may fill either task role | Automation called `take-ticket` without actual implementation | No imaginary automation or agent framework required at bootstrap |

- Lock compatible **exact versions** in `pnpm-lock.yaml` during the respective Technical Task.
- Verify NestJS/`nestjs-zod`/Swagger interoperability with one real endpoint and an offline OpenAPI generator before generalizing.
- Prisma major-version configurations change: use the current version's officially supported config and PostgreSQL adapter, not stale examples.

## 3. Dependency-ordered Technical Tasks (B0–B5 and S1 under the Walking Skeleton Epic)

| Sequence | Technical Task | Verification gate |
| --- | --- | --- |
| B0 | Repository first commit, `main`, GitHub-default `dev`, SDLC v3 forms, baseline rulesets and secret scanning | Both remote branches exist; `dev` is the GitHub default; rulesets block direct push/force-push/deletion on `main` and `dev`; secret push protection on; first sample PR targets `dev` |
| B1 | pnpm workspace, NestJS/Next.js boot and basic TypeScript/lint/build | `pnpm install --frozen-lockfile`, build and typecheck succeed |
| B2 | PostgreSQL + Redis local Compose, Prisma schema/migrations and DB DI | Committed migration applies to empty DB; repository integration test with PostgreSQL passes |
| B3 | Minimal operator auth with Redis sessions and route guard | Auth/login/session/logout + 401 + rate-limit/origin rejection integration tests pass |
| B4 | API Zod/OpenAPI and generated typed client pipeline | Generated OpenAPI and client reflect one endpoint and deterministic drift check passes |
| B5 | Architecture checks API/Web/Monorepo, Vitest baseline and PR CI | Separate relevant gates execute on PR to `dev`; no checks are silently skipped; `ci:required` is a required status check in the `dev` ruleset |
| S1 | **User Story — Create Project** | End-to-end form → authenticated REST → real PostgreSQL → reload works; required checks pass |

Ordering:

- B0 is a manual setup step; it needs no fake PR before a branch exists.
- B2 and B4 may run in parallel after B1 where dependencies permit.
- B3 needs Redis from B2 and the API app from B1.
- B5 may begin as soon as the workspace exists.
- **S1 must not move to Ready until B1–B5 results and its own detailed acceptance criteria are verified.**

**Provider validation (not Story 1 prerequisites).** These gate the agent worker, not the walking skeleton. B6 and B7 are independent Technical Tasks under a separate, later Epic (agent execution proof, [Walking Skeleton](../product/walking-skeleton.md) §8), run whenever the operator chooses; each provider is approved separately.

| Sequence | Technical Task | Verification gate |
| --- | --- | --- |
| B6 | Validate Claude Code CLI Authentication, Terms and Headless Execution | Dated decision record in `docs/engineering/provider-compliance/` with all required fields and an operator-accepted decision |
| B7 | Validate Codex CLI Authentication, Terms and Headless Execution | Same as B6, for Codex CLI; B6 approval does not imply B7 approval |

- Neither task blocks S1.
- Required record fields, enablement flags and the rule that a provider stays disabled without an `Approved`, still-applicable record are canonical in [Security](security.md) §2; template in [`provider-compliance/README.md`](provider-compliance/README.md).
- Record only what the reviewed terms and the controlled test show; use `Needs Clarification` instead of guessing.

## 4. Minimal login and API contract

### Authentication

B3 implements `POST /api/auth/login`, `GET /api/auth/session` and `POST /api/auth/logout`. Endpoint behavior, session, cookie, CSRF/Origin and rate-limit requirements are canonical in [Security](security.md) §8. B3 also chooses and documents the exact cookie attributes.

### Starter Create Project contract (S1 must refine before Ready)

- `POST /api/projects`: JSON input `{ name: string }`, trimmed, 1–100 characters; success 201 `{ id: UUID, name, createdAt: ISO-8601 string }`.
- `GET /api/projects`: success 200 `{ items: Project[] }`, deterministic newest-first ordering.
- Invalid input 400; anonymous 401.
- To document in the Issue before S1 enters Ready: standard error payload, uniqueness and duplicate-name semantics, empty-list behavior. Only the accepted version becomes the contract.
- Zod feature schemas produce OpenAPI and the typed frontend client. No stub contracts maintained separately from request validation; test that generated output matches source.

## 5. Story 1 Definition of Ready gate

Before moving Story 1 to `Ready`, verify:

- [ ] `dev` exists remotely and is the GitHub default; the Story issue is attached to a native Epic parent.
- [ ] B1–B5 are complete, merged through reviewed PRs where applicable, and CI checks actually execute.
- [ ] Auth can log in and log out; the API rejects anonymous project calls (401); mutation CSRF/Origin defense has negative tests.
- [ ] A real PostgreSQL Prisma migration and repository integration tests run.
- [ ] The Zod → OpenAPI → generated frontend Fetch client pipeline is reproducible in CI.
- [ ] Story acceptance criteria, field rules, validation/error shapes and duplicate-name semantics are agreed in the GitHub Issue.
- [ ] `Workflow Stage = Ready` is explicit; no open native `Blocked by` dependencies or `blocked:external` label remain.
- [ ] The operator has identified the implementer context, reviewer context and relevant handoff docs.

## 6. Scope restraint

Not prerequisites for Story 1 (they belong to later vertical slices): a custom agent orchestrator, login IdP, OAuth infrastructure, release platform, worker/container sandbox, full workflow engine, deployed per-project Preview. Record unmet controls honestly: planned scripts and role policies are not executable enforcement.
