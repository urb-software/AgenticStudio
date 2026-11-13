# AI Agent Studio

A private, self-hosted workspace for defining coding agents and skills, orchestrating Claude Code and Codex CLI tasks, reviewing Git changes, and previewing integrated project changes.

> **Status: architecture and SDLC bootstrap.** The documents describe the agreed target design; the application, CI, security controls, and CLI integrations are **not yet implemented**. The repository is built incrementally through GitHub Issues.

## What we are building

An MVP for **one human operator**, supporting the journey:

**Project → Agent/Skills → Workflow/Execution → Logs → Git Review & Approval → Merge to `dev` → Shared Project Preview**.

Backend: a NestJS modular monolith with six business modules: `projects` (including Git), `agents` (including skills), `workflows`, `executions`, `environments`, `mcp`. A Next.js UI exposes them. Separate worker and environment-controller processes perform constrained operations.

## Tech stack (target)

| Concern | Target |
| --- | --- |
| Language | TypeScript |
| Backend | NestJS, Modular Monolith, Vertical Slices |
| Frontend | Next.js App Router, shadcn/ui |
| Agent execution | Official Claude Code CLI and Codex CLI via a worker and small runner interface (no API/SDK runners in MVP); enabled per provider only after its terms/auth validation passes |
| Persistence | PostgreSQL + Prisma ORM / Prisma Migrate |
| Background jobs | Redis + BullMQ |
| Live updates | REST + Server-Sent Events (SSE) |
| Operator auth | One operator, password login + Redis server-side sessions |
| API schema/client | Zod 4 → `nestjs-zod`/NestJS Swagger → OpenAPI → `@hey-api/openapi-ts` Fetch client |
| Git workflow | Per-agent worktrees, review/approval, integration branch `dev` |
| Runtime | Docker Compose on a VPS, Traefik at the edge |
| Editors | Monaco for definitions, React Flow for workflows |

No GPU required. Outside the initial MVP: advanced sandboxing (microVMs), external-tenant APIs, a full MCP gateway.

## Repository layout (target; `apps/api`, `apps/web`, `packages/database`, `packages/testing` and `compose.yaml` exist so far)

```text
apps/
  web/                     # Next.js UI
  api/                     # NestJS modular monolith
  agent-worker/            # Background execution; no Docker socket
  environment-controller/  # Narrow, authorized Compose operations
packages/
  contracts/               # Only when cross-process contracts need extraction
  database/                # Prisma schema, migrations, client factory
  testing/                 # Testcontainers helpers and shared fakes
compose.yaml               # Local development PostgreSQL and Redis
```

## Documentation

- [Agent instructions](AGENTS.md) and [Claude Code entry point](CLAUDE.md)
- Product: [MVP scope](docs/product/mvp.md), [first walking skeleton](docs/product/walking-skeleton.md)
- Architecture: [system](docs/architecture/system.md), [backend](docs/architecture/backend.md), [frontend](docs/architecture/frontend.md)
- Guardrails: [quality & tests](docs/engineering/quality.md), [security](docs/engineering/security.md)
- Bootstrap: [repository bootstrap and Story 1 readiness](docs/engineering/bootstrap-plan.md), [agent roles](docs/engineering/agent-roles.md)
- SDLC: `docs/engineering/definition-of-ready.md`, `definition-of-done.md`, `issue-workflow.md`; `docs/templates/implementation-handoff.md`, `review-report.md`; `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`

## Getting started

