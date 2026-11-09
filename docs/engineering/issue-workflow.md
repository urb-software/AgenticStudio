# GitHub Issue → PR — SDLC Workflow

Canonical source for Issue hierarchy, stage and blocked rules. The GitHub Issue is the task source of truth.

## Hierarchy

Expressed with **native GitHub Issue Types and native parent relations**:

```text
Epic (root)
  ├── User Story
  │     └── Subtask (optional)
  ├── Technical Task
  └── Bug
```

| Type | Meaning | PR ownership |
| --- | --- | --- |
| **Epic** | A larger outcome or stage (e.g. Walking Skeleton) | Never owns a PR |
| **User Story** | A user-facing capability | Normally one integrated PR to `dev` |
| **Subtask** | Part of a story | Commit(s) on the story branch; never a direct PR to `dev` |
| **Technical Task** | An independent, safe technical change under an Epic | May own a PR to `dev` |
| **Bug** | A defect in accepted/integrated behavior, with reproduction steps and a regression test | May own a PR to `dev` |

- No generic `Task` type. `type:*` labels are not an alternative source of truth.
- Before marking an Issue Ready or taking a ticket, verify the **actual native parent link**; a parent number typed in the Issue Form does not create it.
- A failure in an unfinished Story is fixed within that Story (optional Subtask). File a Bug only for accepted/integrated behavior.

## Stage

- Organization Issue Field **`Workflow Stage`**: `Backlog → Refinement → Ready → In Progress → In Review`.
- **Done** is the native **Closed** state, not a field value.
- The field `Status` is reserved. Read the explicit field value; do not infer the stage from the Issue body.

## Blocked

Applies to every Issue Type. An Issue is blocked when it has:

- any **Open native `Blocked by` dependency**, or
- the repository label **`blocked:external`**, with a documented reason and unblock condition.

Not used: a `Blocked` stage, `blocked:internal`, a generic `blocked` label, a `Blocked` True/False Issue Field. Native hierarchy alone does not imply blocking. Blocked Ready Issues are not taken; unresolved blocked Issues are not closed.

## Workflow

1. Discovery/refinement with the operator; create and refine GitHub Issues.
2. Confirm DoR; `take-ticket` only picks up Issues that are Ready and not blocked.
3. The orchestrator prepares a plan and story branch/worktree, then passes a bounded context to the implementer.
4. The implementer writes code and runs local checks; backend and frontend may be delegated to separate sessions/worktrees.
5. The orchestrator integrates subtask commits into the story branch and opens a Draft PR targeting `dev` once the diff is coherent.
6. CI checks code quality, architecture tests, and contracts; an independent reviewer assesses the PR and may run targeted tests.
7. Address review findings, rerun checks, update the review.
8. With all required CI checks passing and approvals obtained, merge into `dev` through the controlled process.
9. Verify the shared Preview or equivalent environment; only then close the Issue (Done).

Roles and the manual `take-ticket` procedure: [Agent roles](agent-roles.md).

## Process safety rules

- Never merge without the required permissions and operator approval.
- Never skip CI or architecture tests to obtain a passing status.
- Review happens in a separate context from implementation; never approve your own code.
- No separate PR per subtask; split oversized stories into smaller deliverables instead.
- `dev` is the GitHub default branch, so `Closes #...` would close an issue on merge, before DoD verification. Use `Refs #...` and close the issue explicitly after DoD.

## CI

Target jobs: `quality:api`, `quality:web`, `architecture:api`, `architecture:web`, `architecture:monorepo`, `test:api`, `test:web`, `test:contracts`, `e2e:smoke`, `security`, `ci:required`. Implementing them is a separate Technical Task; details in [Quality](quality.md) §7.
