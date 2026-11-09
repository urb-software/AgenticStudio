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

## Repository layout (target, not yet scaffolded)

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

**Before scaffolding:** initialize a first commit on `main`; create and push `dev` and set it as the **GitHub default branch**. All further changes, including the English SDLC v3 templates, land on `dev` through PRs. Then create independent Technical Tasks for monorepo, Prisma/PostgreSQL/Redis, minimal operator auth, REST contract code generation, architecture checks and CI. Follow the exact [bootstrap order](docs/engineering/bootstrap-plan.md).

**After scaffolding:** replace this section with tested installation, setup, environment-variable, database-migration, and local start commands. **Do not invent commands that do not yet exist.** Expected package manager: `pnpm`, pending implementation.

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
