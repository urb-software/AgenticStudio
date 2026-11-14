# AI Agent Studio — MVP Product Scope

**Status:** product-level baseline for backlog refinement; not a fully approved set of detailed User Stories or APIs.

## 1. Product intent

A **private, self-hosted AI coding workspace** for one human operator: manage software projects and agent definitions, run coding tasks through official Claude Code / Codex CLIs, inspect generated code changes, and preview integrated results on a VPS.

It is **not** a public SaaS, a model provider, or a replacement for the native CLI tools. Provider-native file/configuration formats are preserved where supported.

## 2. User and desired outcome

**Primary user:** a single authenticated operator/developer who controls projects, credentials, agent definitions, execution approvals, Git integration, and Preview environments. Story 1 uses simple password/session auth; OAuth, additional operators and roles are deferred.

**Desired end-to-end outcome:**

1. Create or connect a software project and its Git repository.
2. Define or import agent configurations and reusable skills; select approved MCP integrations.
3. Describe a task or compose an initial workflow.
4. Execute a CLI-backed agent in an isolated working copy and branch.
5. Observe execution status, logs, errors, and results.
6. Review diff/tests and explicitly approve changes.
7. Merge approved changes into the project's integration branch (default `dev`).
8. See the updated **single shared Preview** for that project.

This is a **capability roadmap**; not all of it belongs in the first implemented story.

## 3. Six business modules (approved architecture)

| Module | Product responsibility |
| --- | --- |
| `projects` | Projects, repository connection, Git branches/working copies, diff, review, approval, merge |
| `agents` | Agent and skill definitions, assignment, file/Git-first editing, validation, publication |
| `workflows` | Definition, steps, sequencing, orchestration, human approvals |
| `executions` | Runs, queueing, cancellation, status, logs, results |
| `environments` | Project Compose stack lifecycle and one shared Preview per project |
| `mcp` | Reusable MCP server registry/configuration, project/agent bindings, basic connection management |

Agent and skill definitions are separate domain models *within* `agents`; MCP is its own module; Git stays within `projects`.

## 4. Intended MVP capabilities

- A Next.js Studio UI for projects, agents/skills, workflows, executions, environments, and MCP management.
- PostgreSQL for application state; Redis + BullMQ for queued jobs; a separate worker process for CLI execution.
- REST for commands/queries; SSE for progress/logs.
- Initial workflow orchestration centered on a **small sequential flow and human approval**; advanced branching/parallelism may be deferred.
- Native CLI definitions where practical; immutable approved configuration snapshots for runs.
- Per-run working copies/branches and controlled merge of reviewed changes.
- Docker Compose environments controlled by a separate, narrowly privileged process, with one shared Preview built from the project's integration branch (default `dev`) after merge.
- Secret storage outside Git and minimal access to external tools.

Every capability needs its own refined GitHub Issue and acceptance criteria before implementation.

## 5. Explicit non-goals for the first MVP

- Multi-tenant SaaS, public API for external teams, billing, role-heavy organization model.
- Production/staging deployment pipeline and unrestricted autonomous deployments.
- Full MCP gateway/proxy, generic tool-execution proxy, or broad third-party marketplace.
- GPU-based model hosting/training.
- MicroVM sandboxes as a **mandatory** MVP dependency (may be considered later).
- Advanced visual workflow parallelism, arbitrary graph scripting, elaborate orchestration frameworks.
- A full event-sourced system, separate CQRS databases, or microservices per domain module.
- API-based or SDK-based agent runners; the MVP uses official CLI binaries only (see [Security](../engineering/security.md) §2).

## 6. Success criteria to refine into GitHub User Stories

The MVP demonstrates that an operator can complete the end-to-end cycle with controlled permissions and a recoverable execution history. Evidence: functional tests, architecture checks, integration tests, meaningful failures, and a working Preview after approval.

**The first implemented vertical slice is deliberately smaller:** create a project through the UI, persist it, list it, and verify the request across Next.js → NestJS → PostgreSQL. See [Walking Skeleton](walking-skeleton.md).

## 7. Unresolved decisions — turn into refinement/Technical Tasks

- Validate CLI terms, authentication and headless use for **each** provider (tasks B6/B7); automated execution stays disabled per provider until then (acceptance gate in [Security](../engineering/security.md) §2).
- Confirm VPS hardware, isolation model, networking, and how agent/provider credentials are managed before enabling real agent execution. Studio's own secret store is decided in [ADR 0001](../architecture/adr/0001-secret-store.md).
- **Decided** (Epic #55): Git access strategy and credential scope. Private Repositories use a per-project SSH Deploy key, public ones anonymous HTTPS; no tokens and no host credentials. See [Security](../engineering/security.md) §3–§4 and [ADR 0001](../architecture/adr/0001-secret-store.md). Protecting connected Repositories and their integration branches on push and merge is refined with the merge capability.
- Refine exact workflow step semantics and human approval model.
- Specify baseline project schema, auth/session strategy, API contracts, and Preview exposure only when the relevant slice begins.
- Agree on frontend state-library versions/policy before installing them in feature code.
- Prioritize the initial User Story Map and define DoR-compliant GitHub Issues.

## 8. Product delivery strategy

**Walking Skeleton + Vertical Slices.** GitHub Issues are the authoritative work items; separate Issues may cover independent technical foundations. Deliver the first usable end-to-end scenario before building out six entire modules.

Decision provenance: [Notion architecture hub](https://app.notion.com/p/3fad4d814eb0817a9ba8c264625b4faa) and [development process](https://app.notion.com/p/412d4d814eb081bdbe62c0d76b1c2d4b).
