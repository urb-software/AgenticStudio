# GitHub Issue → PR — SDLC Workflow

## Hierarchy

- **Epic / stage:** A larger outcome (for example, Walking Skeleton); no mandatory PR.
- **User Story:** A user-facing capability; by default, one integrated PR targeting `dev`.
- **Subtask:** Part of a story; by default, commit(s) on the story branch without a separate PR.
- **Technical Task:** An independent, safe technical change may have its own PR to `dev`.
- **Bug:** A defect issue with reproduction steps and a regression test.

## Statuses

`Backlog → Refinement → Ready → In Progress → In Review → Done`, with `Blocked` as an additional state.

## Workflow

1. Perform discovery/refinement with the operator; create and refine GitHub Issues.
2. Confirm DoR; `take-ticket` only picks up issues marked Ready.
3. The orchestrator prepares a plan and story branch/worktree, then passes a bounded context to the implementer.
4. The implementer writes code and runs local checks; backend and frontend may be delegated to separate sessions/worktrees.
5. The orchestrator integrates subtask commits into the story branch and opens a Draft PR targeting `dev` once there is a coherent diff.
6. CI checks code quality, architecture tests, and contracts; an independent reviewer assesses the PR and may run targeted tests.
7. Address review findings, rerun checks, and update the review.
8. Once ready for review, with all required CI checks passing and approvals obtained, merge into `dev` through the controlled process.
9. Verify the shared Preview or equivalent environment and only then mark the story Done.

## Process safety rules

- Never merge without the required permissions and operator approval.
- Never skip CI or architecture tests to obtain a passing status.
- Review takes place in a separate context from implementation; do not approve your own code.
- Do not require a separate PR for every subtask; split oversized stories into smaller deliverables.
- If `dev` is not the default branch, do not assume `Closes #...` will automatically close an issue upon merging into `dev`; close it explicitly after DoD is met.

## CI

Target jobs: `quality:api`, `quality:web`, `architecture:api`, `architecture:web`, `architecture:monorepo`, `test:api`, `test:web`, `test:contracts`, `e2e:smoke`, `security`, and `ci:required`. Implementing these jobs is a separate Technical Task.
