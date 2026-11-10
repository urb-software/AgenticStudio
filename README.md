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

## Repository layout (target; only `apps/api` and `apps/web` exist so far)

```text
apps/
  web/                     # Next.js UI
  api/                     # NestJS modular monolith
  agent-worker/            # Background execution; no Docker socket
  environment-controller/  # Narrow, authorized Compose operations
packages/
  contracts/               # Only when cross-process contracts need extraction
  database/
  testing/
infra/
  compose.yaml
```

## Documentation

- [Agent instructions](AGENTS.md) and [Claude Code entry point](CLAUDE.md)
- Product: [MVP scope](docs/product/mvp.md), [first walking skeleton](docs/product/walking-skeleton.md)
- Architecture: [system](docs/architecture/system.md), [backend](docs/architecture/backend.md), [frontend](docs/architecture/frontend.md)
- Guardrails: [quality & tests](docs/engineering/quality.md), [security](docs/engineering/security.md)
- Bootstrap: [repository bootstrap and Story 1 readiness](docs/engineering/bootstrap-plan.md), [agent roles](docs/engineering/agent-roles.md)
- SDLC: `docs/engineering/definition-of-ready.md`, `definition-of-done.md`, `issue-workflow.md`; `docs/templates/implementation-handoff.md`, `review-report.md`; `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`

## Getting started

The repository bootstrap follows the [bootstrap order](docs/engineering/bootstrap-plan.md). So far only the pnpm workspace with `apps/api` (NestJS) and `apps/web` (Next.js App Router) exists; database, auth, contracts, architecture checks and CI arrive in later Technical Tasks. Add their setup commands here when they land. **Do not invent commands that do not yet exist.**

### Prerequisites

- Node.js 24 LTS (`engines.node` is `>=24.0.0 <25`; pnpm refuses other versions because `engineStrict` is on).
- pnpm 11, exactly the version in `packageManager` (`pnpm@11.22.0`). With Corepack: `corepack enable`.

### Install

```bash
pnpm install --frozen-lockfile
```

### Run locally

```bash
pnpm dev
```

This starts both apps in parallel:

| App | URL | Notes |
| --- | --- | --- |
| `apps/web` | http://localhost:3000 | Placeholder Studio page. In `next dev`, `/api/*` is rewritten to the API, so the browser only talks to one origin (no CORS). |
| `apps/api` | http://localhost:3001/api | NestJS with the global `/api` prefix. `PORT` overrides the port. |

Check the API through the web origin:

```bash
curl -i http://localhost:3000/api/health   # 200 {"status":"ok"}
```

If you run the API on another port or host, set `API_ORIGIN` (default `http://localhost:3001`) for `apps/web` so the dev rewrite targets it. The rewrite is active in `next dev` only; deployment routing is out of scope for now.

### Checks

```bash
pnpm check:api   # Prettier check, ESLint, TypeScript typecheck, production build of apps/api
pnpm check:web   # Prettier check, ESLint, TypeScript typecheck, production build of apps/web
pnpm format      # Write Prettier formatting for the workspace
```

The other target scripts in [`quality.md` §8](docs/engineering/quality.md) (`test:*`, `architecture:*`, `test:contracts`, `check:affected`) are **not implemented yet**.

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
