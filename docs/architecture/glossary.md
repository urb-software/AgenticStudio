# Glossary — AI Agent Studio

The shared domain language of AI Agent Studio: one context, grouped by business module. Terms only; rules and decisions live in the canonical docs and in [ADRs](adr/).

## Language

### `projects`

**Project**:
The operator's workspace around one Repository.
_Avoid_: App, solution

**Repository**:
The remote Git repository connected to a Project; a Project has at most one.
_Avoid_: Repo, remote, upstream

**Clone**:
Studio's own local copy of the Repository.
_Avoid_: Checkout, mirror, local repository

**Integration branch**:
The branch of the Repository that agents start from and that approved work merges into. It is not the Git host's "default branch".
_Avoid_: Default branch, main branch

**Connect**:
The operator's action that attaches a Repository to a Project.
_Avoid_: Link, import, add repository

**Disconnect**:
The operator's action that detaches the Repository from its Project.
_Avoid_: Unlink, remove, delete repository

**Fetch**:
The operator's action that brings the Clone up to date with the Repository.
_Avoid_: Sync, pull, refresh

**Deploy key**:
The per-project SSH key pair Studio generates to reach a private Repository.
_Avoid_: SSH key, access key, credential

### `executions`

**Run**:
One execution of an agent on an operator's Task in a Project, from the operator's start to its result.
_Avoid_: Job, session, task run

**Task**:
The operator's instruction that starts a Run.

**Run step**:
One non-interactive execution of the agent CLI within a Run. A Run consists of one or more Run steps.
_Avoid_: Turn, step (unqualified), iteration

**Working copy**:
A Run's own clone of the Repository, on its Run branch. It is not the Project's Clone.
_Avoid_: Worktree, workspace, checkout

**Run branch**:
The branch in a Working copy that holds a Run's commits.

**Run limits**:
The limits a Run gets from Studio's configuration when it starts: the longest a Run step may work, the most Run steps the Run may take, and the longest it may wait for the operator. A Run step over its time limit ends the Run as timed out; one more Run step than allowed ends it as failed; a Run waiting too long is cancelled by Studio.
_Avoid_: Quota, timeout (unqualified)

**Cancel**:
The operator's stop of a Run. A queued or waiting Run is cancelled at once; a running Run gets a cancel request that the agent worker carries out by stopping the Run step, and the Run ends as cancelled. Nothing is pushed; the Working copy is kept.
_Avoid_: Abort, kill

### Cross-cutting

**Provider**:
The agent CLI product that carries out a Run (Claude Code or Codex).
_Avoid_: Agent, model, vendor

**Environment file**:
A per-project file of test settings that Studio places in a Working copy.

**Agent worker**:
The process that carries out Runs by driving the agent CLIs, on the agents' side of the isolation boundary.
_Avoid_: Executor, agent host

**Agent account**:
The separate Git host account through which Run branches are pushed and draft pull requests opened; it is not the operator's account.
_Avoid_: Bot account, machine user, operator account
