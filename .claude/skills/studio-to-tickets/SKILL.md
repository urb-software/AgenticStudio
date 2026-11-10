---
name: studio-to-tickets
description: Break an Epic, plan, spec, or the current conversation into tracer-bullet User Stories and Technical Tasks, published as GitHub Issues with native Issue Types, native parent links and native "Blocked by" dependencies.
disable-model-invocation: true
---

<!-- Forked from mattpocock-skills 1.3.1 `to-tickets` (MIT). See ../THIRD_PARTY_NOTICES.md. -->

# To Tickets

Break a plan, spec, or conversation into a set of **tickets**: tracer-bullet vertical slices, each declaring the tickets that **block** it.

The hierarchy, stage and blocked rules are canonical in `docs/engineering/issue-workflow.md`. Read it before publishing. In short: `Epic` → `User Story` (→ optional `Subtask`), and `Epic` → `Technical Task` / `Bug`; native parent links; native `Blocked by`; `Workflow Stage` Issue Field; no `type:*` or triage labels.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the operator passes a reference (an Epic number or URL, a spec path), fetch it and read its full body and comments (`gh issue view <n> --comments --json title,body,issueType,parent,blockedBy`). The parent of every ticket you create must be an `Epic`; if none exists, stop and suggest `/studio-to-spec` first.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the vocabulary of `docs/architecture/glossary.md`, and respect the canonical docs and ADRs in `docs/architecture/adr/` in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change." A prefactor becomes its own **Technical Task** that blocks the stories depending on it.

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- A **User Story** cuts a narrow but COMPLETE path through every layer it needs (Prisma schema/migration, NestJS feature, Zod contract, generated client, Next.js feature, tests): vertical, NOT a horizontal slice of one layer. BE + FE + tests **when applicable**, without unnecessary layers (AGENTS.md §2).
- A completed slice is demoable or verifiable on its own and owns one PR to `dev`.
- Each slice is sized to fit in a single fresh implementer context and to be reviewed and integrated safely (DoR: "small enough to review").
- A slice that spans backend and frontend names the API/event contract it depends on; if that contract isn't agreed yet, agreeing it is a prerequisite (a Technical Task or an Open decision).
- Independent technical work that isn't user-facing (tooling, CI, prefactors) is a **Technical Task**, not a story.
- Do not create `Subtask`s here by default. Subtasks are an optional delegation tool inside one Story and never own a PR.
- Any prefactoring should be done first.

</vertical-slice-rules>

Give each ticket its **blocking edges**: the other tickets that must complete before it can start. A ticket with no blockers can start immediately. Hierarchy alone does not imply blocking; only declare edges that genuinely gate the work.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change (rename a column, retype a shared symbol) whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract** Technical Tasks. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per business module, per app), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. Architecture checks must stay green at every step; never relax them to land a batch.

### 4. Quiz the operator

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Type**: `User Story` or `Technical Task`
- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work
- **Affected areas**: business modules / frontend features / packages

Ask the operator:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct: does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?
- Are any business decisions still open (these block Ready)?

Iterate until the operator approves the breakdown. Do not publish before approval.

### 5. Publish the tickets to GitHub

Publish one Issue per ticket in dependency order (blockers first) so each ticket's blocking edges can reference real numbers. Use the body that matches the repository Issue Form for its type (`.github/ISSUE_TEMPLATE/01-user-story.yml` or `02-technical-task.yml`): same section headings, in the same order.

```bash
gh issue create --type "User Story" --title "[Story] <title>" --parent <epic> --body-file <tmpfile>
gh issue create --type "Technical Task" --title "[Tech] <title>" --parent <epic> --body-file <tmpfile>
gh issue edit <n> --add-blocked-by <blocker>[,<blocker>...]
gh issue view <n> --json number,issueType,parent,blockedBy   # verify native type, parent and edges
```

- Verify every created Issue's native type, parent and `Blocked by` edges after publishing; report any that failed.
- Leave `Workflow Stage` at `Backlog` (or `Refinement` if the operator asks). **Never set `Ready`**: readiness is assessed against `docs/engineering/definition-of-ready.md` by the refinement lead.
- Do not apply `type:*`, triage, or `blocked` labels. `blocked:external` is only for genuinely external blockers, with a documented reason and unblock condition.
- Do NOT close or otherwise modify the parent Epic beyond adding the sub-issue links.
- Reference only with `Refs #<n>`, never `Closes #<n>`.

<user-story-body>

## Goal and context

## User Story

As an <actor>, I want <capability>, so that <benefit>.

## Acceptance criteria

- [ ] Criterion 1 (testable)
- [ ] Criterion 2

## In scope / out of scope

## Affected system areas

## Dependencies, contracts, and references

Canonical docs, ADRs, agreed API/event contract, related Issues. Blockers are set as native edges, not listed here.

## Verification and risks

Seams/test layers, required negative and security cases, known risks and approvals.

</user-story-body>

<technical-task-body>

## Problem / rationale

## Expected outcome

## Acceptance criteria

- [ ] Criterion 1

## Scope and constraints

## Dependencies and references

## How will the outcome be verified?

</technical-task-body>

In either form, avoid specific file paths or code snippets: they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype.
