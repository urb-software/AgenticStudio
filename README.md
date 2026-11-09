# AI Agent Studio

A private, self-hosted workspace for defining coding agents and skills, orchestrating Claude Code and Codex CLI tasks, reviewing Git changes, and previewing integrated project changes.

> **Status: architecture and SDLC bootstrap.** The documents describe the agreed target design; they do **not** imply that the application, CI, security controls, or CLI integrations are already implemented. This repository will be built incrementally through GitHub Issues.

## What we are building

The MVP is designed for **one human operator** and supports the journey:

**Project → Agent/Skills → Workflow/Execution → Logs → Git Review & Approval → Merge to `dev` → Shared Project Preview**.

The planned backend is a NestJS modular monolith with six business modules: `projects` (including Git), `agents` (including skills), `workflows`, `executions`, `environments`, and `mcp`. A Next.js UI exposes those capabilities. Separate worker and environment-controller processes perform constrained operations.

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

No GPU is required by the proposed architecture. Advanced sandboxing (microVMs), external-tenant APIs, and a full MCP gateway are outside the initial MVP.

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

The authoritative architecture and contributor instructions are located in this repository:

- [Agent instructions](AGENTS.md) and [Claude Code entry point](CLAUDE.md)
- [MVP scope](docs/product/mvp.md) and [first walking skeleton](docs/product/walking-skeleton.md)
- [System architecture](docs/architecture/system.md), [backend](docs/architecture/backend.md), and [frontend](docs/architecture/frontend.md)
- [Quality & test guardrails](docs/engineering/quality.md) and [security guardrails](docs/engineering/security.md)
- [Repository bootstrap and Story 1 readiness](docs/engineering/bootstrap-plan.md) and [Agent roles](docs/engineering/agent-roles.md)

If the English SDLC template pack is installed, also consult:

- `docs/engineering/definition-of-ready.md`
- `docs/engineering/definition-of-done.md`
- `docs/engineering/issue-workflow.md`
- `docs/templates/implementation-handoff.md` and `docs/templates/review-report.md`
- `.github/ISSUE_TEMPLATE/` and `.github/pull_request_template.md`

## Getting started

**Before scaffolding:** initialize a first commit on `main`; create and push `dev` and set it as the **GitHub default branch**. Add the P0 documents and the English SDLC v3 templates on `dev`. Then create independent Technical Tasks for monorepo, Prisma/PostgreSQL/Redis, minimal operator auth, REST contract code generation, architecture checks and CI. Follow the exact [bootstrap order](docs/engineering/bootstrap-plan.md).

**After scaffolding:** replace this section with tested installation, setup, environment-variable, database-migration, and local start commands. **Do not invent commands that do not yet exist.** The expected monorepo package manager is `pnpm`, pending implementation.

## Working agreement

- GitHub Issues are the operational backlog. A User Story is normally integrated through one PR to `dev`; independent Technical Tasks may have their own PRs.
- Work in isolated branches/worktrees. Never merge or deploy without the required approval.
- A change is done only when the relevant DoD checks, independent review, required CI, and post-merge verification are satisfied.
- Keep documentation in English. The repository documents are the canonical coding rules; Notion records the architectural decision history.

## Architectural decision history

These documents were consolidated from the project discussions and Notion decision records. Newer approved decisions supersede historical examples in the parent page:

- [Architecture decision hub (Notion)](https://app.notion.com/p/3fad4d814eb0817a9ba8c264625b4faa)
- [Frontend architecture](https://app.notion.com/p/412d4d814eb0818596d2dff8e7b2a136)
- [Walking Skeleton & Vertical Slices](https://app.notion.com/p/412d4d814eb081bdbe62c0d76b1c2d4b)
- [Guardrails & testing](https://app.notion.com/p/413d4d814eb0819499faecf3fe7f4afe)
- [GitHub Issues & PR workflow](https://app.notion.com/p/413d4d814eb08175b243ca84f1191271)
