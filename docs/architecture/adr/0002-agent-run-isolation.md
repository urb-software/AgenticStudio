---
status: accepted
date: 2026-11-14
---

# Agent runs are isolated from Studio by an operating-system user boundary

Decided by the operator in the refinement of the agent execution proof Epic (#84), 2026-11-14. The decisions that were still open were closed by the operator in the refinement of the run stories, 2026-11-15 (see [Run decisions](#run-decisions-2026-11-15)). Follow-ups to a finished Run, and the retention change they need, were decided by the operator in the refinement of Epic #139, 2026-11-16 (see [Follow-up decisions](#follow-up-decisions-2026-11-16)). Merging a Run's pull request and closing it from Studio, which needs a credential on Studio's side, was decided by the operator in the refinement of Epic #258, 2026-11-21 (see [Merge decisions](#merge-decisions-2026-11-21)).

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
- **A separate agent account on the Git host.** Run branches are pushed and pull requests opened through an account that is not the operator's, with a token limited to the managed repositories. Branch protection keeps protected branches under the operator's approval. The Agent account never merges: an operator's merge or close from Studio uses a separate Merge credential on Studio's side (see [Merge decisions](#merge-decisions-2026-11-21)). Studio's Deploy keys never reach the agent. Since 2026-11-16 the agent worker also reads pull request state, Pull request checks and Review comments through it (see [Follow-up decisions](#follow-up-decisions-2026-11-16)).
- **CLI hooks and permission rules are guardrails, not the security boundary.** They guard against destructive mistakes; a misled agent is assumed able to get around them, and the operating system boundary must hold without them.
- **Runs are a sequence of non-interactive CLI steps.** Each step streams events, ends with a structured result, and can be resumed by session id. An agent question pauses the run ("waiting for operator"); the operator's answer resumes the same session.
- **Intended use, to be validated with the providers:** runs start only on the operator's action, at most two at a time, on the operator's own projects, authenticated with the operator's own subscription login; an API key is the fallback. Restated unchanged for Follow-ups on 2026-11-16 (see [Follow-up decisions](#follow-up-decisions-2026-11-16)).

### Run decisions (2026-11-15)

Operator decisions in the refinement of the run stories, 2026-11-15.

- **Providers.** Both Claude Code and Codex are in scope of Epic #84; Codex follows Claude Code.
- **Configuration found in a project's repository.** Nothing from the repository that executes code or changes permissions is loaded: no hooks, no MCP servers, no settings files. The text of the repository's instruction files (`CLAUDE.md`, `AGENTS.md`) is used:
  - For Claude Code, the agent worker injects that text, because the option that excludes project settings also excludes project instructions, skills and subagents (see [Claude Code finding](#claude-code-finding-2026-11-15)).
  - For Codex, the working copy is marked untrusted, which skips project configuration. **Correction (controlled smoke of #106, 2026-11-16):** Codex 0.169.0 skips an untrusted project's `AGENTS.md` too, so the agent worker injects its text, as for Claude Code. The intent of this decision is unchanged.
  - **Known limitation (controlled smoke of #106, 2026-11-16):** for Codex, the repository's skills are still offered to the agent in an untrusted project, and Codex documents no setting that disables project skills; their text reaches the agent as untrusted input, like `AGENTS.md`.
  - Imports inside instruction files are followed only within the working copy.
  - **Skills and subagents for Claude Code (decided 2026-11-19, Issue #109):** the repository's skills and subagents reach Claude Code through a sanitized per-Run plugin (`--plugin-dir`, prefix `repo:`), built from Git at the start commit. They are untrusted guidance like `CLAUDE.md`: `allowed-tools`, `hooks`, `mcpServers`, `permissionMode`, `memory` and `isolation` are dropped, a skill with a shell line is left out, and the managed settings set `disableSkillShellExecution`. Sources rank: Studio's base rules (fixed), then the chosen Agent definition, then Studio's own skills, then the repository's `repo:` skills and subagents, then skills synced from the operator's account. The chosen Agent definition is decided in [ADR 0005](0005-agent-definitions-in-git.md) and Studio's own skills in [ADR 0006](0006-skill-definitions.md), which delivers them beside the Run, not through this plugin. Residual risk, same-user boundary as for the other Run files: the plugin directory is in the Run's directory, so an agent could rewrite it during a step. A plugin skill's `allowed-tools` is honoured in `-p` runs, so a planted skill could gain tools for the rest of the step if the CLI reloads skills (the same class as `~/.claude/skills`). Bounds: the next step rebuilds the plugin from Git, the managed deny rules and the guard hook still run, and the OS user is the boundary.
- **Environment files.** Studio supplies one Environment file per project, holding test values only; the agent can read it.
- **Concurrency.** At most one active run per project, and two across the server; further runs wait in the queue.
- **Retention** (updated in the refinement of Epic #139, 2026-11-16). A Run with an open pull request keeps its working copy until the pull request is merged or closed plus twenty-four hours, or until thirty days pass without activity on the Run, whichever comes first. Other finished Runs keep their working copy seven days from the Run's latest result (its last activity: a Run step, an Answer or a Follow-up). At most ten working copies are kept per project, but that limit does not remove a Run with an open pull request. A working copy is removed together with its containers and volumes. The consequence for disk use is stated under [Consequences](#consequences-and-accepted-risks).
- **Per-project cache.** Kept on the agent side and refreshed by the agent worker before each run.
- **Delivery.** The agent writes the pull request title and description in its result. The agent worker commits what is left, pushes the run branch and opens a draft pull request through the agent account. Nothing is pushed for a failed, cancelled or timed-out run. The agent account's login lives on the agent side; Studio does not store it.
- **Agent questions.** An agent question arrives in the structured result of a run step, because the CLIs' built-in ask-the-user tools are unavailable in unattended runs.
- **Codex sandbox: kept.** The operator's rule was to keep Codex's own sandbox if rootless Docker is reachable through it, and otherwise to run Codex with full access under the agent user. The [rootless Docker trial](0002-trial-rootless-docker.md) (#94, 2026-11-15) found Docker reachable from `workspace-write` once network access is enabled, so Codex runs with `--sandbox workspace-write` and `sandbox_workspace_write.network_access=true`. The consequences are stated under [Consequences](#consequences-and-accepted-risks).
- **Follow-up instructions on a finished run:** out of scope of Epic #84; decided on 2026-11-16 as part of the same Run (see [Follow-up decisions](#follow-up-decisions-2026-11-16)).

### Follow-up decisions (2026-11-16)

Operator decisions in the refinement of Epic #139, 2026-11-16. They change the retention rule above in place.

- **A Follow-up is part of the same Run.** A finished Run can be reopened by a Follow-up: the agent continues the same agent session in the same working copy, on the same run branch, and delivers to the same pull request. One Run corresponds to at most one pull request.
- **A Run without a pull request.** A Follow-up on a Run that has no pull request yet and now has commits opens a draft pull request, as in a first delivery.
- **Eligibility.** Any finished Run (succeeded, failed, timed out, cancelled) whose working copy and agent session still exist can take a Follow-up. A Run whose pull request is merged or closed cannot; the operator then starts a new Run.
- **Limits.** A Follow-up counts against the same concurrency limits as any run (one active per project, two across the server). Each Follow-up gets ten Run steps; a Run accepts no more Follow-ups after fifty Run steps in total.
- **A failed, timed-out or cancelled Follow-up pushes nothing.** Its commits stay in the working copy, and the next Follow-up can continue from them.
- **The agent account's use is extended.** Besides pushing run branches and opening draft pull requests, the agent worker reads pull request state, Pull request checks and Review comments through the agent account. (Since 2026-11-21 Studio's side also holds a Merge credential, used only for an operator's merge or close; see [Merge decisions](#merge-decisions-2026-11-21).) Pull request state is refreshed when the Run page is opened, before every Follow-up, and once a day for retention.
- **Intended use unchanged.** Every agent CLI start, including a Follow-up, follows an operator action. The daily pull request state refresh starts no agent, and nothing from the Git host starts one either. How content from the Git host may reach an agent, and how a run branch is brought up to date, are rules in [Security](../../engineering/security.md) §2 and §4.

### Merge decisions (2026-11-21)

Decided by the operator in the refinement of Epic #258 (approve and merge a Run inside Studio). This narrows two rules of the earlier decisions: "Studio's side holds no Git host API credential" and "only the agent worker talks to the Git host's API".

- **The narrowed rule.** The agent side holds no credential that can merge. Studio's side holds one, the **Merge credential**, used only for an operator's merge or close. The Agent account never gets merge rights, merge is never a worker privilege, and the operator stays the final merge gate.
- **The Merge credential.** A fine-grained token of the operator's Git host account, created by the operator, limited to the managed Repositories, with write access to pull requests and contents. It is one API setting (`STUDIO_MERGE_TOKEN`) in the environment, never in the repository, and it never reaches the agent side. While it is unset, merging and closing are switched off and the Run page says why.
- **What Studio does with it.** At merge time the API reads the pull request, its head commit and its checks itself; what the agent worker reported is not trusted for this. Lookups of pull request state, checks and comments still go through the agent worker. When a branch rule requires an approval, Studio submits the operator's approving review, marks the pull request ready and merges.
- **Standing authorization to delete a Run branch.** Right after a successful merge or a close without merging, Studio deletes that Run's own `agent/…` branch on the Git host, and never any other branch. The Project's Clone is fetched afterwards.
- **Preconditions.** The operator's review in Studio is the independent review, because the author is the agent. Merge is refused while a Pull request check is failing or running, while the pull request conflicts with the Integration branch, and while the Run is active. A Repository with no checks can be merged. There is no override in Studio.
- **The diff the operator approves comes from Studio's side.** Studio fetches the Run branch into the Project's Clone and shows the diff of exactly the commit that will be merged. The Run diff computed by the agent worker is not the basis of an approval.
- **One action.** "Approve and merge" is a single confirmed action. The Merge approval is stored first: who, when, the commit approved and the checks seen. The merge is pinned to the approved commit: if the Run branch moved after the operator looked, it is refused and the operator reviews again. A refusal by the Git host is shown with its reason; the Merge approval stays, marked as not carried out.
- **Merge method.** A setting per Project: squash (default) or merge commit; rebase is not offered. With squash, the pull request's title and description become the commit message.
- **Module.** `executions` owns the Merge approval and the merge, because the pull request and the Run diff live there. `projects` supplies the Clone, its fetch and the merge method setting through its public face.
- **No new Run state.** "Merged" and "closed" stay part of the Pull request state. Working copy retention is unchanged.

The rules that apply are in [Security](../../engineering/security.md) §4 and §7.

### Claude Code finding (2026-11-15)

Found in the refinement of the run stories, 2026-11-15: with `--setting-sources user`, Claude Code does not load the project's `CLAUDE.md`, rules, skills, commands and subagents, in addition to its settings files and `.mcp.json`. The accepted [Claude Code compliance record](../../engineering/provider-compliance/2026-11-14-claude-code-cli.md) names only settings files and `.mcp.json`. The record is not rewritten; the finding is an item for its next review (see [Pending inputs](#pending-inputs)).

### Managed guardrails (2026-11-16)

Note, not a change of the decision (Issue #134). Studio's guardrails for both CLIs (permission rules, deny lists, the PreToolUse hook, Codex's sandbox network, command environment and command rules) moved from files the agent user can write (the Run's directory, `~/.codex`) to the CLIs' **managed configuration**, installed root-owned by the server setup (`/etc/claude-code/managed-settings.json`, `/etc/codex/managed_config.toml`, `/etc/codex/requirements.toml`, the guard script under `/usr/local/lib/agentic-studio/guardrails/`). A same-user agent can no longer change these files, add hooks or permission rules, or switch the hook off, and Studio's hook now runs for Codex (managed hooks need no trust); the hook runs with a cleared environment, so an `env` the agent writes into a settings file Claude Code reloads during a step does not reach it (review of #136). What a same-user agent can still do during a step: write other settings keys into its own user or per-Run settings files (for example an `env` for the CLI and its commands), get around the guard's checks with an interpreter or a script, and read files the guard does not recognise. The agent worker checks the files before every Run step. They stay guardrails: the boundary is still the operating-system user with its rootless Docker daemon, and the accepted risks below are unchanged. Details: [Security](../../engineering/security.md) §2.

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
- **The Codex sandbox is kept with network access on, as an extra guardrail, not a boundary ([trial](0002-trial-rootless-docker.md#codex), 2026-11-15).** Docker is reachable from `workspace-write` only with `sandbox_workspace_write.network_access=true`, so network egress is on inside the Codex sandbox. Docker bind mounts bypass the sandbox's filesystem limits: in the trial a container started from inside the sandbox wrote to the agent user's home directory, while a direct write there was refused. A misled Codex agent can therefore reach anything the agent user can through Docker, including other runs' working copies, other projects' files and both providers' logins; separation between runs and projects for Codex rests on the guardrails, as accepted above. The operating-system boundary toward Studio is unchanged.
- **The operating-system boundary needs native Linux ([trial](0002-trial-rootless-docker.md#security-finding-wsl), 2026-11-15).** With default WSL settings the agent user can run Windows programs through interop and read and write the Windows drive mount, so WSL is not an isolation boundary. The target server is native Linux; a WSL host would need interop and automount disabled, which affects every user of the distro. The server setup checks this ([Security](../../engineering/security.md) §9).
- **Container resource limits need cgroup v2 and systemd.** Under WSL the rootless daemon ran on cgroup v1 with no cgroup driver, so no per-container limits applied. The target server must therefore provide cgroup v2 and run the rootless daemon as a systemd user service; the server setup task (#107) sets this up and checks it.
- **Working copies of Runs with an open pull request stay longer (2026-11-16).** Such a working copy, with its containers and volumes, is kept up to thirty days without activity, or until its pull request is merged or closed plus twenty-four hours, and the per-project limit of ten does not remove it. Disk use on the agent side therefore grows with the number of open pull requests and is no longer bounded by ten working copies per project. The agent worker therefore reports disk use, and Studio refuses to prepare new Runs below a configured free-space threshold.
- **Studio's own Git rules do not cover the agent's Git commands.** The hardened Git adapter ([Security](../../engineering/security.md) §4) serves Studio's own operations; what an agent does with Git in its working copy is limited by the agent user's rights and the agent account's token.

## Upgrade paths

Each keeps the same runner interface, so the run model and Studio's side stay unchanged:

- **Dedicated host users per provider**, so that one provider's agent cannot read the other's logins or working copies.
- **Dedicated host users per project**, each with its own CLI logins, per-project cache and rootless Docker daemon. This keeps different projects apart even while agents use Docker, since each project's daemon sees only its own user's files. Runs of the same project would still share a user.
- **Short-lived tokens for the agent account**, issued per run instead of one long-lived token.
- **A separate machine for agent runs**, with the worker still calling Studio over the network.

## Trial result (2026-11-15)

The rootless Docker trial (#94) ran on 2026-11-15 in WSL on the operator's machine, with AgenticStudio itself as the project, as an ordinary user that is not in the `docker` group and has no passwordless `sudo`. The Compose stack came up under rootless Docker and the unit, integration and end-to-end tests passed; the user could not reach the system Docker socket or read a root-only directory. Docker was reachable from the Codex sandbox only with network access enabled, which settles the [Codex sandbox](#run-decisions-2026-11-15) posture as kept. The decision stands. Because WSL with default settings is not an isolation boundary, the boundary checks are repeated on the target server in the server setup task (#107). Details, changes needed and items for later stories: [trial report](0002-trial-rootless-docker.md).

## Pending inputs

- **Provider compliance records** (B6, B7), including whether subscription login is permitted for this use. A provider stays disabled until its record is `Approved`.
- **Rootless Docker trial (#94): done, 2026-11-15**, in WSL on the operator's machine; the decision stands (see [Trial result](#trial-result-2026-11-15)). It is repeated on the target server, with the boundary checks, in the server setup task (#107).
- **Claude Code compliance record: done, 2026-11-16** (#105): the [Claude Code finding](#claude-code-finding-2026-11-15) about what `--setting-sources user` excludes is in the record's technical findings.
- **Next review of the Codex compliance record:** add the [trial result](0002-trial-rootless-docker.md#codex) that the rootless Docker socket is reachable from `workspace-write` only with `sandbox_workspace_write.network_access=true`, and the resulting posture, sandbox kept (see [Run decisions](#run-decisions-2026-11-15)).
