---
status: accepted
date: 2026-11-17
---

# Each API module has clean-architecture layers at the top and vertical slices inside the application layer

Decided by the operator in the refinement of Epic #160, 2026-11-17, after a review of the API on 2026-11-16 and 2026-11-17. The code obeyed every written rule, but several things had drifted because no rule covered them: seventeen imports from one feature into another inside `projects` and `executions`; shared logic filed as a feature (Deploy keys); entry points filed as features (the repository job dispatcher, a timer); application logic placed in `domain/services/`; and entities written as plain data shapes, with business rules enforced inside the database adapter (the Run store has about thirty-five business-named methods and over a thousand lines).

Each business module therefore has four layers at the top, `application/`, `domain/`, `entry-points/` and `infrastructure/`, plus `contracts/` as its public face. The vertical slices (one folder per use case, each with its handler and tests) live inside `application/features/`. Everything that receives outside input lives in `entry-points/`, is thin, and calls a handler. Behaviour lives on the domain object it is about. Thirteen rules, recorded in [Backend](../backend.md) §2 and §3, state how the layout is used; [Quality](../../engineering/quality.md) §5 states how each is enforced.

## Context

- **Vertical slices alone did not stop sharing between slices.** With the endpoint, handler and schema together in one folder, a feature that needed something from another feature simply imported it, and nothing said that was wrong.
- **Entry points had no home.** Job processors, schedulers and start-up routines were filed as features because the layout offered only `features/` and `consumers/`.
- **Entities held no behaviour.** Business rules ended up in handlers and in the database adapter, where the domain tests cannot reach them without a database.
- **Four more business modules are still to be built.** They start under these rules, so the cost of the conversion is paid once, for two modules.

## Decision

- **Layers at the top, slices inside the application layer.** `application/` (features, ports, rare named collaborators), `domain/` (entities, value objects, repository interfaces), `entry-points/` (HTTP, jobs, schedulers, start-up, consumers), `infrastructure/` (adapters, repository implementations), and `contracts/` (`index.ts` and `events/` only).
- **The first nine rules** ([Backend](../backend.md) §3): features are independent; entry points call handlers and handlers never call each other; shared application logic follows six ordered steps; behaviour lives on the object it is about; there is no `domain/services/`; the domain receives facts and never fetches them; validation has two homes; `contracts/` is a module's public face; the same role takes the same form.
- **Rules 10 to 13, added the same day after a second review of the code:**
  - **Handlers own their input and result** (10): each handler declares its own input and result types and returns plain data (snapshots, ids, values, view types); an entity class never leaves the application layer and a handler never builds an HTTP shape.
  - **One aggregate root, one file, one repository** (11): anything with its own repository is a root in `domain/entities/`; a repository interface serves exactly one root.
  - **Aggregates refer to each other by id** (12): a root never holds or loads another; facts from another aggregate arrive as values.
  - **One concept per file** (13): an entity file holds the class only; value objects, errors and fact types have their own files; `domain/` exports no loose functions other than type guards; no line limit.
- **Shared HTTP shapes move.** A response shape or problem used by several endpoints of one module lives in `entry-points/http/shared/`. This replaces the decision on Issue #30 that placed it in `contracts/http/`; the `contracts/http/` item of Issue #37 is superseded by it.
- **Every rule states how it is enforced** (gate check, pinned test, or review only), and a new gate check lands in the ticket that makes the code pass it, with a passing and a failing fixture.

## Considered Options

- **HTTP endpoints kept inside feature folders** (the previous layout): the endpoint, handler and schema stay together and a feature is one folder to read. But it left no place for the entry points that are not HTTP, and it let the HTTP layer and the application layer share a folder, so a handler could import HTTP types and one feature's endpoint could import another's. Not chosen.
- **A general shared application layer** (a common folder of services that features call): it removes the repetition between handlers, but it becomes the place where everything shared ends up, which is how Deploy keys and the dispatcher were filed as features. Sharing is instead an ordered last resort with a specifically named collaborator (rule 3).
- **Domain services** (`domain/services/`): it gives rules that belong to no single object a home. In practice it held application logic and became a second place to put behaviour next to the entity. A rule that belongs to no object means a concept is missing, so it is named as a policy or value object (rule 5).
- **Shared HTTP shapes in `contracts/http/`** (the decision on Issue #30): it is close to where the shapes are used, but it puts something that only the module's own endpoints may use inside the folder that is meant to be the module's public face, and needs a special exemption in the gate. Not chosen; `contracts/` is for other modules and nothing else (rule 8).

- **One snapshot per aggregate, not a full output model per handler** (rule 10). A snapshot is produced by the entity and reused wherever a result contains the whole aggregate. A separate output model for each handler would repeat the aggregate's fields many times, and every new field would be copied through all of them. Not chosen; a result that is not a whole aggregate is a view type owned by the feature.
- **No line limit** (rule 13). A limit makes a file get split to pass the check instead of to name a concept, which produces files without a meaning. The rule is that a file holds one named concept; size is reported by a structure report ([Quality](../../engineering/quality.md) §4) and reviewed, not enforced.

## Consequences

- **A feature's handler and its endpoint are in two folders** (`application/features/<feature>/` and `entry-points/http/<caller>/`), so reading one use case end to end means opening both.
- **Small repetition between handlers is accepted.** Step 5 of rule 3 says to repeat small logic rather than extract it, so two handlers may contain similar lines.
- **The conversion of existing code was staged** across the tickets of Epic #160, each adding the gate checks for its part. [Quality](../../engineering/quality.md) §4 lists every check, and §5 says how each rule is enforced.
- **No ticket changes behaviour.** Each is verified by the existing tests passing, with only imports, wiring and test placement changed. Where a database operation's concurrency guarantee cannot be kept after its rule moves into the domain, the operation stays in the repository and the ticket says why.
- **Domain rules get unit tests that need no database**, since the domain imports no port, repository or database client.
- **The architecture review skill runs at the end of each Epic** ([Agent roles](../../engineering/agent-roles.md) §6), to catch drift the gate cannot check.
