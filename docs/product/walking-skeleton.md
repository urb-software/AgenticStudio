# Walking Skeleton — First End-to-End Vertical Slice

**Status:** approved implementation strategy with a selected bootstrap tooling baseline. User-story field details and GitHub Issues still require refinement; decisions below are design targets, not implemented functionality.

## 1. Purpose

Prove early that the architecture works **across actual application boundaries**, before building complex agent execution or workflow UIs.

First functional scenario:

> As an operator, I can create a project from the Studio UI and see it in the project list after the system persists it in PostgreSQL.

```text
Next.js project form
  → typed REST request
  → NestJS Projects endpoint
  → Create Project handler
  → PostgreSQL repository
  → API response
  → Next.js project list
```

An in-memory fake is **not** proof of the end-to-end scenario. Test doubles belong in unit tests, not in the final integration evidence.

## 2. Bootstrap work (independent Technical Tasks)

Small, independently reviewable PRs into `dev`. Order and verification gates: [Bootstrap](../engineering/bootstrap-plan.md) §3.

1. **Repository bootstrap:** pnpm monorepo, TypeScript, NestJS app, Next.js app, consistent scripts and configurations.
2. **Basic services:** development Docker Compose for PostgreSQL **and Redis** (required for operator sessions), env example files without credentials, Prisma ORM + reviewed Prisma Migrate workflow in `packages/database/`.
3. **Mandatory architecture gates:** Backend / Frontend / Monorepo dependency and structure checks, plus fixtures showing allowed and disallowed imports.
4. **Minimal CI:** formatting, lint, TypeScript, build, architecture tests, and relevant unit/integration checks on PRs; unimplemented jobs are never reported as passing.
5. **Issue/PR workflow:** GitHub Issue Forms, DoR/DoD, Draft PR, reviews, branch/worktree conventions; permissions enforced to the extent the repository plan allows.
6. **Single-operator authentication:** password login with Redis-backed sessions and an API auth guard, including tests for unauthorized API calls. Spec: [Security](../engineering/security.md) §8.
7. **REST contract generation:** Zod → OpenAPI 3.1 → generated Fetch client, with a deterministic generation/check script. Tooling: [Bootstrap](../engineering/bootstrap-plan.md) §2.

Do not scaffold unused business capabilities or privileged Docker operations to complete the bootstrap.

## 3. First User Story — Create Project

**Boundaries:** the `projects` business module in API and web. Out of scope: Git repository connection, agent execution, workflows, MCP, Preview.

**Proposed acceptance criteria (confirm during refinement):**

- The authenticated operator can open a Projects page, submit a minimal create-project form, and see the new project in the list.
- The API validates the input and returns a useful error for invalid input.
- The project is persisted in a real PostgreSQL database and survives application restart.
- The list reflects saved data, including after browser reload.
- An unauthorized request is rejected according to the chosen auth implementation.
- Tests cover successful creation, validation errors, data persistence, and the basic UI path.

**Contract First:** `POST /api/projects` and `GET /api/projects` behind an authenticated session; the UI calls the generated client. The starter contract (payloads, status codes, open points to confirm before Ready) is canonical in [Bootstrap](../engineering/bootstrap-plan.md) §4; only the version accepted in the Story Issue becomes the contract. Swagger/OpenAPI generation must work before BE/FE are assigned to separate implementers.

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

Create only the files the slice requires. Handlers stay independent of HTTP and ORM; the endpoint is a thin adapter. Read queries may use a dedicated read port/repository if justified; no unnecessary abstractions.

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

Pages compose publicly exported feature components and use the agreed API client with appropriate local/form/server-state handling. No business use cases in Next.js route handlers or Server Actions.

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

These tests are **targets to implement** during the technical bootstrap and first story. A passing local script cannot be claimed until it exists and has executed.

## 7. Workflow and Done

1. Complete the repository bootstrap, auth, Prisma migration, and contract generation Technical Tasks; then refine the User Story and verify DoR.
2. The operator runs the **manual `take-ticket` procedure** ([Agent roles](../engineering/agent-roles.md) §2; no coded command/skill exists yet): bounded handoff, isolated worktree/branch, Draft PR into `dev`, CI and independent review, operator merge, Issue closed only when the applicable DoD is satisfied.
3. Implement BE + FE in one context if small; split BE/FE contexts if justified, after agreeing on the contract.

The walking skeleton does not require the future per-project Compose Preview manager. Verify the end-to-end UI/API/DB scenario on the development/test environment; **Preview automation is a later slice**.

## 8. Next high-risk vertical proof

After the basic skeleton, prove **agent definition → worker → official CLI adapter → execution status/logs → UI** in a controlled test environment. First pass the per-provider CLI terms/auth acceptance gate ([Security](../engineering/security.md) §2), then verify permissions, redaction, cancellation, timeout, and isolation. Routine CI uses Fake Runners; real CLI smoke tests are separate and controlled.

Decision provenance: [Walking Skeleton & Vertical Slices](https://app.notion.com/p/412d4d814eb081bdbe62c0d76b1c2d4b).
