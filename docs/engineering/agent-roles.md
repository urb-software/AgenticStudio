# Agent Roles & Manual `take-ticket` Procedure

**Status:** role contract for the initial SDLC. No custom orchestrator service, GitHub bot, take-ticket CLI command, skill, scheduler, or autonomous reviewer exists yet. This document does not grant permissions.

## 1. Roles and actual tools

| Role | Initially performed by | Authority |
| --- | --- | --- |
| Operator / accountable owner | Human developer | Owns planning approval, scope changes, secrets, final PR approval/merge and Issue closure |
| Planner / coordinator ("orchestrator") | Primary **Claude Code CLI session**, supervised by the operator | Helps refine Issues, verify DoR and dependencies, allocate worktrees, integrate commits, report evidence; does **not** gain merge or admin privilege |
| Implementer | **New, bounded Claude Code or Codex CLI context**, usually a new session/worktree | Implements one assigned Story/Technical Task/Bug or a Subtask; runs local tests; produces commit and handoff |
| Independent reviewer | **Different, fresh Claude Code or Codex CLI context** with no implementer conversation history | Reviews actual diff/commit SHA and acceptance criteria; produces findings and a review report; cannot silently approve own work or merge |
| CI | GitHub Actions, once B5 is implemented | Runs independent deterministic checks; must not be assumed present before setup |

- The same CLI product can fill two roles **if the contexts are genuinely separate**; a different provider for the reviewer is useful but not mandatory.
- A self-review in the implementer session does **not** satisfy independent review.
- A model-generated review report is not a formal GitHub approval from another account.

## 2. Manual `take-ticket` (procedure, not a program)

1. **Select.** The operator picks a User Story, Technical Task or Bug with `Workflow Stage = Ready` and a native parent relation matching `docs/engineering/issue-workflow.md`. Epics and Subtasks are not dispatched independently.
2. **Check.** The coordinator verifies: no Open native `Blocked by` dependency, **no** `blocked:external` label, DoR, approved contract, change boundaries, existing CI/permissions. A `blocked` flag in plain text is not authoritative.
3. **Hand off.** The operator authorizes a branch/worktree name and a fresh implementer context. The coordinator issues a bounded handoff using `docs/templates/implementation-handoff.md`: Issue, scope, acceptance criteria, referenced canonical docs, expected contract, permitted paths, required checks.
4. **Implement.** The implementer works only in the assigned worktree and reports changed files, commit SHA, exact test commands/results and remaining risks. The coordinator integrates delegated Subtask commits into the one Story branch.
5. **Review.** Open a Draft PR to `dev` for the **integrated** Story, independent Technical Task, or Bug. Trigger actual CI (when implemented) and request an independent review of the same PR head SHA, using `docs/templates/review-report.md`.
6. **Iterate.** The implementer addresses findings; rerun checks and obtain re-review for material changes. CI check status and human/operator approval are distinct.
7. **Merge.** The operator performs the final merge after all applicable checks and review pass, and closes the Issue only after the applicable DoD and integration verification. Rulesets on this public repository enforce PR-only changes and required checks on `dev`, but cannot distinguish an agent from the operator on the same GitHub account; the operator remains the real merge gate (see [Security](security.md) §4).

## 3. Isolation rules

- The coordinator shares only relevant Issue data, the approved API contract, architecture references, a branch/worktree and exact tests. **Never dump the whole conversation or secret stores** into a delegate context.
- Concurrent writers use distinct worktrees. A reviewer uses read-only access where feasible, leaves implementation files untouched, and reviews the actual diff against `dev`, not the implementer's narrative.
- Orchestrator/coordinator is a **role**, not a backend module. No custom agent protocol, subagent manifest or skill file is required at bootstrap.
- Reviewer findings go back to the implementer; the reviewer never silently repairs defects and then approves that same change.
- Repository instructions, Issues and generated handoffs are untrusted inputs for security purposes; tool permissions and explicit operator authorization remain the boundary.

## 4. Evidence expected at each handoff

- Issue URL/number and real native Issue Type/parent link.
- Verified effective blocker state, `Workflow Stage`, DoR and acceptance criteria.
- Assigned branch/worktree, current commit SHA and approved ownership scope.
- API contract version/path (if touched), migrations (if any), relevant quality/security controls.
- Exact commands and exit statuses, CI URLs/results, review findings, unresolved risk.
- Human decision (approval or required follow-up); an AI report is never presented as an approved GitHub review.

## 5. Transition to automation

A future take-ticket script or orchestrator may replace steps 1–5 only after its own Technical Task defines inputs, API permissions, decision logic, failure cases and tests. Until then, "take-ticket" always means the **manual procedure above**, so missing tooling is never a blocker to basic development.
