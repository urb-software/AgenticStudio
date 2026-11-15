---
status: accepted
date: 2026-11-14
---

# Agent runs are isolated from Studio by an operating-system user boundary

Decided by the operator in the refinement of the agent execution proof Epic (#84), 2026-11-14. The decisions that were still open were closed by the operator in the refinement of the run stories, 2026-11-15 (see [Run decisions](#run-decisions-2026-11-15)).

Studio (web, API, database, secrets, repository copies) runs in containers under the system Docker daemon, which only root controls. Agents, and the agent worker that starts them, run on the host as an ordinary user (the **agent user**) that is never in the `docker` group and has no passwordless `sudo`. The operating system boundary between that user and root-controlled Docker is the security boundary; the CLIs' hooks and permission rules are guardrails on top of it. We chose this because the operator's projects need Docker Compose for their tests, the CLIs authenticate with the operator's own subscription login, and the agents must be treated as potentially misled by repository and package content.

## Context

- **One operator, one dedicated server.** No other tenants, no production credentials on the server, backups kept off the server.
- **Projects whose tests need Docker Compose.** Integration and end-to-end tests start Compose stacks, so an agent that runs the tests needs a Docker daemon.
- **Subscription-authenticated CLIs.** The official agent CLIs run non-interactively and log in with the operator's own subscription login; an API key is the fallback. Whether this is permitted is validated per provider ([Security](../../engineering/security.md) §2, records B6 and B7).
- **Agents may be misled.** Repository files, Issues, dependencies and tool output can carry prompt injection or malicious code, so an agent run is treated as untrusted code with the agent user's rights.

## Decision

- **Two sides, separated by the operating system.** Studio runs in containers managed by the system Docker daemon, which only root controls. Agents and the agent worker run on the host as the agent user: not in the `docker` group, no passwordless `sudo`, no access to Studio's files.
- **Rootless Docker for agents.** The agent user has its own private Docker daemon, so agents can run Compose stacks, integration and end-to-end tests without any access to the system daemon or its socket.
- **The agent worker runs on the host as the agent user** and always calls Studio; Studio never reaches into the host. The worker's token is limited to handling runs.
- **A working copy per run.** Each run gets its own clone, made from a per-project cache, at the exact commit Studio recorded, on a branch named for the run. The agent definition, the task and the logs sit beside the working copy, outside the repository. Working copies belong to the `executions` module, which owns Runs (operator decision, 2026-11-15): their creation, retention and removal follow the Run's state. `projects` supplies the remote and the recorded commit through its public entry point and keeps Studio's own Clones.
- **A separate agent account on the Git host.** Run branches are pushed and pull requests opened through an account that is not the operator's, with a token limited to the managed repositories. Branch protection keeps protected branches under the operator's approval, and merge stays with the operator. Studio's Deploy keys never reach the agent.
- **CLI hooks and permission rules are guardrails, not the security boundary.** They guard against destructive mistakes; a misled agent is assumed able to get around them, and the operating system boundary must hold without them.
- **Runs are a sequence of non-interactive CLI steps.** Each step streams events, ends with a structured result, and can be resumed by session id. An agent question pauses the run ("waiting for operator"); the operator's answer resumes the same session.
- **Intended use, to be validated with the providers:** runs start only on the operator's action, at most two at a time, on the operator's own projects, authenticated with the operator's own subscription login; an API key is the fallback.

### Run decisions (2026-11-15)

Operator decisions in the refinement of the run stories, 2026-11-15.

- **Providers.** Both Claude Code and Codex are in scope of Epic #84; Codex follows Claude Code.
- **Configuration found in a project's repository.** Nothing from the repository that executes code or changes permissions is loaded: no hooks, no MCP servers, no settings files. The text of the repository's instruction files (`CLAUDE.md`, `AGENTS.md`) is used:
  - For Claude Code, the agent worker injects that text, because the option that excludes project settings also excludes project instructions, skills and subagents (see [Claude Code finding](#claude-code-finding-2026-11-15)).
  - For Codex, the working copy is marked untrusted, which loads `AGENTS.md` and skips project configuration.
  - Imports inside instruction files are followed only within the working copy.
  - **Known limitation and follow-up:** the repository's own skills and subagents are not available to Claude Code in the first version.
- **Environment files.** Studio supplies one Environment file per project, holding test values only; the agent can read it.
- **Concurrency.** At most one active run per project, and two across the server; further runs wait in the queue.
- **Retention.** A finished working copy is kept seven days, and at most ten are kept per project; after that it is removed together with its containers and volumes.
- **Per-project cache.** Kept on the agent side and refreshed by the agent worker before each run.
- **Delivery.** The agent writes the pull request title and description in its result. The agent worker commits what is left, pushes the run branch and opens a draft pull request through the agent account. Nothing is pushed for a failed, cancelled or timed-out run. The agent account's login lives on the agent side; Studio does not store it.
- **Agent questions.** An agent question arrives in the structured result of a run step, because the CLIs' built-in ask-the-user tools are unavailable in unattended runs.
- **Codex sandbox (conditional on the rootless Docker trial, #94).** Codex's own sandbox is kept if rootless Docker is reachable through it. Otherwise Codex runs with full access under the agent user; the consequence for run and project separation is stated under [Consequences](#consequences-and-accepted-risks). The trial records which of the two applies.
- **Out of scope, recorded:** follow-up instructions on a finished run; they belong to the next Epic.

### Claude Code finding (2026-11-15)

Found in the refinement of the run stories, 2026-11-15: with `--setting-sources user`, Claude Code does not load the project's `CLAUDE.md`, rules, skills, commands and subagents, in addition to its settings files and `.mcp.json`. The accepted [Claude Code compliance record](../../engineering/provider-compliance/2026-11-14-claude-code-cli.md) names only settings files and `.mcp.json`. The record is not rewritten; the finding is an item for its next review (see [Pending inputs](#pending-inputs)).

## Considered Options

- **Agents in containers without Docker access.** A container per run under the system daemon, with no Docker socket inside. Rejected: the projects' tests need Docker Compose, and giving a container a Docker daemon means either the system socket (root-equivalent) or a nested privileged daemon.
- **A microVM sandbox per run.** Strong isolation, with a full Docker daemon inside each VM. Rejected for now: it needs hardware virtualisation on the server, image and networking tooling, and much more operational work than a single-operator first version justifies. Kept open as a later runner behind the same interface.
- **A separate machine for agent runs.** Physical separation from Studio. Rejected for now: a second server to run, secure and pay for, while the operating-system boundary on one server is enough for one operator with no production credentials on it. Kept as an upgrade path.
- **Everything as one user with the system Docker.** Simplest to set up. Rejected: access to the system Docker daemon is equivalent to root, so any misled agent could take over Studio, its secrets and the server.
- **The operating-system user boundary with rootless Docker.** Chosen.

## Consequences and accepted risks

- **The agent can read what its user can read.** That includes its own CLI logins, the agent account's token and the worker's token. A misled agent could misuse or leak them; the tokens are therefore kept narrow (managed repositories only; run handling only) and revocable.
- **Both providers share one host user.** One provider's agent can read the other provider's login. With one agent user, user permissions alone do not separate one run's working copy from another's or from another project's files. Dedicated users per provider are an upgrade path.
- **A kernel vulnerability could cross the boundary.** The model relies on the kernel separating users and on rootless Docker's user namespaces. Keeping the host patched is part of the model.
- **No production credentials may be placed on the server**, on either side of the boundary.
- **Off-server backups are required**, so that a compromised or wiped server can be rebuilt.
- **Runs and projects are kept apart by guardrails only (operator decision, 2026-11-15).** For the first version, cross-run and cross-project separation relies on the CLIs' hooks and permission rules. A misled agent could get around them and read or change another run's working copy or another project's files through the agent user's rights. The operator accepts that risk for the intended use: runs started only on the operator's action, on the operator's own projects, at most two at a time. Confinement inside the agent user (mount and user namespaces, or a rootless container per run) was not chosen: the agent user's own Docker daemon can mount anything that user can read, so it would bypass such confinement as soon as agents use Docker.
- **If Codex runs with full access, it loses the Codex sandbox as an extra guardrail (applies only if the rootless Docker trial, #94, finds Docker unreachable through the Codex sandbox).** A Codex run can then read and change anything the agent user can, including other runs' working copies, other projects' files and both providers' logins. Separation between runs and projects for Codex then rests on the CLIs' hooks and permission rules only, as accepted above. Keeping the sandbox does not confine Codex either once rootless Docker is reachable, since the agent user's own Docker daemon can mount anything that user can read; it is an extra guardrail, not a boundary. The operating-system boundary toward Studio is unchanged either way.
- **Studio's own Git rules do not cover the agent's Git commands.** The hardened Git adapter ([Security](../../engineering/security.md) §4) serves Studio's own operations; what an agent does with Git in its working copy is limited by the agent user's rights and the agent account's token.

## Upgrade paths

Each keeps the same runner interface, so the run model and Studio's side stay unchanged:

- **Dedicated host users per provider**, so that one provider's agent cannot read the other's logins or working copies.
- **Dedicated host users per project**, each with its own CLI logins, per-project cache and rootless Docker daemon. This keeps different projects apart even while agents use Docker, since each project's daemon sees only its own user's files. Runs of the same project would still share a user.
- **Short-lived tokens for the agent account**, issued per run instead of one long-lived token.
- **A separate machine for agent runs**, with the worker still calling Studio over the network.

## Pending inputs

- **Provider compliance records** (B6, B7), including whether subscription login is permitted for this use. A provider stays disabled until its record is `Approved`.
- **A short trial of rootless Docker on the target server** with one real project (#94): the Compose stack comes up and its tests pass. If the trial fails, this decision is revisited. The trial also records whether rootless Docker is reachable through the Codex sandbox, which settles the [Codex sandbox](#run-decisions-2026-11-15) posture.
- **Next review of the Claude Code compliance record:** add the [Claude Code finding](#claude-code-finding-2026-11-15) about what `--setting-sources user` excludes.
