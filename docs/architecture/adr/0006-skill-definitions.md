---
status: accepted
date: 2026-11-26
---

# Studio's own skills are files that an agent names

Decided in the refinement of Epic #326, 2026-11-26. The operator decided that an agent names its skills and that both Providers get them the same way; the rest was settled in the refinement as technical decisions. This completes step 2 of the end-to-end outcome in [MVP](../../product/mvp.md) §2 for skills; [ADR 0005](0005-agent-definitions-in-git.md) did it for agents, and this decision uses the same storage, versions, delivery and editor. [ADR 0002](0002-agent-run-isolation.md) still decides the isolation of Runs.

Until now an agent could be told only what its instructions say. A **Skill definition** is reusable know-how that several agents can share: a folder with an entry file (name, description, instructions in Markdown) and, beside it, its scripts and assets. The agent reads a skill when the task fits.

## Context

- **Skills are guidance the agent chooses to read.** They carry no authority of their own; what they may do is bounded by the guardrails, as for any instruction.
- **Both Providers must behave the same.** The two CLIs discover, trust and load skills differently, and Studio keeps the repository's own skills and Studio's own skills apart.
- **A Run must be reproducible.** What the agent had is part of what the Run did.
- **One operator, one dedicated server.** Copying an existing skill into the definitions Repository is the only import needed.

## Decision

- **Skills are folders in the definitions Repository.** A Skill definition is the folder `skills/<name>/` with the entry file `skills/<name>/SKILL.md`. A version is a commit, as for agents.
- **The format is the common skill format:** front matter with name and description, then instructions in Markdown, so an existing skill can be copied in. Unknown front matter keys are refused. A key that asks for tools, permissions, hooks, MCP servers, memory or isolation is refused with its own reason, and so is a skill with an inline shell line. The exact limits belong to the validation's code, not to this document.
- **A skill belongs to no Provider.** Agents of both Providers can name it.
- **An agent names its skills.** The agent's entry file lists them, and a Run gets exactly those. The built-in Default agents get none of Studio's skills, so a Run with a Default agent is unchanged, byte for byte.
- **A missing or invalid skill makes the agent that names it invalid.** The agent is listed with the reason and cannot be chosen.
- **Both Providers get skills the same way.** The agent worker writes the named skills beside the Run, in a place outside everything a CLI discovers by itself, and the instructions list each skill's name, description and path. The agent reads a skill when the task fits. Scripts and assets follow the rule for an agent's files: allowed in what the operator published, never run by themselves, rebuilt from Studio's copy before every Run step, and never committed or pushed.
- **No CLI command changes.** Nothing is added to the options either CLI is started with, so neither [Provider compliance record](../../engineering/provider-compliance/README.md) is amended: the approved mode, options and credentials stay exactly as recorded. The skills are plain files read through the agent's normal file tools, the same as the files of an agent's folder (ADR 0005), which needed no amendment either.
- **A Run's record gains the names of its skills** at the commit it already records, and its Follow-ups use the same ones.
- **The repository's own skills stay as they are.** How they reach a Run (ADR 0002) is unchanged.
- **Ranking of instruction sources**, word for word the same in ADR 0002, ADR 0005 and here. Sources rank: Studio's base rules (fixed), then the chosen Agent definition, then Studio's own skills, then the repository's `repo:` skills and subagents, then skills synced from the operator's account.
- **Ownership.** The `agents` module owns skills as a model distinct from the Agent definition, with its own validation and list. The editor, Draft and Publish of ADR 0005 cover skill files with no new mechanism.

## Considered Options

- **Skills only inside an agent's own folder.** Rejected: a skill used by several agents would be copied into each, and the copies drift apart.
- **Skills delivered through each CLI's own skill mechanism, for example as a per-Run plugin.** Rejected for now: it needs a new option on the CLI command for each Provider, so an amendment of both compliance records, and the two CLIs would differ in what they load and trust. It stays an upgrade path.
- **Skills written beside the Run and listed in the instructions, naming them in the agent.** Chosen: one mechanism for both Providers, no CLI change, and a Run gets exactly what its agent names.
- **Every skill of the definitions Repository given to every Run.** Rejected: a Run would carry guidance that has nothing to do with its agent, and the Run's record could not say which skills mattered.

## Consequences and accepted risks

- **A published skill is trusted guidance that can carry scripts.** The operator wrote it, so it ranks above the repository's own skills; it is bounded by the guardrails and the operating-system user, as any command is.
- **The agent may not read a skill.** Delivery by listing relies on the agent's judgement; a CLI's native mechanism would make the offer more reliable. That is the reason for the upgrade path.
- **Same-user boundary.** A skill sits in the Run's directory as the agent's files do, so an agent could rewrite it during a step; the next step rebuilds it from Studio's copy.
- **Anyone who can push to the definitions Repository changes every later Run that names the skill,** as ADR 0005 states for agents.
- **One more model in `agents`** to validate, list and test.

## Upgrade paths

Native delivery through a CLI's own skill mechanism or a per-Run plugin, a skill chosen per Run or per Follow-up, subagents, several definitions Repositories and importing from a registry each need a separate decision. Native delivery also needs an amendment of the affected compliance record.
