---
name: studio-handoff
description: Write a bounded handoff for another agent context - coordinator → implementer, implementer → coordinator/reviewer, or a plain session continuation - using the repo's implementation-handoff template.
argument-hint: "implementer #<issue> | return #<issue> | continue <focus>"
disable-model-invocation: true
---

<!-- Forked from mattpocock-skills 1.3.1 `handoff` (MIT). See ../THIRD_PARTY_NOTICES.md. -->

Write a handoff document so a fresh agent context can pick up the work. Pick the mode from the arguments, or ask:

| Mode | Who writes it | Shape |
| --- | --- | --- |
| `implementer #<n>` | Coordinator, before starting a new implementer context | Top half of `docs/templates/implementation-handoff.md`: Issue, native type, branch/worktree, target PR base `dev`, scope for this session, file ownership, canonical context, task boundaries, verification |
| `return #<n>` | Implementer, when done or blocked | **Return handoff** section of the same template: commits/SHAs, acceptance criteria with evidence, tests (`PASS` / `FAIL` / `NOT RUN` / `NOT IMPLEMENTED`) with exact commands, files touched, risks and decisions needing approval |
| `continue <focus>` | Any role, to continue its own work in a new session | Free-form summary of state, next steps and open questions, tailored to `<focus>` |

For the coordinator mode, verify before writing: the Issue's native type and parent link, `Workflow Stage = Ready`, no Open native `Blocked by` and no `blocked:external` (`docs/engineering/agent-roles.md` §2). If any check fails, say so instead of writing the handoff.

Rules:

- **Bounded, not a transcript.** Pass only the Issue, acceptance criteria, approved contract, relevant doc paths, branch and required checks (`agent-roles.md` §3). Never dump the planning conversation or any secret store.
- **Point, don't copy.** Reference the Issue, canonical docs, ADRs, commits and diffs by number, path or URL instead of duplicating their content. The GitHub Issue stays the source of truth for requirements.
- **Suggested skills.** Include a short section naming which `studio-*` skills the next context should call (e.g. `studio-implement`, `studio-tdd`, `studio-code-review`).
- **Redact** any sensitive information: API keys, tokens, passwords, personal data.
- Save to the OS temporary directory (`$TMPDIR`, else `/tmp`; `%TEMP%` on Windows), not the workspace, and print the absolute path. A reviewer context gets the PR number and head SHA, **not** the implementer's narrative.
