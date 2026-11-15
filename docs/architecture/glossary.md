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
One execution of an agent on an operator's task in a Project, from the operator's start to its result.
_Avoid_: Job, session, task run

**Working copy**:
A Run's own clone of the Repository, on a branch named for the Run. It is not the Project's Clone.
_Avoid_: Worktree, workspace, checkout

### Cross-cutting

**Agent worker**:
The process that carries out Runs by driving the agent CLIs, on the agents' side of the isolation boundary.
_Avoid_: Executor, agent host

**Agent account**:
The separate Git host account through which agents push their Run branches and open pull requests; it is not the operator's account.
_Avoid_: Bot account, machine user, operator account
