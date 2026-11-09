# Walking Skeleton — First End-to-End Vertical Slice

**Status:** approved implementation strategy with a selected bootstrap tooling baseline; user-story field details and GitHub Issues still require refinement. Decisions below are design targets, not implemented functionality.

## 1. Purpose

Prove that the architecture works **across actual application boundaries** early, before building complex agent execution or workflow UIs.

The first functional scenario is:

> As an operator, I can create a project from the Studio UI and see it in the project list after the system persists it in PostgreSQL.

Expected path:

```text
Next.js project form
  → typed REST request
  → NestJS Projects endpoint
  → Create Project handler
  → PostgreSQL repository
  → API response
  → Next.js project list
```

Do **not** use an in-memory fake as proof of the end-to-end scenario. Test doubles are appropriate in unit tests, not as the final integration evidence.

## 2. Bootstrap work (independent Technical Tasks)

These may be split into small, independently reviewable PRs into `dev`:

1. **Repository bootstrap:** pnpm monorepo, TypeScript, NestJS app, Next.js app, consistent scripts and configurations.
2. **Basic services:** development Docker Compose for PostgreSQL **and Redis** (required for operator sessions), env example files without credentials, Prisma ORM + reviewed Prisma Migrate workflow in `packages/database/`.
3. **Mandatory architecture gates:** Backend / Frontend / Monorepo dependency and structure checks, plus fixtures showing allowed and disallowed imports.
4. **Minimal CI:** formatting, lint, TypeScript, build, architecture tests, and relevant unit/integration checks on PRs; do not report unimplemented jobs as passing.
5. **Issue/PR workflow:** GitHub Issue Forms, DoR/DoD, Draft PR, reviews, branch/worktree conventions; enforce permissions to the extent available on the repository plan.
6. **Single-operator authentication:** implement password login, Argon2id hash from a secret, Redis-backed HttpOnly sessions, API auth guard, logout, CSRF/Origin protection and tests for unauthorized API calls.
7. **REST contract generation:** Zod 4 + `nestjs-zod` + NestJS Swagger to canonical OpenAPI 3.1, then `@hey-api/openapi-ts` generated Fetch client, with a deterministic generation/check script.

Avoid scaffolding unused business capabilities or privileged Docker operations just to complete the bootstrap.

## 3. First User Story — Create Project

**Boundaries:** `projects` business module in API and web; no requirement to implement Git repository connection, agent execution, workflows, MCP, or Preview in this first story.

**Proposed acceptance criteria (confirm during refinement):**

- The authenticated operator can open a Projects page, submit a minimal create-project form, and see the new project in the list.
- The API validates the input and returns a useful error for invalid input.
- The project is persisted in a real PostgreSQL database and survives application restart.
- The list reflects saved data, including after browser reload.
- An unauthorized request is rejected according to the chosen auth implementation.
- Tests cover successful creation, validation errors, data persistence, and the basic UI path.

**Contract First — selected starter contract to refine in Story 1:** public-facing routes are `POST /api/projects` and `GET /api/projects` behind an authenticated session. The initial proposal is `POST { name: string }` (trimmed, non-empty, maximum 100 characters), returning HTTP 201 and `{ id: string (UUID), name: string, createdAt: string (ISO 8601) }`. `GET` returns HTTP 200 `{ items: Project[] }` sorted newest first. Invalid input gives HTTP 400 and no session gives HTTP 401. The UI calls the generated client. Confirm exact uniqueness, duplicate-name behavior, standardized error responses and empty-list behavior in the User Story Issue **before** marking it Ready; only the accepted version becomes the contract. Swagger/OpenAPI generation must work before BE/FE are assigned to separate implementers.

## 4. Expected backend implementation

```text
apps/api/src/modules/projects/
  features/create-project/
    handler.ts
    endpoint.ts      # if an HTTP endpoint is needed
    schema.ts        # request validation
    __tests__/
  features/list-projects/
    handler.ts
    endpoint.ts
    __tests__/
  domain/
    entities/
    repositories/    # aggregate repository contract, if needed
  infrastructure/repositories/
  projects.module.ts
```

Create only files actually required by the slice. Keep handlers independent of HTTP and ORM; the endpoint is a thin adapter. Read queries may use a dedicated read port/repository if justified, but do not introduce unnecessary abstractions.

## 5. Expected frontend implementation

```text
apps/web/src/
  app/(studio)/projects/page.tsx
  modules/projects/
    features/project-list/
    features/create-project/
    api/
    index.ts
```

Pages compose publicly exported feature components. Use the agreed API client and appropriate local/form/server-state handling. Do not place business use cases in Next.js route handlers or Server Actions.

## 6. Testing and architecture evidence

| Gate | Minimum evidence |
| --- | --- |
| Architecture API | No forbidden cross-module imports; valid VSA boundaries |
| Architecture Web | Public module API, no forbidden dependency direction |
| Architecture Monorepo | No client imports of server code; no package cycles |
| Backend unit | Handler validation and behavior |
| Backend integration | Real HTTP → handler → PostgreSQL path and failure cases |
| Frontend component | Create form and project-list behavior |
| End-to-end | Playwright: create a project, verify list and reload |
| Build/quality | Formatting, lint, typecheck, production builds and required CI green |
| Security | Auth and validation appropriate to chosen minimal auth model |

The tests above are **targets to implement** during the technical bootstrap and first story. A passing local script cannot be claimed until it exists and has executed.

## 7. Workflow and Done

1. Complete repository bootstrap, auth, Prisma migration, and contract generation Technical Tasks; then refine User Story and verify DoR.
2. The operator executes the **documented manual `take-ticket` procedure** using a primary Claude Code session; a coded command/skill does not exist yet. Prepare a bounded handoff and isolated worktree/branch. See [Agent roles](../engineering/agent-roles.md).
3. Implement BE + FE in one context if small; split BE/FE contexts if justified, after agreeing on the contract.
4. Run local checks, prepare diff, open Draft PR into `dev`.
5. CI and independent review; iterate on findings and rerun affected checks.
6. Merge only after required checks and approval; verify the integrated behavior and close the Issue only when applicable DoD is satisfied.

The first walking skeleton itself does not require the future per-project Compose Preview manager to be completed. Verify the end-to-end UI/API/DB scenario on the development/test environment; **Preview automation is a later slice**.

## 8. Next high-risk vertical proof

After the basic skeleton, prove the integration **agent definition → worker → official CLI adapter → execution status/logs → UI** in a controlled test environment. First pass the per-provider CLI terms/auth acceptance gate ([Security](../engineering/security.md) §2), then verify permissions, redaction, cancellation, timeout, and isolation. Use Fake Runners in routine CI; real CLI smoke tests should be separate and controlled.

Decision provenance: [Walking Skeleton & Vertical Slices](https://app.notion.com/p/412d4d814eb081bdbe62c0d76b1c2d4b).
