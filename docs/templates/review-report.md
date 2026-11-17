# Independent Review Report

- **Issue:** #...
- **PR:** #...
- **Reviewed commit SHA:** `...`
- **Reviewer / context:** ...
- **Verdict:** `APPROVE` / `REQUEST_CHANGES` / `BLOCKED`

## 1. Requirements compliance
- [ ] Acceptance criteria are met.
- [ ] The scope matches the issue and the agreed contract.
- [ ] Failure paths and authorization are addressed.

## 2. Architecture
- [ ] Backend: module isolation; ports and adapters (if applicable).
- [ ] Backend: features are independent, and no handler calls another handler.
- [ ] Backend: entry points are thin and hold no business rule.
- [ ] Backend: business rules are in the domain, and none in the database adapter.
- [ ] Backend: validation is in its two homes (endpoint schema for shape, entity or value object for rules).
- [ ] Backend: handler results are plain data (snapshots reused for whole aggregates, no entity class, no HTTP shape).
- [ ] Backend: aggregates refer to each other by id, and anything with its own repository is a root.
- [ ] Backend: one concept per file, with no loose functions in `domain/`.
- [ ] Frontend: Feature-First / public APIs / state boundaries (if applicable).
- [ ] Monorepo: no prohibited dependencies.
- [ ] No unnecessary abstractions or unrelated changes.

## 3. Tests and security
| Check | PASS / FAIL / NOT RUN / N/A | Evidence / command / CI link |
| --- | --- | --- |
| Backend architecture | | |
| Frontend architecture | | |
| Monorepo architecture | | |
| Unit / component | | |
| Integration / contract | | |
| E2E smoke | | |
| Security / accessibility | | |

## 4. Findings
<!-- Each finding: severity (BLOCKER / MAJOR / MINOR), file:line, issue, recommended fix. -->
| Severity | Location | Finding | Required action |
| --- | --- | --- | --- |
| | | | |

## 5. Decision and handoff
- **Verdict and rationale:** ...
- **Actions for the implementer:** ...
- **What must be rechecked after fixes:** ...
- **Remaining risks / checks not run:** ...

> This review is independent of the implementer's self-review. The verdict applies to the specified commit SHA; after code changes, re-evaluate the fixes and verify the latest CI results.
