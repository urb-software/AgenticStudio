---
name: studio-domain-modeling
description: Build and sharpen AI Agent Studio's domain model. Use when discussing domain terminology, writing or editing docs/architecture/glossary.md, or recording or editing an ADR in docs/architecture/adr/.
---

<!-- Forked from mattpocock-skills 1.3.1 `domain-modeling` (MIT). See ../THIRD_PARTY_NOTICES.md. -->

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the *active* discipline: challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise. (Merely *reading* the glossary for vocabulary is not this skill: that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.)

## File structure

AI Agent Studio is a single context (one modular monolith, six business modules). Domain docs live with the architecture docs:

```
docs/
└── architecture/
    ├── glossary.md          ← one glossary, grouped by business module
    ├── adr/
    │   ├── 0001-<slug>.md
    │   └── 0002-<slug>.md
    ├── system.md
    ├── backend.md
    └── frontend.md
```

Create files lazily: only when you have something to write. If `glossary.md` does not exist, create it when the first term is resolved. If `adr/` does not exist, create it when the first ADR is needed.

Both are documentation (English only). Changes land through a small, reviewable PR, together with any canonical-doc update they imply (AGENTS.md §6).

## During the session

### Challenge against the glossary

When the operator uses a term that conflicts with the existing language in the glossary, call it out immediately. "The glossary defines 'execution' as X, but you seem to mean Y. Which is it?"

### Sharpen fuzzy language

When the operator uses vague or overloaded terms, propose a precise canonical term. "You're saying 'run': do you mean an Execution or a Workflow step? Those are different things."

Watch especially for terms that collide with names already fixed in the canonical docs: the six business modules (`projects`, `agents`, `workflows`, `executions`, `environments`, `mcp`), and architecture vocabulary (port, adapter, handler, feature). Do not let a domain term silently redefine one of them.

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the operator to be precise about the boundaries between concepts, including which business module **owns** a concept and which only references it.

### Cross-reference with code and docs

When the operator states how something works, check whether the code and the canonical docs (`docs/architecture/*`, `docs/product/*`) agree. If you find a contradiction, surface it: "The docs say `executions` owns an Execution, but you just described `workflows` mutating one. Which is right?"

### Update the glossary inline

When a term is resolved, update `docs/architecture/glossary.md` right there. Don't batch these up: capture them as they happen. Use the format in [GLOSSARY-FORMAT.md](./GLOSSARY-FORMAT.md).

The glossary should be totally devoid of implementation details. Do not treat it as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse**: the cost of changing your mind later is meaningful
2. **Surprising without context**: a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off**: there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Decisions already recorded in the canonical docs or their linked Notion decision records are linked, not re-recorded. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).
