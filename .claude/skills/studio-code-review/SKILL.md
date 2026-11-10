---
name: studio-code-review
description: "Review a PR or branch against dev along two separate axes - Standards (AGENTS.md and docs/ rules, plus a code-smell baseline) and Spec (the GitHub Issue's acceptance criteria and agreed contract) - using parallel sub-agents, and report in the repo's review-report format. Use for independent review of a PR head SHA, or as an implementer's labelled self-review."
---

<!-- Forked from mattpocock-skills 1.3.1 `code-review` (MIT). See ../THIRD_PARTY_NOTICES.md. -->

Two-axis review of a diff against its PR base:

- **Standards**: does the code conform to this repo's documented standards?
- **Spec**: does the code faithfully implement the originating GitHub Issue?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings into `docs/templates/review-report.md`.

## 0. Pick the mode

- **Independent review** (DoD §2): this context has **no** implementer conversation history and did not write the diff. Only this mode can produce a verdict for the PR (`docs/engineering/agent-roles.md` §1).
- **Self-review**: this session wrote (or helped write) the diff, e.g. when called from `studio-implement`. Run the same process, but title the output **"Self-review — does not satisfy independent review"** and give no verdict.

If you're unsure which applies, it's self-review.

The reviewer **never fixes the code** it is reviewing. Findings go back to the implementer (`agent-roles.md` §3). An AI review report is never a formal GitHub approval; do not post it to the PR or approve anything unless the operator asks.

## Process

### 1. Pin the reviewed commit

Resolve what is being reviewed:

- A PR number: `gh pr view <n> --json number,headRefOid,baseRefName,headRefName,body`. The base should be `dev`; flag anything else. Fetch and review the **head SHA**, not a local branch that may differ.
- A branch or no argument: base is `origin/dev`, head is `HEAD`.

Capture once: the head SHA (`git rev-parse <head>`), the diff command `git diff origin/<base>...<head-sha>` (three-dot, against the merge-base), and `git log origin/<base>..<head-sha> --oneline`. Confirm the refs resolve and the diff is non-empty before going further. A bad ref or empty diff should fail here, not inside two parallel sub-agents.

### 2. Identify the spec source

1. The Issue referenced as `Refs #<n>` in the PR body or commit messages. Fetch it with `gh issue view <n> --comments --json title,body,issueType,parent,blockedBy` and note its native type and parent.
2. For a Subtask, also read its parent Story; a Story's PR is judged against the Story.
3. The agreed API/event contract and any implementation handoff the operator points to.
4. If nothing is found, ask the operator. If there isn't one, the **Spec** sub-agent skips and the report says "no spec available" (which is itself a finding: every PR needs an owning Issue).

### 3. Identify the standards sources

Always include:

- `AGENTS.md`
- `docs/engineering/quality.md` (architecture categories §4, test rules §3/§6, CI contract §7)
- `docs/engineering/security.md`
- `docs/engineering/definition-of-done.md` (§1 for what the implementer must have delivered)
- `docs/architecture/backend.md` and/or `docs/architecture/frontend.md` and `docs/architecture/system.md`, depending on what the diff touches
- `docs/architecture/glossary.md` and relevant `docs/architecture/adr/*` if they exist

Plus any other file that documents how code should be written (e.g. `CONTRIBUTING.md`).

On top of the repo docs, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3). Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell. (E.g. a port with a single Prisma adapter is mandated by `backend.md`, so it is not Speculative Generality or Middle Man.)
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn both sub-agents in parallel

Issue both sub-agent calls together, in the foreground, read-only (they must not edit files), and aggregate the reports they return.

**Standards sub-agent prompt** should include:

- The full diff command, head SHA and commit list.
- The list of standards-source files from step 3, **plus the smell baseline pasted in full** (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk, (a) every place the diff violates a documented standard: cite the file and rule; pay particular attention to business-module isolation and public entry points, domain purity, ports vs adapters, one canonical contract definition, no feature logic in `shared/`, client bundles importing server code, secrets in code or logs, and tests/auth/architecture gates removed or weakened; and (b) any baseline smell: name it and quote the hunk. Validate module-boundary findings against the whole relevant dependency graph, not just changed files. Give each finding a severity: BLOCKER, MAJOR or MINOR (baseline smells are at most MINOR unless a documented rule is also broken). Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** should include:

- The diff command, head SHA and commit list.
- The fetched Issue (and parent Story / contract / handoff where relevant).
- The brief: "Report: (a) acceptance criteria that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep, unrelated changes); (c) criteria that look implemented but where the implementation looks wrong; (d) missing failure-path, authorization or negative tests the criteria imply. Quote the Issue line for each finding and give a severity: BLOCKER, MAJOR or MINOR. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the report.

### 5. Checks

While the sub-agents run, determine the check status for the reviewed SHA: CI results (`gh pr checks <n>`) and any targeted local checks you choose to run from `docs/engineering/quality.md` §8. Record each as `PASS` / `FAIL` / `NOT RUN` / `N/A` with the exact command or CI link. A script that does not exist yet is `NOT IMPLEMENTED`, never `PASS`.

### 6. Aggregate into the review report

Fill `docs/templates/review-report.md` for the pinned head SHA:

- §1–§3 from the Spec findings, the Standards findings and the checks from step 5.
- §4 **Findings**: keep the two axes separate. List the Standards findings, then the Spec findings, each with an **Axis** column; do **not** merge or rerank across axes (see _Why two axes_).
- §5 **Decision**: in independent mode, `APPROVE` only with no open BLOCKER/MAJOR findings and no failing required check; `REQUEST_CHANGES` for fixable findings; `BLOCKED` when a decision, missing contract or external dependency prevents review. In self-review mode, omit the verdict.

End with a one-line summary: findings per axis and the worst issue _within each axis_. Don't pick a single winner across axes.

Save the report to the OS temp directory and print its path; the operator decides whether to post it. After fixes, the review must be re-run against the new head SHA.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the Issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
