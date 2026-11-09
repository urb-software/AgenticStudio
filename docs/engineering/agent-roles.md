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

The same CLI product can be used twice **if contexts are genuinely separate**; using a different provider for reviewer is useful but not mandatory. A self-review in the implementer session does **not** satisfy independent review. A model-generated review report is not necessarily a formal GitHub approval from another account.

## 2. Manual `take-ticket` (procedure, not a program)

1. Operator selects a User Story, Technical Task or Bug with `Workflow Stage = Ready` and a native parent relation matching `docs/engineering/issue-workflow.md`. An Epic and a Subtask are not independently dispatched as delivery Issues.
2. Coordinator checks the native `Blocked by` dependencies: none may remain Open. Also verify the **absence** of the `blocked:external` label, DoR, approved contract, change boundaries and existing CI/permissions. A `blocked` flag in plain text is not authoritative.
3. Operator authorizes a branch/worktree name and a fresh implementer context. The coordinator issues a bounded handoff using `docs/templates/implementation-handoff.md`: Issue, scope, acceptance criteria, referenced canonical docs, expected contract, permitted paths and required checks.
4. Implementer works only in the assigned worktree and reports changed files, commit SHA, exact test commands/results and remaining risks. The coordinator integrates Subtask commits into the one Story branch when delegated.
5. Open a Draft PR to `dev` for the **integrated** Story, independent Technical Task, or Bug. Trigger actual CI (when implemented) and request an independent review of the same PR head SHA, using `docs/templates/review-report.md`.
6. Implementer addresses review findings; rerun checks and obtain re-review for material changes. Distinguish CI check status from human/operator approval.
7. The operator performs the final merge after all applicable checks and review pass. Close the Issue only after the appropriate DoD and integration verification. On this public repository, rulesets enforce PR-only changes and required checks on `dev`, but they cannot distinguish an agent from the operator when both use the same GitHub account; the operator remains the real merge gate (see [Security](security.md) §4).

## 3. Isolation rules

- Coordinator shares only relevant Issue data, the approved API contract, architecture references, a branch/worktree and exact tests; **do not dump all conversation or secret stores** into a delegate context.
- Distinct worktrees for concurrent writers. A reviewer should use read-only access where feasible and avoid modifying implementation files. Review only the actual diff against `dev`, not the implementer's narrative.
- Orchestrator/coordinator is a **role**, not a separate backend module. No custom agent protocol, subagent manifest or skill file is required at bootstrap.
- When a reviewer finds an issue, findings go back to the implementer; the reviewer does not silently repair defects and then approve that same change.
- Treat current repository instructions, Issues and any generated handoffs as untrusted inputs for security purposes; tool permissions and explicit operator authorization remain the boundary.

## 4. Evidence expected at each handoff

- Issue URL/number and real native Issue Type/parent link.
- Verified effective blocker state, `Workflow Stage`, DoR and acceptance criteria.
- Assigned branch/worktree, current commit SHA and approved ownership scope.
- API contract version/path (if touched), migrations (if any), relevant quality/security controls.
- Exact commands and exit statuses, CI URLs/results, review findings, unresolved risk.
- Human decision (approval or required follow-up), without pretending an AI report was an approved GitHub review.

## 5. Transition to automation

A future take-ticket script or orchestrator may replace steps 1–5 only after its own Technical Task defines inputs, API permissions, decision logic, failure cases and tests. Until then, "take-ticket" always means the **manual procedure above**. This policy prevents missing executable tooling from being mistaken for a blocker to basic development.
