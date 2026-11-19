# Lenses

Questions to read code with. Each names what to look for and the practice behind it. The canonical documents hold the rules; this page only says where rules tend to slip. Where a document and this page disagree, the document wins.

## Every area

**1. Moved, not fixed.** A rule forbids a form, and the same code now lives in the nearest allowed form: a function became a static method, an exported helper became an unexported one, a shared folder became a class named `Helper`, a forbidden import became a re-export. Look at what the latest structural pull requests removed and search for where it went.

**2. One role, several forms.** The same job done in two or three ways: three ways of writing an entity to storage, two ways of building a response, class here and plain function there for the same kind of thing, two suffixes for one kind of type. Practice: same role, same form. Count the forms; the majority form is usually the rule to write down.

**3. A rule far from the thing it is about.** A limit, format or allowed combination enforced in a request schema, a repository, a database query or a UI component, while the type it describes is a plain record that cannot refuse a bad value. Practice: a value validates itself on creation, so the rule holds for every caller.

**4. Logic in the wrong layer.** A decision in an entry point or a component; a use case in an adapter (an adapter that calls a repository, the clock and a store is a handler in the wrong folder); a business rule in SQL; orchestration in a domain object. Practice: dependencies point inward, and each layer has one kind of job.

**5. A shape owned by one layer that dictates another.** A domain or storage type returned to callers, a generated API type used as a component's props or state, a wire protocol type used as the internal model. A new field on one side then appears on the other unasked. Practice: each boundary owns its own input and output types and maps explicitly.

**6. Production code that exists for tests.** A method or export only tests call; a whole-state export added so assertions are shorter; a rule written as a function that tests prove while the real behaviour is implemented separately somewhere else. Either the two are tied together by a test that fails when they disagree, or one of them goes.

**7. Two sources of truth.** The same list of allowed values, limit, message or mapping declared twice with nothing that fails when they differ. Duplication across a deliberate boundary is acceptable only with such a tie.

**8. The exceptions ledger.** Pinned lists in `tests/architecture`, exceptions written into a gate rule by name, `eslint-disable`, type casts, skipped tests, `@long-comment`. Each is fine alone. Read the list whole: is it growing, and does every entry still have its reason?

**9. The gate itself.** A rule with no failing fixture; a rule whose path pattern no longer matches anything after a rename (it passes because it checks nothing); a rule that names a real module; an allowance added for one case that now lets others through. Practice: every guardrail is proven able to fail.

**10. Documents against code.** A section that describes a structure the code no longer has; a glossary term the code names differently; a skill or review brief that still cites a rule that changed. Report the document, not the code, when the code is right.

**11. Size with change.** A file that is both large and changed in most recent work is where a split pays back. A large file nobody touches is not a finding.

**12. Comments.** Rule 14: why, briefly, only when the code cannot say it. History, ticket numbers, restated rules and glossary definitions in comments are findings wherever the lint does not reach yet.

## API

Rules: `docs/architecture/backend.md` §2–§3 (the structure rules and the aggregate tests), ADR 0003. The question list of the structure-rules brief in `/studio-code-review` step 4 applies to the whole module here, not to a diff.

- **Aggregates.** For each root: is there a rule that must hold at every moment across it and what it holds? If not, it is two roots. Does a root load or hold another root? Does a transaction change two roots?
- **Handlers.** Does a handler state a rule that belongs to the object it loads? Does it return more than its callers use? A handler with seven or more dependencies usually carries two use cases.
- **Repositories.** Does an interface method return anything but its entity, a named view, an id, a count or nothing? Does an implementation decide something (a state change, a limit) in a query?
- **Value objects.** Is each one the form its content calls for: a list of allowed values, a class when any rule exists, a record only when nothing constrains it? Does a file hold one concept?
- **Entry points.** Schema beside the endpoint for shape only; limits taken from the domain, not repeated.
- **Database.** A state stored as text with no constraint; a JSON column holding something queried or validated; a sweep query without an index for its filter; a column nothing reads.

## Web

Rules: `docs/architecture/frontend.md` (§3 boundaries, §4 state ownership, §6 server and client).

- **One component, three jobs.** Fetching, state and rendering in a single file of several hundred lines. Practice: separate what is shown from where the data comes from.
- **Server state copied.** Data from a query copied into local state and kept in step by an effect. Practice: server state has one owner; derived values are computed, not stored.
- **Features reaching into features.** An import from another feature's internals instead of its public entry, or logic shared by putting it in `shared/`.
- **Rules repeated from the API.** A limit, an allowed transition or a state-to-label mapping written by hand in a component while the contract already carries it.
- **Generated types as the model.** Components typed directly on the generated client's response types, so an API change reaches every component.
- **Query files that grew.** A queries file exporting dozens of hooks plus presentation helpers is a grab-bag: one concept per file applies here too.
- **Client where server would do.** A client component that only renders; a server import reachable from a client bundle.

## Agent worker

Rules: `docs/architecture/agent-worker.md`, ADR 0002, `docs/engineering/security.md`. Its internal structure has no written rules, so expect mostly "Missing rule" findings and propose a layout rather than list violations.

- **Decisions mixed with effects.** One function that decides what happens next and also spawns a process, calls Git or sends HTTP. Practice: keep the decision a pure step that tests can run without a process.
- **The loop.** Does the main loop know the details of every step, or does it only order them?
- **Security boundaries in one place.** Spawning, redaction, path checks and credential handling each have a single owner that everything goes through. A second path to the same effect is a finding of the highest order.
- **The protocol as the internal model.** Worker protocol types used throughout instead of at the edge.
- **A flat folder.** Several dozen files side by side with no grouping by job: what are the natural groups, and which imports would a grouping forbid?

## Packages

- `packages/contracts` is the only definition of the worker protocol; nothing app-specific lives in a package; a package exports a deliberate surface and not everything it contains.
