---
status: accepted
date: 2026-11-25
---

# Agent definitions are files in a definitions Repository

Decided by the operator in the refinement of Epic #298, 2026-11-25. This is step 2 of the end-to-end outcome in [MVP](../../product/mvp.md) §2, for agents. Studio's own skills follow in the next Epic on the same storage, delivery and editor. [ADR 0002](0002-agent-run-isolation.md) still decides the isolation of Runs; only the ranking of instruction sources there names the chosen Agent definition.

Until now every Run used one built-in definition fixed in the agent worker's code, and no model could be chosen. An **Agent definition** is a folder in a **Definitions Repository**: an entry file with front matter (name, description, Provider, model) and instructions in Markdown, and beside it the agent's scripts and assets. The operator picks an agent when starting a Run, and edits the files in Studio or in their own Git.

## Context

- **"Git-first, file-native"** is a principle of [System](../system.md) §1. Definitions are text the operator wants to read, diff and review.
- **A Run must be reproducible.** What an agent was told is part of what a Run did.
- **Instructions are the most powerful input a Run has.** Whoever changes them changes what the agent does, so who can change them is a security question.
- **One operator, one dedicated server.**

## Decision

- **Definitions are files in one definitions Repository.** The database holds pointers and drafts only: which Repository it is, each Project's default agent, what a Run used, and unpublished changes.
- **A version is a commit.** Whatever is on the definitions Repository's Integration branch is published. A Run records the commit and the agent it started with, and its Follow-ups use the same commit. The Run also keeps a copy of the instructions, so an old Run shows what ran.
- **Two rules protect the definitions Repository.** It can never be the target of a Run, and the Agent account has no access to it. Only the operator, through Studio or their own Git, changes what agents are told.
- **The base rules stay fixed.** Studio's built-in text is always given first and cannot be edited or overridden; a definition's instructions come after it.
- **A definition belongs to one Provider and may name a model** from a short fixed list per Provider, or the CLI's default. Both [Provider compliance records](../../engineering/provider-compliance/README.md) were amended to allow that one option; the operator accepted the amendment on 2026-11-25.
- **Validation.** Unknown front matter keys are refused, as is any key that asks for tools, permissions, hooks or MCP servers. Limits apply to file count, size per file and size per folder, and a path that leaves the folder is refused. An invalid agent is listed with its reason and cannot be chosen. The limits are fixed by the validation's code (#300), not here.
- **Scripts are allowed** in definitions the operator published, but never run by themselves: the CLIs' inline shell execution stays switched off, and an agent runs a script only through its normal command tool, under the same guardrails and operating-system user as any other command.
- **Publishing writes with the definitions Repository's Deploy key**, which gets write access to that one Repository. The Merge credential is not used for it. The key lives on Studio's side only.
- **Delivery.** The API hands the agent's folder at the recorded commit to the agent worker with the Run. The worker writes it into the Run's directory and rebuilds it from Studio's copy before every Run step.
- **Connection and editor.** The definitions Repository uses the existing Repository connection. It is a Project of its own kind that accepts no Run, no Preview and no Environment file; at most one exists. Studio's editor works over its Clone. "Save" keeps a draft and reaches no agent; "Publish" makes one commit, pushed as a fast-forward only, and is refused when the Repository moved since the draft began.
- **A module of its own.** The `agents` module owns the list, the validation, drafts and publishing. `executions` records what a Run used through the public face of `agents`; `projects` supplies reading from and writing to the Clone through its public face.

## Considered Options

- **Definitions stored in the database, with Studio's own versions.** Rejected: it gives up the Git-first principle, needs a second history and diff of its own beside Git, and leaves the operator unable to review or change definitions with their own tools.
- **Definitions as files in a definitions Repository.** Chosen.

## Consequences and accepted risks

- **A published definition is trusted guidance that can carry scripts.** The operator wrote it, so it ranks above the repository's own skills; it is still bounded by the guardrails and the operating-system user, as any command is.
- **The write Deploy key is a new credential.** It reaches one Repository, lives on Studio's side and never reaches the agent side or a log. A leak would let someone change what agents are told.
- **Anyone who can push to the definitions Repository changes every later Run.** Protecting that Repository on the Git host is the operator's job; Studio only reads its Integration branch.
- **A value the CLI or the login refuses fails the Run.** A later change to the model lists needs an amendment of the compliance records.
- **A removed agent disappears from the list;** Runs that used it keep their record.
- **One more kind of Project and one more module** to maintain and test.

## Upgrade paths

Studio's own skills, several definitions Repositories, branches other than the Integration branch and pull requests on the definitions Repository from Studio each need a separate decision.
