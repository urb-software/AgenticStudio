# Glossary Format

The glossary lives at `docs/architecture/glossary.md`.

## Structure

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **Only include terms specific to this project's context.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively. Before adding a term, ask: is this a concept unique to this context, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge. If all terms belong to a single cohesive area, a flat list is fine.

## One glossary, grouped by business module

AI Agent Studio is a single context: one modular monolith with six business modules (`projects`, `agents`, `workflows`, `executions`, `environments`, `mcp`). Keep **one** glossary at `docs/architecture/glossary.md`. Group terms under a subheading per business module when they belong to one module, and under `## Cross-cutting` when several modules share them. Do not create per-module or per-app glossary files, and do not introduce a `GLOSSARY-MAP.md`.

If the glossary does not exist yet, create it lazily when the first term is resolved, in the same small docs change as the decision that produced it.
