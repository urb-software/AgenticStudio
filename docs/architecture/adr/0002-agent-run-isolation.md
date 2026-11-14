---
status: accepted
date: 2026-11-14
---

# Agent runs are isolated from Studio by an operating-system user boundary

Decided by the operator in the refinement of the agent execution proof Epic (#84), 2026-11-14.

Studio (web, API, database, secrets, repository copies) runs in containers under the system Docker daemon, which only root controls. Agents, and the agent worker that starts them, run on the host as an ordinary user (the **agent user**) that is never in the `docker` group and has no passwordless `sudo`. The operating system boundary between that user and root-controlled Docker is the security boundary; everything the agent CLIs do themselves is a guardrail on top of it. We chose this because the operator's projects need Docker Compose for their tests, the CLIs authenticate with the operator's own subscription login, and the agents must be treated as potentially misled by repository and package content.

## Context

- **One operator, one dedicated server.** No other tenants, no production credentials on the server, backups kept off the server.
- **Projects whose tests need Docker Compose.** Integration and end-to-end tests start Compose stacks, so an agent that runs the tests needs a Docker daemon.
- **Subscription-authenticated CLIs.** The official agent CLIs run non-interactively and log in with the operator's own subscription login; an API key is the fallback. Whether this is permitted is validated per provider ([Security](../../engineering/security.md) §2, records B6 and B7).
- **Agents may be misled.** Repository files, Issues, dependencies and tool output can carry prompt injection or malicious code, so an agent run is treated as untrusted code with the agent user's rights.

## Decision

- **Two sides, separated by the operating system.** Studio runs in containers managed by the system Docker daemon, which only root controls. Agents and the agent worker run on the host as the agent user: not in the `docker` group, no passwordless `sudo`, no access to Studio's files.
- **Rootless Docker for agents.** The agent user has its own private Docker daemon, so agents can run Compose stacks, integration and end-to-end tests without any access to the system daemon or its socket.
- **The agent worker runs on the host as the agent user** and always calls Studio; Studio never reaches into the host. The worker's token is limited to handling runs.
- **A working copy per run.** Each run gets its own clone, made from a per-project cache, at the exact commit Studio recorded, on a branch named for the run. The agent definition, the task and the logs sit beside the working copy, outside the repository.
- **A separate agent account on the Git host.** Agents push their own run branches and open pull requests through an account that is not the operator's, with a token limited to the managed repositories. Branch protection keeps protected branches under the operator's approval, and merge stays with the operator. Studio's Deploy keys never reach the agent.
- **CLI hooks and permission rules are guardrails, not the security boundary.** They guard against destructive mistakes; a misled agent is assumed able to get around them, and the operating system boundary must hold without them.
- **Runs are a sequence of non-interactive CLI steps.** Each step streams events, ends with a structured result, and can be resumed by session id. An agent question pauses the run ("waiting for operator"); the operator's answer resumes the same session.
- **Intended use, to be validated with the providers:** runs start only on the operator's action, at most two at a time, on the operator's own projects, authenticated with the operator's own subscription login; an API key is the fallback.

## Considered Options

- **Agents in containers without Docker access.** A container per run under the system daemon, with no Docker socket inside. Rejected: the projects' tests need Docker Compose, and giving a container a Docker daemon means either the system socket (root-equivalent) or a nested privileged daemon.
- **A microVM sandbox per run.** Strong isolation, with a full Docker daemon inside each VM. Rejected for now: it needs hardware virtualisation on the server, image and networking tooling, and much more operational work than a single-operator first version justifies. Kept open as a later runner behind the same interface.
- **A separate machine for agent runs.** Physical separation from Studio. Rejected for now: a second server to run, secure and pay for, while the operating-system boundary on one server is enough for one operator with no production credentials on it. Kept as an upgrade path.
- **Everything as one user with the system Docker.** Simplest to set up. Rejected: access to the system Docker daemon is equivalent to root, so any misled agent could take over Studio, its secrets and the server.
- **The operating-system user boundary with rootless Docker.** Chosen.

## Consequences and accepted risks

- **The agent can read what its user can read.** That includes its own CLI logins, the agent account's token and the worker's token. A misled agent could misuse or leak them; the tokens are therefore kept narrow (managed repositories only; run handling only) and revocable.
- **Both providers share one host user.** One provider's agent can read the other provider's login, and the operating system does not separate one run's working copy from another's or from another project's. Hooks and permission rules guard against mistakes there; dedicated users per provider are an upgrade path.
- **A kernel vulnerability could cross the boundary.** The model relies on the kernel separating users and on rootless Docker's user namespaces. Keeping the host patched is part of the model.
- **No production credentials may be placed on the server**, on either side of the boundary.
- **Off-server backups are required**, so that a compromised or wiped server can be rebuilt.
- **Studio's own Git rules do not cover the agent's Git commands.** The hardened Git adapter ([Security](../../engineering/security.md) §4) serves Studio's own operations; what an agent does with Git in its working copy is limited by the agent user's rights and the agent account's token.

## Upgrade paths

Each keeps the same runner interface, so the run model and Studio's side stay unchanged:

- **Dedicated host users per provider**, so that one provider's agent cannot read the other's logins or working copies.
- **Short-lived tokens for the agent account**, issued per run instead of one long-lived token.
- **A separate machine for agent runs**, with the worker still calling Studio over the network.

## Pending inputs

- **Provider compliance records** (B6, B7), including whether subscription login is permitted for this use. A provider stays disabled until its record is `Approved`.
- **A short trial of rootless Docker on the target server** with one real project: the Compose stack comes up and its tests pass. If the trial fails, this decision is revisited.

## Open decisions

Not decided in refinement; each blocks Ready of the stories it touches.

- **Agent configuration found inside a project's repository** (hooks, settings, MCP servers). Non-interactive runs load it without a trust prompt. Options:
  - Ignore it: runs start the CLI so that project-level configuration is not loaded, and only Studio's agent definition applies.
  - Load it only after the operator has reviewed and approved it for that project, and again whenever it changes.
  - Remove or replace it in the working copy before each run.
  - Load it as is, relying on the operating-system boundary alone.
- **Test environment files:** whether Studio supplies them to a run in the first version, or the project's tests must run without them.
- **Concurrency per project:** whether at most one run per project may be active at a time.
- **Working-copy retention:** how long finished working copies are kept, and what removes them.
- **The per-project cache:** where it lives and how it is kept current, given that the agent user cannot read Studio's Clones.
