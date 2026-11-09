# Frontend Architecture — Next.js / Feature-First

**Status:** Modular Frontend and Clean Boundaries are the accepted direction. The precise library selection for shared client state was strongly recommended but not finally locked in the decision record; confirm before adding dependencies during implementation.

## 1. Architecture

- **Next.js App Router + TypeScript + shadcn/ui**.
- **Modular Frontend + Feature-First + Clean Boundaries**, not a full backend-style Clean Architecture with `domain/application/infrastructure/presentation` repeated in every UI module.
- One app, **not** microfrontends. Organize code around features and user interactions, not technical folders spread across the whole app.
- NestJS owns business use cases, persistence, validation of permissions and authorization. Next.js owns routing, presentation, editor interactions and API integration.

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

The routing hierarchy is **not** the module hierarchy: `/skills` belongs to `agents`, and `/projects/:id/preview` can present the `environments` module in a project context.

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

Keep feature-specific hooks, tests, UI elements and schema near the feature. Do not force empty folders or a store in every feature.

## 3. Clean Boundaries

- Other modules consume **public exports** from `modules/{module}/index.ts` or another explicit public entrypoint; private deep imports are forbidden.
- Recommended dependency direction: `app → modules → platform/shared`; `platform → shared`; `shared` must not depend on business modules.
- Feature-to-feature imports inside a module should be controlled, with truly shared UI moved to that module's `components/` only when useful.
- Do not import another module's private store, hook, data repository, or editor internals.
- Frontend does not import server app implementation code, raw ORM entities, secret access, CLI controls or controller internals.
- **Selected client tooling:** emit OpenAPI 3.1 from NestJS `nestjs-zod`/`@nestjs/swagger`, then generate the typed Fetch client with `@hey-api/openapi-ts` into `apps/web/src/platform/api/generated/`. Do not import backend implementation code or maintain handwritten copies of API DTOs.
- Keep one configure-once wrapper around the generated client for `/api` base URL, session credentials (`credentials: 'include'` when needed), typed errors and request tracing. Generation and drift checks are Technical Tasks that must exist before Story 1.
- A Studio Shell may aggregate navigation, breadcrumbs, notifications and global run indicators without breaking module ownership.

## 4. State ownership policy

The goal is **one source of truth per piece of state**, not a single global store.

| Kind of state | Recommended owner | Examples |
| --- | --- | --- |
| API/server state | **TanStack Query** | Project lists, agents, saved workflow definitions, execution metadata |
| Shared client/editor draft state | **Zustand**, scoped to feature/editor instance | Workflow nodes/edges, selection, undo/redo, unsaved draft |
| Simple one-component UI state | React `useState` / `useReducer` | Dropdown, local disclosure |
| Form values/errors | **React Hook Form + Zod** | Create Project, Agent config, MCP form |
| Shareable navigation state | Next.js URL/search params | Filters, pagination, deep links |
| Live status/logs | SSE + appropriate cache update or bounded local buffer | Job progress and log stream |

**Do not store a second editable copy of API state in Zustand** unless it represents an explicit unsaved draft. Avoid mirroring form values from React Hook Form into another store. If a feature needs shared client state, use one consistent store convention; do not alternate ad hoc between Context, Redux and Zustand. Scope mutable editor stores to a client-side provider/editor instance to avoid cross-request leakage.

**Decision note:** the responsibility model is settled; TanStack Query + Zustand-first for shared client state + React Hook Form is our recommended implementation baseline. Confirm versions and final library adoption when adding those dependencies.

## 5. Editors and drafts

- **React Flow** for workflow graph editing; the backend owns its own stable workflow definition model, independent of the React Flow presentation schema.
- **Monaco** for agent/skill definitions, with validation and explicit publish semantics.
- Load heavyweight editors lazily only on relevant routes.
- Preferred lifecycle: `Load saved version → edit isolated draft → validate → save → publish`.
- Never overwrite an unsaved draft during a background API refetch. New execution runs should use an approved immutable configuration snapshot, not changing editor buffers.

## 6. Next.js Server/Client boundaries

- Use Server Components for appropriate page/layout composition and low-interaction rendering; isolate interactive workflows/forms/editors as Client Components.
- Never expose secrets or backend privileged implementations to Client Components; verify with static rules and production builds.
- Do not reimplement business rules in Server Actions or create a second domain layer in the web app.
- Ensure previewed user code is rendered on a separate, isolated origin without Studio session cookies/access.

## 7. Communication & resilience

- REST for CRUD/commands/queries, SSE for logs/progress. WebSocket is not the default MVP choice.
- Centralized typed generated API client, consistent errors, timeouts, and auth/session behavior; backend remains the authorization source of truth.
- **Auth baseline:** a dedicated login page uses `POST /api/auth/login`; session state is checked through `GET /api/auth/session`; `POST /api/auth/logout` invalidates it. The browser keeps an opaque session cookie only (HttpOnly; never localStorage/sessionStorage tokens). Studio UI and `/api` use the same public origin through a trusted proxy; protect mutating operations against CSRF, and never let Preview share the Studio's admin cookie origin.
- SSE reconnects recover authoritative state from a REST query; do not rely on an in-memory log stream as the sole audit record.
- UI should show failures clearly and handle partial/long-running execution states.

## 8. Frontend quality gates

- Vitest + React Testing Library: forms, components, feature interactions, hooks.
- Playwright: meaningful user journeys (especially critical UI→API→DB slices).
- Automated accessibility checks and keyboard/navigation basics for changed UI.
- `architecture:web`: public entrypoint imports, layer direction, no cycles or private cross-module stores, server/client boundaries, structural feature-first conventions.
- Format, ESLint/React hook rules, strict TypeScript, build, relevant tests must pass before merge.

See [Quality](../engineering/quality.md) and [Security](../engineering/security.md).

Decision provenance: [Frontend architecture on Notion](https://app.notion.com/p/412d4d814eb0818596d2dff8e7b2a136).
