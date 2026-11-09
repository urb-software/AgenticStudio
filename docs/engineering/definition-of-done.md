# Definition of Done (DoD)

## 1. Implementation Done — implementer
- [ ] The issue scope is implemented without unapproved changes.
- [ ] Appropriate behavioral tests and negative cases are covered.
- [ ] Applicable backend, frontend, and monorepo architecture tests and local quality checks have been run.
- [ ] Results, skipped checks, and blockers are documented; tests and authorization were not bypassed.
- [ ] The diff, commits, and handoff context are ready for independent review.

## 2. Review Done — independent reviewer
- [ ] Acceptance criteria, contracts, module boundaries, and security have been evaluated.
- [ ] Test quality and important negative scenarios have been checked; targeted tests were run where needed.
- [ ] BLOCKER / MAJOR findings have been resolved and fixes re-evaluated.
- [ ] The review verdict applies to the latest reviewed diff / commit(s).

## 3. Story Done — integration and acceptance
- [ ] All applicable required CI checks passed for the current commit.
- [ ] Independent review and any required approvals are positive.
- [ ] The PR was merged into `dev` in accordance with permissions and branch protection.
- [ ] Preview or an equivalent environment/result was verified, where applicable.
- [ ] The GitHub Issue and relevant subtasks were updated/closed only after all applicable conditions were met.

**Technical Tasks and Bug Fixes:** Use equivalent gates with checks appropriate to the change. Do not require a fictitious UI screen or unnecessary E2E test for infrastructure work.

**Current implementation status:** This DoD defines the target process. Until CI, architecture tests, and runtime guardrails are implemented, missing checks must not be reported as PASS.