The repository bootstrap follows the [bootstrap order](docs/engineering/bootstrap-plan.md). So far the pnpm workspace has `apps/api` (NestJS), `apps/web` (Next.js App Router), `packages/database` (Prisma) and `packages/testing` (Testcontainers), plus a development Compose file, the REST contract pipeline (Zod → OpenAPI → generated client), single-operator auth, the three architecture gates and PR CI ([Continuous integration](#continuous-integration)), and the first business slice: create and list projects ([Projects](#projects)). Add their setup commands here when they land. **Do not invent commands that do not yet exist.**

### Prerequisites

- Node.js 24 LTS (`engines.node` is `>=24.0.0 <25`; pnpm refuses other versions because `engineStrict` is on).
- pnpm 11, exactly the version in `packageManager` (`pnpm@11.22.0`). With Corepack: `corepack enable`.
- Docker with Compose v2, for the local PostgreSQL and Redis and for the Testcontainers integration tests.

### Install

```bash
pnpm install --frozen-lockfile
```

### Configure the environment

```bash
cp .env.example .env
```

`.env` is git-ignored; never commit it. `.env.example` holds dev-only placeholders, not credentials. Docker Compose, Prisma (`packages/database/prisma.config.ts`) and the API (`pnpm dev`, `pnpm --filter @agentic-studio/api start`) read the repository-root `.env`; variables already set in the shell take precedence.

| Variable | Used by | Notes |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | `compose.yaml` | Local database only. |
| `POSTGRES_PORT`, `REDIS_PORT` | `compose.yaml` | Host ports, bound to `127.0.0.1` only. Change them if 5432/6379 are taken. |
| `DATABASE_URL` | API, Prisma | Required. Must match the Compose values. |
| `API_PORT` | API | Default `3001`. Replaces the former `PORT`, which `next dev` also reads. |
| `API_HOST` | API | Bind address. Default `127.0.0.1` (localhost only); a deployment sets it explicitly. |
| `REDIS_URL` | API | Required. Sessions and login-failure counters. Must match the Compose Redis port. |
| `STUDIO_ORIGIN` | API | Default `http://localhost:3000`: the web app's origin, the only origin accepted on mutations. Plain HTTP only for localhost; https makes the session cookie `Secure` (`__Host-studio_session`). |
| `API_TRUSTED_PROXIES` | API | Default empty. Comma-separated IPs/CIDRs whose `X-Forwarded-For` is trusted for the client IP (rate limit). A proxied deployment must list its proxy addresses here (see [Web `/api` proxy](#web-api-proxy)). |
| `STUDIO_OPERATOR_PASSWORD_HASH` | API | Required. Argon2id hash of the operator password (see [Operator login](#operator-login)), in single quotes in `.env`. Never the plaintext. |
| `API_ORIGIN` | web (`/api` rewrite), validated by the API | An http(s) origin; target of the rewrite. See [Web `/api` proxy](#web-api-proxy). |
| `STUDIO_WEB_API_PROXY` | web (`next build`, `next start`) | Default unset (off). `true` opts a production build into the `/api` rewrite. See [Web `/api` proxy](#web-api-proxy). |

The API validates its environment with Zod at start-up (`apps/api/src/platform/config`) and exits with a list of the invalid variable names (never their values) instead of starting half-configured.

### Operator login

The Studio has one operator, who signs in with a password. The API stores only an Argon2id hash of it. Generate the hash locally:

```bash
pnpm --filter @agentic-studio/api run auth:hash-password   # type the password twice (hidden); prints the hash
```

Put the printed hash in `.env` as `STUDIO_OPERATOR_PASSWORD_HASH='$argon2id$...'` (single quotes). The API refuses to start without a valid Argon2id hash at the OWASP baseline or stronger. Then open http://localhost:3000/login.

- `POST /api/auth/login` `{ "password": "..." }` sets an HttpOnly session cookie. `GET /api/auth/session` reports the session. `POST /api/auth/logout` ends it.
- Every API route needs a session (401 problem+json without one) unless it is explicitly public: health and login.
- Mutations need `Origin: <STUDIO_ORIGIN>` (or `Sec-Fetch-Site: same-origin`) and a JSON body. A browser on the Studio origin does this by itself; with curl, add `-H "Origin: http://localhost:3000" -H "Content-Type: application/json"`.
- After 5 failed logins from one IP in 15 minutes, or 50 overall in an hour, login answers 429 with `Retry-After`. In local development all browser requests come through the `next dev` rewrite, so they share one IP.

Cookie, Origin, rate-limit and proxy rules are canonical in [`security.md` §8](docs/engineering/security.md).

### Projects

After signing in, the Studio home links to http://localhost:3000/projects, where the operator creates projects and sees them newest first. API (session required; `POST` also needs the Origin and JSON rules above):

- `POST /api/projects` `{ "name": "..." }`: the name is trimmed and internal whitespace runs collapse to one space (case kept); it must then be 1–100 characters. 201 `{ id, name, createdAt }`; 400 problem+json with a field error on `name`; 409 problem+json (field error on `name`) when another project has the same name ignoring case, enforced by a unique index on the lower-cased name.
- `GET /api/projects`: 200 `{ items: [...] }`, newest first (`createdAt`, then `id`); `items` is empty when there are no projects.

Code: `apps/api/src/modules/projects` (features `create-project` and `list-projects`, domain entity, value object and repository port, Prisma repository) and `apps/web/src/modules/projects` (create form and list), composed by `apps/web/src/app/(studio)/projects/page.tsx`.

### Start PostgreSQL and Redis

```bash
docker compose up -d     # PostgreSQL 18 and Redis 8 on 127.0.0.1
docker compose down      # stop; add -v to also delete the local data volumes
```

### Database migrations

The Prisma schema and migration history live in `packages/database/prisma/`.

```bash
pnpm db:migrate:deploy   # apply committed migrations (the same command CI and deployments use)
pnpm db:migrate:dev      # create a new migration from schema changes during development
```

The first committed migration is an intentionally empty baseline; business tables arrive with the slices that own them (`projects` is the first, Story #16). There is no `db push` or reset flow: migrations are reviewed, versioned code.

> **Warning: decline any reset.** When `prisma migrate dev` detects drift between the migration history and your local database, it offers to **reset the database, deleting all its data**. Answer no. To review the SQL before anything is applied, create the migration only: `pnpm db:migrate:dev --create-only`, read and commit `packages/database/prisma/migrations/<timestamp>_<name>/migration.sql`, then apply it with `pnpm db:migrate:deploy`.

### Run locally

```bash
pnpm dev
```

This first builds the workspace packages (`packages/*`, including `prisma generate`), then starts both apps in parallel:

| App | URL | Notes |
| --- | --- | --- |
| `apps/web` | http://localhost:3000 | Studio home with a link to the Projects page (http://localhost:3000/projects); without a session the browser is sent to `/login`. In `next dev`, `/api/*` is rewritten to the API, so the browser only talks to one origin (no CORS). |
| `apps/api` | http://localhost:3001/api | NestJS with the global `/api` prefix. `API_PORT` overrides the port. |

Check the API through the web origin:

```bash
curl -i http://localhost:3000/api/health         # 200 {"status":"ok"} (public)
curl -i http://localhost:3000/api/auth/session   # 401 problem+json until you sign in
```

If you run the API on another port or host, set `API_ORIGIN` for `apps/web` so the dev rewrite targets it (see below). Deployment routing is out of scope for now.

### Web `/api` proxy

The canonical rules for the web app's same-origin `/api/*` rewrite to the API (Issue #30 decision 3; implemented and unit-tested in `apps/web/next.config.ts`):

- **`next dev`** always rewrites, to `API_ORIGIN` or the default `http://localhost:3001`. `next dev` does not read the root `.env`; set `API_ORIGIN` in the shell when the API runs elsewhere.
- **Production (`next build`, `next start`)** rewrites only on the explicit opt-in `STUDIO_WEB_API_PROXY=true`, which then requires `API_ORIGIN`. `API_ORIGIN` alone does not enable it (the build logs a warning). `false` or unset means no rewrite.
- The rewrite is baked into the build: set both variables at build time, and the same values at start (the config is evaluated again). `pnpm e2e:smoke` does this.
- Any other flag value, `true` without `API_ORIGIN`, or an `API_ORIGIN` that is not a bare http(s) origin fails the build or start. The error names the variable, never its value.
- Behind this rewrite or any other proxy, list the proxy in the API's `API_TRUSTED_PROXIES`, or all clients share one login rate-limit bucket ([Security](docs/engineering/security.md) §8).

### Checks

```bash
pnpm check:api   # Prettier check, then ESLint, typecheck and build of apps/api and the packages it uses
pnpm check:web   # Prettier check, ESLint, TypeScript typecheck, production build of apps/web
pnpm test:api    # Vitest unit and integration tests of apps/api and the packages it uses (needs Docker)
pnpm test:web    # Vitest + React Testing Library tests of apps/web (jsdom)
pnpm architecture:api        # Architecture gate for apps/api
pnpm architecture:web        # Architecture gate for apps/web
pnpm architecture:monorepo   # Architecture gate for the apps/packages workspace graph
pnpm e2e:smoke   # Playwright smoke test against built apps, PostgreSQL and Redis (needs Docker; see below)
pnpm format      # Write Prettier formatting for the workspace
```

`pnpm test:api` builds `packages/*`, then runs Vitest in `apps/api` and `packages/testing`. Integration tests start throwaway PostgreSQL/Redis containers through `@agentic-studio/testing` (Testcontainers), so they need a running Docker daemon but neither Compose nor `.env`. Test conventions:

- Tests live next to the code in `__tests__/` folders and end in `.test.ts`; tests that need containers end in `.integration.test.ts`.
- HTTP tests build the app with `createApp(config)` from `apps/api/src/app.ts` (the same set-up as `main.ts`) and call it with Supertest. `testConfig()` in `apps/api/src/__tests__/test-config.ts` gives a complete config with placeholder values; tests that log in hash their own throwaway password. Auth tests (`platform/auth`) use a real Redis from `startRedis()`.
- Persistence tests use a real PostgreSQL from `startPostgres()` and apply the committed migrations with `deployMigrations()` from `@agentic-studio/database/migrations`; never a mocked ORM.
- HTTP tests of a business module through the whole app (PostgreSQL + Redis + login) use `startStudioServices()`, `startStudioApp()` and `signIn()` from `apps/api/src/__tests__/studio-test-app.ts` and live in `apps/api/src/__tests__/`: building the app reaches the database client, which `architecture:api` forbids for anything under a feature folder, tests included. Handler unit tests stay next to the feature and use an in-memory adapter of the repository port.

`pnpm test:web` runs Vitest in `apps/web` with a jsdom environment and React Testing Library. It follows the API conventions above: tests live in `__tests__/` next to the code and end in `.test.ts` or `.test.tsx`, and Vitest globals are off (import `describe`/`it`/`expect` from `vitest`). Feature tests render the real components with the real generated client and TanStack Query and fake the API at `fetch` (`vi.stubGlobal`); `vitest.setup.ts` resolves the client's relative `/api` URLs against the jsdom page URL, as a browser does.

`pnpm e2e:smoke` (`tests/e2e/run-smoke.mjs`) runs the walking-skeleton smoke test, the same way locally and in CI: it builds the packages, the API and the web app, starts throwaway PostgreSQL and Redis containers (Testcontainers, so it needs Docker but neither Compose nor `.env`), applies the migrations, generates a random throwaway operator password for the run (only its hash reaches the API; nothing is stored), starts the API on `127.0.0.1:4501` and the web app on http://localhost:4500 (`E2E_API_PORT` / `E2E_WEB_PORT` override them), runs Playwright (`tests/e2e/smoke.spec.ts`: login → create project → list → reload) and always stops the servers and containers. Install the browser once with `pnpm exec playwright install chromium`. Playwright output goes to the git-ignored `tests/e2e/test-results/`.

### Architecture gates

The rules of [`quality.md` §4](docs/engineering/quality.md) are enforced by three separate gates. Each one type-checks the gate code, then runs its Vitest project in `tests/architecture/`:

| Gate | Checks | Rules |
| --- | --- | --- |
| `pnpm architecture:api` | `apps/api/src` | Business modules import each other only through `contracts/`; `platform/` and `shared/` reach modules only through `contracts/`; only the composition root `src/app.module.ts` imports a `{module}.module.ts` (nothing under `src/modules/` does); a module contains only `features/`, `consumers/`, `domain/`, `ports/`, `infrastructure/`, `contracts/` and `<m>.module.ts`; `domain/` is free of NestJS, ORM, database, queue, HTTP, file-system/process and infrastructure code; `ports/` never import `infrastructure/`, `features/`, `consumers/`, `platform/database/`, the ORM or concrete clients; a module's `contracts/` never import its own `domain/`, `features/`, `consumers/`, `infrastructure/` or `ports/`, the ORM or concrete clients; features and consumers never import `infrastructure/`, the database client, Prisma or concrete queue/Redis/Docker/Git/process clients, directly or through any chain of re-exports (`reachable`); Prisma only in `infrastructure/repositories/`; relative imports resolve; no file or module cycles; a feature folder has a `handler.ts`; `infrastructure/` files live in `repositories/` or `adapters/`. |
| `pnpm architecture:web` | `apps/web/src` | Modules and `app/` use another module only through its `index.ts`; modules never import `app/`; `platform/` never imports `modules/` or `app/` (modules and `app/` may import `platform/`, e.g. the API client); `shared/` imports none of `modules/`, `app/`, `platform/`; no server, ORM, privileged or Node-only server imports; only `platform/api/` imports `platform/api/generated/`; relative and `@/` imports resolve; no file or module cycles (the generated API client is exempt only from the cycle rules, for cycles between its own files). |
| `pnpm architecture:monorepo` | `apps/*`, `packages/*` | No app-to-app imports (including `agent-worker` and `environment-controller` once they exist); packages never import apps; other code reaches a package only by its `@agentic-studio/*` name, never a relative path; web never imports server packages (every `packages/*` package must be classified as web-allowed or web-forbidden); every `@agentic-studio/*` import resolves; no file or package cycles; the same rules on `package.json` dependencies. |

Dependency rules use [Dependency Cruiser](https://github.com/sverweij/dependency-cruiser) (`tests/architecture/*/gate.ts`); folder rules are Vitest assertions. Each gate checks the whole graph of its real tree and then its fixtures in `tests/architecture/fixtures/<gate>/`: every fixture must produce exactly its expected PASS or FAIL rules, every rule needs at least one FAIL fixture, and every [`quality.md` §5](docs/engineering/quality.md) row has its fixture. A change to a rule therefore needs a matching fixture. Fixtures are not production code: they sit outside every app, so no app build, lint or typecheck includes them.

Not enforced yet, tracked in [#22](https://github.com/urb-software/AgenticStudio/issues/22) (no code exists for them, and each needs a convention decided first): versioned, publisher-owned integration event definitions and no duplicate event definitions; repository contracts only in `domain/repositories/` and read ports only in `ports/`. The gate code in `tests/architecture/` is type-checked by each gate and formatted by `pnpm format:check`, but not linted.

The other target scripts in [`quality.md` §8](docs/engineering/quality.md) (`test:contracts`, `check:affected`) are **not implemented yet**.

### REST contracts (Zod → OpenAPI → client)

Feature Zod schemas are the single source of truth for HTTP payloads:

```text
Zod schema + createZodDto (apps/api)
  → nestjs-zod + @nestjs/swagger → apps/api/openapi.json (OpenAPI 3.1, committed)
  → @hey-api/openapi-ts → apps/web/src/platform/api/generated/ (Fetch client, committed)
```

```bash
pnpm contracts:generate   # build the API, write openapi.json offline (no server, no database), regenerate the client
pnpm contracts:check      # regenerate, then fail if openapi.json or the generated client differs from the committed version
```

- Run `pnpm contracts:generate` after changing a request or response schema, and commit `apps/api/openapi.json` and `apps/web/src/platform/api/generated/` with the change. Never edit generated files by hand.
- The generator also emits Zod schemas of the payloads (`generated/zod.gen.ts`). Forms use them, through `platform/api`, as client-side hints only (e.g. `createProjectRequestHint`); the API applies the full rules and its 400/409 field errors are final.
- A deliberate 4xx about specific fields (e.g. 409 for a taken project name) throws `FieldProblemException` (`apps/api/src/platform/http/problem-details.ts`), so its problem details carry `errors[]` like a 400.
- The web app imports the client only from `apps/web/src/platform/api` (its public entry point), never from `generated/`.
- Request bodies are validated by the global `ZodValidationPipe`; responses declared with `@ZodResponse` are validated and stripped by the global `ZodSerializerInterceptor`.
- Every API error is RFC 9457 `application/problem+json` (`type`, `title`, `status`, `detail`, `correlationId`, optional `errors[]` of `{ path, message }`; `path` uses dot notation such as `tags.1` for React Hook Form `setError`). 5xx responses are generic; their cause is logged server-side under the `correlationId`. The `ProblemDetails` schema is the documented `default` response of every operation.
- `nestjs-zod@5.6.0` does not yet declare NestJS 12 peers. A scoped `peerDependencyRules` entry in `pnpm-workspace.yaml` allows it until upstream support lands (#19); the validation, OpenAPI and determinism tests guard the combination.

### Continuous integration

`.github/workflows/ci.yml` runs on every pull request to `dev` (opened, synchronized, reopened) and on every push to `dev`. A newer push to a PR cancels its superseded run. The workflow has a read-only token, uses no secrets, never uses `pull_request_target`, and pins every action by commit SHA.

| Check (job name) | Runs |
| --- | --- |
| `changes` | `node --test "scripts/ci/*.test.mjs"`, then classifies the changed files with `scripts/ci/ci-policy.mjs` |
| `quality:api` | `pnpm check:api` |
| `quality:web` | `pnpm check:web`, then `pnpm format:check` (the whole repository) |
| `architecture:api` / `architecture:web` / `architecture:monorepo` | `pnpm architecture:api` / `architecture:web` / `architecture:monorepo` |
| `test:api` | `pnpm test:api` (Testcontainers PostgreSQL and Redis on the runner's Docker) |
| `test:web` | `pnpm test:web` |
| `test:contracts` | `pnpm contracts:check` |
| `e2e:smoke` | `pnpm exec playwright install --with-deps chromium`, then `pnpm e2e:smoke` (throwaway PostgreSQL and Redis via Testcontainers, random per-run operator password) |
| `security` | `pnpm audit --audit-level high` over all dependencies |
| `ci:required` | Always runs; the aggregate the `dev` ruleset requires |

- Jobs run on `ubuntu-24.04` with Node.js 24 and the pnpm version from `packageManager`. Linux CI is authoritative: a check that passes only on Windows is a bug.
- **Docs-only PRs.** The workflow always triggers. A PR is docs-only when every changed file (both sides of a rename) is under `docs/`, `.claude/skills/` or is a root `*.md` file; then the code jobs (every job above except `changes` and `ci:required`, including `security`) are skipped. Skipping the audit is safe because dependency files (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`) are never docs-only, and the post-merge run on `dev` always audits. Any other file, including anything in `.github/`, configuration, scripts, tests or the lockfile, runs every job. Pushes to `dev` always run every job.
- **`ci:required`** passes only when `changes` succeeded and every code job succeeded, or, for a docs-only PR, every code job was skipped. A failed, cancelled or wrongly skipped job makes it red. A new job must be added to `CODE_JOBS` in `scripts/ci/ci-policy.mjs` as well as to the `ci:required` `needs`; an unknown job fails the check. A policy test reads `ci.yml` and fails when `ci:required` `needs` and `CODE_JOBS` differ, when any job escapes `ci:required`, or when a job's `name:` is not its `quality.md` §7 check name.
- **`security`.** Audit exceptions go only in `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml`, each with a reason and a review date (Epic #8 decision 5). Prefer a patched version (a scoped `overrides` entry with the GHSA IDs, a reason, a review date and a tracking Issue, as for `js-yaml` under `@hey-api/json-schema-ref-parser`) over an exception.
- Run the policy tests locally with `node --test "scripts/ci/*.test.mjs"`.

## Working agreement

- GitHub Issues are the operational backlog. A User Story is normally integrated through one PR to `dev`; independent Technical Tasks may have their own PRs.
- Work in isolated branches/worktrees. Never merge or deploy without the required approval.
- Done means: relevant DoD checks, independent review, required CI, and post-merge verification are all satisfied.
- Documentation is in English. The repository documents are the canonical coding rules; Notion records the architectural decision history.

## Architectural decision history

Consolidated from project discussions and Notion decision records. Newer approved decisions supersede historical examples in the parent page:

- [Architecture decision hub (Notion)](https://app.notion.com/p/3fad4d814eb0817a9ba8c264625b4faa)
- [Frontend architecture](https://app.notion.com/p/412d4d814eb0818596d2dff8e7b2a136)
- [Walking Skeleton & Vertical Slices](https://app.notion.com/p/412d4d814eb081bdbe62c0d76b1c2d4b)
- [Guardrails & testing](https://app.notion.com/p/413d4d814eb0819499faecf3fe7f4afe)
- [GitHub Issues & PR workflow](https://app.notion.com/p/413d4d814eb08175b243ca84f1191271)
