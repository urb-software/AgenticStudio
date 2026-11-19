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
  - **Handlers own their input and result** (10): each handler declares its own input and result types; a result holds ids, values and view types built from the entity's readable fields, an input holds plain data only; an entity class never leaves the application layer and a handler never builds an HTTP shape.
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

- **The entity data type is not a handler result** (rule 10). `<Entity>Data` is the shape an entity is restored from, used by the entity and its repository's implementation only: as a handler result, a field added for one purpose would reach every result, and it would double as the facts passed between domain objects. A result holds what its callers use; a view shown whole by several features (the Run, the Project, the Repository connection, the Environment file) is one named collaborator of `application/`, a type with a pure mapping, so its fields are not repeated in each feature. Facts for a domain rule are fact types with only the fields the rule uses.
- **No line limit** (rule 13). A limit makes a file get split to pass the check instead of to name a concept, which produces files without a meaning. The rule is that a file holds one named concept; size is reported by a structure report ([Quality](../../engineering/quality.md) §4) and reviewed, not enforced.

## Amendment, 2026-11-18 (Epic #160, Issue #203): direction of references and homes for companions

After the entity files were split by concept, `domain/value-objects/` held things that are not value objects (error classes, fact types, stored shapes), and one value object (the retention policy) took the `Run` class as a parameter. The layout is amended:

- Error classes of an aggregate live in `domain/errors/<aggregate>-errors.ts`, one file per aggregate.
- An aggregate's data type and fact types live beside its entity in `domain/entities/`, in files with the suffixes `-data.ts` and `-facts.ts` (split facts: `<aggregate>-<operation>-facts.ts`) that export types only. The gate recognises a companion by its suffix; every other file in `domain/entities/` is an entity file with the unchanged checks.
- `domain/value-objects/` holds value objects, policies and rules only. Inside `domain/`, references point one way: entities use value objects, value objects use smaller value objects, nothing under `value-objects/` or `errors/` imports from `entities/`, and there is no import cycle. A rule or policy takes an input type it declares itself.
- Two gate checks keep this ([Quality](../../engineering/quality.md) §4 and §5). No behaviour changes.

## Amendment, 2026-11-18 (Epic #160, Issue #215): value objects own their rules

Records that carry a rule (a limit, a format, a cut, a redaction) were plain types with their rule enforced in a handler or beside them, and files under `domain/value-objects/` mixed lists, limits, records and classes. Rule 9 is refined ([Backend](../backend.md) §3 and §10):

- A record with a rule becomes a value object class with a non-public constructor. Its limits are `static readonly` members of the class; a request schema takes them from the class and keeps its own shape check (rule 7).
- A class is built by static factories that return the class: `of`, `create` and `from…` validate; `restore` rebuilds from storage and does not validate again. A factory enforces exactly what was enforced before, at the same moment and with the same result.
- A static method that is not a factory is an instance method of the object it is about. Issue #215 does this for the files it reshapes; Issue #216 does it for the rest and adds the check for static methods.
- A file under `domain/value-objects/` holds one class or one record, plus the lists, unions, type guards and typed-id brands that describe it. A constant that is not a list of allowed values is allowed only beside a class. There is no `factories/` directory under `domain/` or `application/`, and no class under `domain/` whose public members are all methods returning another class.
- A list of allowed values is a union type. The second form of factory is an instance method of an aggregate root (a Run adding a Run step); there is no standalone factory, because it would be a stateless domain object and a creation that outgrows its class signals a missing concept. Factory names say what they do: `of`, `create`, `from…`, `restore`, or a descriptive name such as `load` or `afterWaiting`.
- Four gate rules keep this, with a passing and a failing fixture each ([Quality](../../engineering/quality.md) §4 and §5). No behaviour changes.

## Amendment, 2026-11-18 (Epic #160, Issue #216): no rule in a static method or a top-level function

The value object rule left two ways to keep a rule without an object: a static method that is not a factory, and an unexported function at the top of a file. Rules 4, 9 and 13 are refined ([Backend](../backend.md) §3 and §10):

- A public static method of an entity or value object is a factory that returns its own class (optionally with `| undefined` or `| null`) and declares it. A private static may only prepare data for such a factory. Every other rule is an instance method; a question asked before an object exists is answered by creating the object first, or by a small value object that owns it (a remote address, a lease, a normalized name).
- Policies and rules are instances built by a factory from their configuration; their checks are instance methods.
- A top-level function in `domain/` is an exported type guard, or unexported, at most ten lines and naming no domain type. A class has at least one instance member, so a namespace of statics is not allowed.
- The domain imports no runtime module (`node:crypto`, `fs`, `dns`, `timers`, `child_process`, `net` and the like). Generating a Deploy key therefore lives in the infrastructure adapter behind the Deploy key port; the domain keeps what a Deploy key comment is. From `crypto` the domain may import only `createHash` (deterministic, no I/O: the SHA-256 fingerprint of a public host key); a random source, key generation, any other name and a default or namespace import fail, and no path is exempt.
- Four gate rules keep this, with a passing and a failing fixture each ([Quality](../../engineering/quality.md) §4 and §5). No behaviour changes.

## Consequences

- **A feature's handler and its endpoint are in two folders** (`application/features/<feature>/` and `entry-points/http/<caller>/`), so reading one use case end to end means opening both.
- **Small repetition between handlers is accepted.** Step 5 of rule 3 says to repeat small logic rather than extract it, so two handlers may contain similar lines.
- **The conversion of existing code was staged** across the tickets of Epic #160, each adding the gate checks for its part. [Quality](../../engineering/quality.md) §4 lists every check, and §5 says how each rule is enforced.
- **No ticket changes behaviour.** Each is verified by the existing tests passing, with only imports, wiring and test placement changed. Where a database operation's concurrency guarantee cannot be kept after its rule moves into the domain, the operation stays in the repository and the ticket says why.
- **Domain rules get unit tests that need no database**, since the domain imports no port, repository or database client.
- **The architecture review skill runs at the end of each Epic** ([Agent roles](../../engineering/agent-roles.md) §6), to catch drift the gate cannot check.

## Amendment, 2026-11-19 (Epic #160, Issue #222): no snapshots; entities restore from their data

Entities no longer produce snapshots, and no class under `domain/` declares `snapshot` or `toSnapshot`. Every entity is restored with `restore(data)` from its `<Entity>Data` (`<entity>-data.ts` beside it), imported only by the entity and by repository adapters of the same module; a facts file or another entity declares its field types from the value objects. A value object uses the same vocabulary: type `<ValueObject>Data`, method `toData()`, factory `restore(data)`. An entity copies the top-level arrays it is given and keeps nested values read-only. A repository method returns the entity, a read model declared in the repository's own file (`RunStepView`, `RunDiffView`), or a value object the entity holds as a readonly field (`RunDiffState` of a Run diff), and never an `…Data` or facts type.

There are two ways of writing ([Backend](../backend.md) §5): `Run` and `RepositoryConnection` from pending changes, because their writes are partial and run under concurrency; every other aggregate, and the first insert of those two, from the entity's readable fields. The gate ([Quality](../../engineering/quality.md) §4 and §5) checks the placement of data files, repository return types, the absence of snapshot members and the companion suffixes. No behaviour, HTTP contract or worker protocol changes.
