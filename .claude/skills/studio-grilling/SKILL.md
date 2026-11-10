---
name: studio-grilling
description: Grill the operator relentlessly about a plan, decision, Issue or idea until there is a shared understanding. Use when refining an Issue toward Ready, stress-testing a design, or on any 'grill' trigger phrase.
---

<!-- Forked from mattpocock-skills 1.3.1 `grilling` (MIT). See ../THIRD_PARTY_NOTICES.md. -->

Interview the operator relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the operator's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the operator answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the operator's. When a frontier question needs a fact from the environment (repository, `docs/`, GitHub Issues, tools), dispatch a sub-agent to find it; don't ask the operator for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the operator's: put each to them and wait. **Never resolve a business decision silently** (AGENTS.md §1).

## AI Agent Studio specifics

- **Settled decisions are not re-litigated.** Treat the canonical docs (`docs/architecture/*`, `docs/engineering/*`, `docs/product/*`) and `docs/architecture/adr/` as already-settled branches. If a plan contradicts one, ask one explicit question: "This contradicts `<doc> §<n>`; reopen it?" Reopening is a decision change that needs operator approval and a docs PR.
- **Refining an Issue toward Ready:** the frontier must eventually cover every item of `docs/engineering/definition-of-ready.md`: outcome, testable acceptance criteria, scope and exclusions, blockers, affected business modules and canonical docs, contracts, size, security/permissions. Also verify the native Issue Type and native parent link (`gh issue view <n> --json issueType,parent,blockedBy`) rather than trusting the Issue body.
- **API/event contracts** must be agreed before BE/FE work splits (AGENTS.md §2). Put the contract shape on the frontier early when a slice spans both.
- Use the glossary vocabulary from `docs/architecture/glossary.md` when it exists.

## Done

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the operator confirms you have reached a shared understanding. Then record the outcome where it belongs: in the GitHub Issue (decisions, acceptance criteria, scope) or a docs PR. Never only in the chat. Do not set `Workflow Stage = Ready` yourself; readiness is the refinement lead's assessment.
