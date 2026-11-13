# Frontend Architecture — Next.js / Feature-First

**Status:** Modular Frontend and Clean Boundaries are the accepted direction. The library selection for shared client state is strongly recommended but not finally locked; confirm before adding dependencies.

## 1. Architecture

- **Next.js App Router + TypeScript + shadcn/ui**.
- **Modular Frontend + Feature-First + Clean Boundaries**, not a backend-style Clean Architecture with `domain/application/infrastructure/presentation` repeated in every UI module.
- One app, **not** microfrontends. Code is organized around features and user interactions, not app-wide technical folders.
- NestJS owns business use cases, persistence, permission validation and authorization. Next.js owns routing, presentation, editor interactions and API integration.

## 2. Target structure

```text
apps/web/src/
  app/
    (auth)/login/
    (studio)/
      layout.tsx
      projects/
      agents/
      skills/
      workflows/
      executions/
      mcp/
      settings/
  modules/
    projects/        # includes Git UI
    agents/          # includes agent + skill UI
    workflows/
    executions/
    environments/    # e.g. project Preview screens
    mcp/
  platform/
    api/             # typed HTTP client
    auth/
    realtime/        # SSE lifecycle
    query/           # TanStack Query infrastructure, if adopted
  shared/
    ui/              # shadcn/ui primitives
    components/
    hooks/
    lib/
```

The routing hierarchy is **not** the module hierarchy: `/skills` belongs to `agents`, and `/projects/:id/preview` can present `environments` in a project context.

### Feature example

```text
modules/agents/
  features/
    agent-list/
    agent-editor/
    skill-list/
    skill-editor/
    skill-assignment/
  components/
  api/
  index.ts          # intentional public API
```

Feature-specific hooks, tests, UI elements and schema live near the feature. No forced empty folders, no store in every feature.

## 3. Clean Boundaries

- Other modules consume **public exports** from `modules/{module}/index.ts` or another explicit public entrypoint; private deep imports are forbidden.
- Dependency direction: `app → modules → platform/shared`; `platform → shared`; `shared` never depends on business modules.
- Feature-to-feature imports inside a module are controlled; truly shared UI moves to that module's `components/` only when useful.
- Never import another module's private store, hook, data repository, or editor internals.
- Frontend never imports server app implementation code, raw ORM entities, secret access, CLI controls or controller internals.
- **Client tooling:** NestJS emits OpenAPI 3.1 (`nestjs-zod`/`@nestjs/swagger`); `@hey-api/openapi-ts` generates the typed Fetch client into `apps/web/src/platform/api/generated/`. No handwritten copies of API DTOs.
- **Form hints:** forms validate with the generated Zod schemas as hints; the API stays authoritative. Zod counts string lengths in code points, like the API and PostgreSQL. A rule OpenAPI cannot express, such as the API's input normalization (project names: NFC, trim, whitespace collapse), may be mirrored in the feature as one small, commented function that only feeds the hint, and is never a second source of the rule.
- One configure-once wrapper around the generated client handles the `/api` base URL, session credentials (`credentials: 'include'` when needed), typed errors and request tracing. Generation and drift checks are Technical Tasks that must exist before Story 1.
- A Studio Shell may aggregate navigation, breadcrumbs, notifications and global run indicators without breaking module ownership.

## 4. State ownership policy

**One source of truth per piece of state**, not a single global store.

| Kind of state | Recommended owner | Examples |
| --- | --- | --- |
| API/server state | **TanStack Query** | Project lists, agents, saved workflow definitions, execution metadata |
| Shared client/editor draft state | **Zustand**, scoped to feature/editor instance | Workflow nodes/edges, selection, undo/redo, unsaved draft |
| Simple one-component UI state | React `useState` / `useReducer` | Dropdown, local disclosure |
| Form values/errors | **React Hook Form + Zod** | Create Project, Agent config, MCP form |
| Shareable navigation state | Next.js URL/search params | Filters, pagination, deep links |
| Live status/logs | SSE + appropriate cache update or bounded local buffer | Job progress and log stream |

- **No second editable copy of API state in Zustand** unless it is an explicit unsaved draft.
- Do not mirror React Hook Form values into another store.
- Shared client state uses one consistent store convention; no ad hoc mix of Context, Redux and Zustand.
- Scope mutable editor stores to a client-side provider/editor instance to avoid cross-request leakage.

**Decision note:** the responsibility model is settled. TanStack Query + Zustand-first for shared client state + React Hook Form is the recommended baseline; confirm versions and final adoption when adding those dependencies.

## 5. Editors and drafts

- **React Flow** for workflow graph editing; the backend owns a stable workflow definition model independent of the React Flow presentation schema.
- **Monaco** for agent/skill definitions, with validation and explicit publish semantics.
- Heavyweight editors load lazily, only on relevant routes.
- Lifecycle: `Load saved version → edit isolated draft → validate → save → publish`.
- A background API refetch never overwrites an unsaved draft. New execution runs use an approved immutable configuration snapshot, not changing editor buffers.

## 6. Next.js Server/Client boundaries

- Server Components for page/layout composition and low-interaction rendering; interactive workflows/forms/editors are isolated Client Components.
- Never expose secrets or backend privileged implementations to Client Components; verify with static rules and production builds.
- No business rules in Server Actions and no second domain layer in the web app.
- Previewed user code renders on a separate, isolated origin without Studio session cookies/access.

## 7. Communication & resilience

- REST for CRUD/commands/queries, SSE for logs/progress. WebSocket is not the default MVP choice.
- Centralized typed generated API client with consistent errors, timeouts, and auth/session behavior; the backend remains the authorization source of truth.
- **Auth baseline:** a dedicated login page uses the `/api/auth/login`, `/session` and `/logout` endpoints; server-side rules are canonical in [Security](../engineering/security.md) §8. On the browser side: only an opaque HttpOnly session cookie (never localStorage/sessionStorage tokens), same origin as `/api`, and Preview never shares the Studio's admin cookie origin.
- SSE reconnects recover authoritative state from a REST query; an in-memory log stream is never the sole audit record.
- The UI shows failures clearly and handles partial/long-running execution states.

## 8. Frontend quality gates

- Vitest + React Testing Library: forms, components, feature interactions, hooks.
- Playwright: meaningful user journeys (especially critical UI→API→DB slices).
- Automated accessibility checks and keyboard/navigation basics for changed UI.
- `architecture:web`: public entrypoint imports, layer direction, no cycles or private cross-module stores, server/client boundaries, structural feature-first conventions.
- Format, ESLint/React hook rules, strict TypeScript, build and relevant tests pass before merge.

See [Quality](../engineering/quality.md) and [Security](../engineering/security.md).

Decision provenance: [Frontend architecture on Notion](https://app.notion.com/p/412d4d814eb0818596d2dff8e7b2a136).
