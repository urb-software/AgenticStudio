---
name: studio-to-spec
description: "Turn the current conversation into a spec and publish it as a GitHub Epic (or update an existing Epic): no interview, just synthesis of what has already been discussed."
disable-model-invocation: true
---

<!-- Forked from mattpocock-skills 1.3.1 `to-spec` (MIT). See ../THIRD_PARTY_NOTICES.md. -->

This skill takes the current conversation context and codebase understanding and produces a spec. Do NOT interview the operator; just synthesize what you already know. If a business decision is missing, list it under **Open decisions**; never resolve it silently.

In AI Agent Studio the spec is an **Epic** GitHub Issue (native Issue Type `Epic`, see `docs/engineering/issue-workflow.md`). Its child User Stories / Technical Tasks are created afterwards with `/studio-to-tickets`. If the operator names an existing Epic, update that Epic instead of creating a new one.

## Process

1. Explore the repo to understand the current state of the codebase and docs, if you haven't already. Use the vocabulary of `docs/architecture/glossary.md` throughout the spec, and respect the canonical docs (`docs/architecture/*`, `docs/product/*`, `docs/engineering/*`) and any ADRs in `docs/architecture/adr/` in the area you're touching. Flag any contradiction explicitly.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible: typically a feature handler through its ports, the HTTP endpoint (Supertest), a business module's public entry point, or a Next.js feature through React Testing Library (`docs/engineering/quality.md` §6). The fewer seams across the codebase, the better - the ideal number is one.

   Check with the operator that these seams match their expectations.

3. Write the spec using the template below. **Show the draft to the operator and get approval before publishing**: creating an Issue is outward-facing. Then publish:

   ```bash
   gh issue create --type Epic --title "[Epic] <title>" --body-file <tmpfile>
   # or, for an existing Epic:
   gh issue edit <n> --body-file <tmpfile>
   gh issue view <n> --json number,issueType,url   # verify the native type
   ```

   Do not apply `type:*` or triage labels. Leave `Workflow Stage` at `Backlog`/`Refinement` (set by the operator or via the GitHub UI); never set it to `Ready`.

<spec-template>

## Outcome

The problem the operator/user is facing and the outcome this Epic delivers, from the user's perspective.

## In scope / out of scope

**In scope:** ...

**Out of scope:** an explicit list; the no-s are as valuable as the yes-s.

## User stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

This list should be extensive and cover all aspects of the feature. Each one is a candidate for a child User Story; `/studio-to-tickets` groups them into vertical slices.

## Completion criteria

How the Epic is verified as done (observable outcomes, not task lists).

## Implementation decisions

A list of implementation decisions that were made. This can include:

- The business modules (`projects`, `agents`, `workflows`, `executions`, `environments`, `mcp`) and frontend features that will be built/modified
- The public contracts of those modules that will change
- API/event contracts (Zod 4 schemas → OpenAPI → generated client; one canonical definition per public contract)
- Persistence/schema changes (Prisma adapters behind ports; migrations)
- Security implications and required permissions (`docs/engineering/security.md`)
- Technical clarifications and architectural decisions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts.

## Testing decisions

- What makes a good test here (only test external behavior, not implementation details)
- The agreed seams from step 2 and which test layer covers each (`quality.md` §6)
- Required negative/security cases
- Prior art for the tests (similar tests in the codebase)

## Open decisions

Business or architecture decisions still needed before child Issues can become Ready. Omit if none.

## References

Canonical docs, ADRs, Notion decision records, related Issues.

</spec-template>
