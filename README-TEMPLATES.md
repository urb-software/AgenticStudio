# AI Agent Studio — SDLC Templates v1 (English)

Copy the contents of this package into the **root of your new repository**, preserving the `.github/` and `docs/` paths.

## Included files

- `.github/ISSUE_TEMPLATE/01-user-story.yml` — User Story / Vertical Slice form
- `.github/ISSUE_TEMPLATE/02-technical-task.yml` — Technical Task form
- `.github/ISSUE_TEMPLATE/03-bug-report.yml` — Bug Report form
- `.github/ISSUE_TEMPLATE/config.yml` — Issue form selection settings
- `.github/pull_request_template.md` — shared PR template
- `docs/templates/review-report.md` — independent review report
- `docs/templates/implementation-handoff.md` — concise implementer handoff
- `docs/engineering/definition-of-ready.md` — Definition of Ready
- `docs/engineering/definition-of-done.md` — Definition of Done
- `docs/engineering/issue-workflow.md` — Issue-to-PR workflow

## After creating the repository

1. Commit these files to the repository's **default branch** so GitHub can display the Issue Forms and PR template.
2. Enable GitHub Issues and create GitHub Projects statuses: Backlog, Refinement, Ready, In Progress, In Review, Done, and Blocked.
3. Decide whether `dev` should be the default branch; configure rulesets/branch protection and required CI before parallel agent development.
4. Create the first Technical Task for the repository/monorepo bootstrap, followed by implementation of architecture tests and CI.
5. Adjust template fields only when the first few issues reveal a real need; keep the forms consistent across the project.

## Principles

- The GitHub Issue is the source of truth for requirements; handoff documents must not become a second independent specification.
- An Issue Form does not validate semantic DoR; readiness is assigned after requirements review.
- Subtasks do not require their own PR by default.
- Agent-generated review does not replace enforced permissions or CI.
- Do not rely on `Closes #...` alone to close a story when a PR is merged into a non-default branch.
- These are **templates**, not functioning CI workflows, bots, or configured repository rulesets.
