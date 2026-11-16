---
name: studio-implement
description: "Implementer role: implement one assigned User Story, Technical Task, Bug or Subtask from its GitHub Issue and implementation handoff, test-first, then return a handoff for independent review."
disable-model-invocation: true
---

<!-- Forked from mattpocock-skills 1.3.1 `implement` (MIT). See ../THIRD_PARTY_NOTICES.md. -->

You are the **implementer** (`docs/engineering/agent-roles.md`). Implement exactly the work assigned to this session; nothing more.

## Working economically

Every turn re-reads the whole conversation, so the cost of a session is roughly its number of turns times the size of its context. Keep both small; none of this relaxes a check.

- **Batch independent lookups.** Issue every read and search you already know you need as parallel tool calls in one turn, starting with the handoff's **Read first** list. Use the file read and search tools rather than one `cat` / `grep` shell call per turn.
- **Chain commands that belong together.** Typecheck plus the affected test file is one shell call, not two.
- **Fix every failure a run reports before rerunning.** Do not rerun after each single fix.
- **Keep output small.** Prefer a reporter or filter that prints failures only, and never dump a whole log or a large file into the conversation when a search answers the question.
- **Wait for CI with one blocking call** (`gh pr checks <n> --watch`); never poll in a `sleep` loop.

## 1. Load the bounded context

- The input is a GitHub Issue number and, normally, an implementation handoff based on `docs/templates/implementation-handoff.md`. Fetch the Issue (`gh issue view <n> --json title,body,issueType,parent,blockedBy`) and state its number, title and native type before starting. If the reference is ambiguous, ask.
- Confirm you are in the **assigned branch/worktree** (`git branch --show-current`, `git worktree list`). Never work in or change another agent's worktree.
- Confirm the Issue is not blocked: no Open native `Blocked by` dependency and no `blocked:external` label. If it is blocked, or acceptance criteria / an approved contract are missing, **stop and escalate**; never resolve a business decision silently.
- Read only the canonical docs the Issue or handoff references (AGENTS.md §1). Use `docs/architecture/glossary.md` vocabulary when it exists.

## 2. Plan

For a meaningful change, write a short plan before coding: affected business modules / frontend features, contracts touched, seams under test, security implications (AGENTS.md §1.3). Stay inside the handoff's **Implement** / **Do not change** boundaries; scope expansion or material architecture changes need operator approval.

## 3. Build

- Call the Skill tool with "studio-tdd" at the seams the handoff or Issue already agreed. If no seams were agreed, propose them and confirm before writing tests.
- Follow the architecture rules (AGENTS.md §2, `docs/architecture/backend.md` / `frontend.md`): six business modules only, imports through public entry points, Prisma adapters behind ports, one canonical definition per public contract, no feature logic in `shared/`, no speculative layers.
- During the loop, run typechecking and the affected test file together in one command. Run the full relevant suite once at the end, not after every slice.

## 4. Verify

Run every relevant existing check from `docs/engineering/quality.md` §8 (format, lint, typecheck, `architecture:api` / `architecture:web` / `architecture:monorepo`, unit, integration, contract). Use the handoff's **Verify command** when it gives one; otherwise chain the checks for your scope into one command (for example `pnpm check:api && pnpm architecture:api && pnpm test:api`) instead of one check per turn. For each check, record the exact command and exit status; a check that did not run because an earlier one failed is `NOT RUN`. A script that does not exist yet is reported as `NOT IMPLEMENTED`, never `PASS`. Never remove or disable tests, auth checks or architecture gates to get green.

## 5. Self-review

Call the Skill tool with "studio-code-review" in **self-review** mode against the PR base (`origin/dev`). In this mode the skill runs both axes in this session and spawns no sub-agents. Fix what it finds. A self-review in this session does **not** satisfy independent review (`agent-roles.md` §1); say so wherever you report it.

## 6. Commit and hand back

- Commit to the assigned branch only, with messages that reference the Issue as `Refs #<n>` (never `Closes`/`Fixes`). Subtask work stays on the Story branch.
- Do not merge, force-push shared branches, close Issues, or approve your own work. Open or update a Draft PR to `dev` only if the handoff authorizes it, using `/studio-pr`.
- Return the handoff using the **Return handoff** section of `docs/templates/implementation-handoff.md`: commits/SHAs, acceptance criteria completed (with evidence), tests as `PASS` / `FAIL` / `NOT RUN` / `NOT IMPLEMENTED` with exact commands, files touched, risks and decisions requiring approval.
