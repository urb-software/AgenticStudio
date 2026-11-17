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
One execution of an agent on an operator's Task in a Project, from the operator's start to its latest result. A finished Run can be reopened by a Follow-up; one Run corresponds to at most one pull request.
_Avoid_: Job, session, task run

**Task**:
The operator's instruction that starts a Run.

**Follow-up**:
The operator's further instruction to a finished Run: the agent continues the same agent session and the Run delivers to the same pull request. It is not an Answer: a Follow-up reopens a finished Run.
_Avoid_: New task, re-run, continuation

**Bring up to date**:
The operator's request to merge the Integration branch into a Run's branch, so that its pull request stops being behind and may stop conflicting. It is a Follow-up of its own source (same eligibility, step allowance and concurrency limits, same agent session): the agent worker fetches the Integration branch, merges it with a merge commit (never a rebase, never a force-push), and resumes the agent to resolve any conflicts and to run the project's checks. A part that does not end well (conflicts unresolved, the agent fails, a timeout or a cancel) is undone: the merge is aborted, the Run branch goes back to its commit before the request, and nothing is pushed. When the branch already has everything, or the Integration branch cannot be fetched, nothing changes, no agent starts, and the Run keeps its earlier result with the reason in its conversation.
_Avoid_: Rebase, sync, update branch

**Prepared Follow-up**:
The text Studio builds for the operator to review before it becomes a Follow-up, for example from the failing Pull request checks: the operator can leave parts out, edit it freely, and send or discard it. It is never sent by itself, and a Run has at most one; a sent one is stored as a Follow-up marked with its source.
_Avoid_: Draft Follow-up, automatic Follow-up

**Run step**:
One non-interactive execution of the agent CLI within a Run. A Run consists of one or more Run steps.
_Avoid_: Turn, step (unqualified), iteration

**Run log**:
A Run's stored sequence of Run events, numbered per Run: its durable record of what the agent did. The live view streams it; it is redacted and capped before storage.
_Avoid_: Transcript, console, output (for the whole log)

**Run event**:
One entry of a Run log: an agent message, a command, its output, the start or end of a Run step, or a notice about the log itself (e.g. "log truncated").
_Avoid_: Line, log line (an event can span lines)

**Run diff**:
What a Run changed in its Working copy, uncommitted changes included, computed by the agent worker after every Run step's result: "whole run" (since the start commit) and "since previous result". Studio keeps the latest of each, redacted, and shows them on the Run page's Changes tab.
_Avoid_: Patch (one file's part of it), changeset, PR diff (the pull request is GitHub's)

**Pull request state**:
Where a Run's pull request stands on the Git host: draft, open, merged, closed or missing (the pull request or its Run branch was not found: gone, or not visible to the Agent account), with the Run branch's position behind and ahead of the Integration branch and whether the host reports it mergeable. Only the agent worker reads it, through the Agent account, when Studio asks (a Lookup); Studio keeps the last known state and when it was read. A Follow-up is refused for a merged, closed or missing pull request, and allowed while the state is unknown.
_Avoid_: PR status, sync

**Lookup**:
Studio's request to the agent worker to read something from the Git host, such as a Run's Pull request state. Any connected agent worker answers it with read access only; it needs no Working copy and starts no agent.

**Working copy**:
A Run's own clone of the Repository, on its Run branch. It is not the Project's Clone.
_Avoid_: Worktree, workspace, checkout

**Run branch**:
The branch in a Working copy that holds a Run's commits.

**Run limits**:
The limits a Run gets from Studio's configuration when it starts: the longest a Run step may work, the most Run steps the Run or a Follow-up may take, the most Run steps the Run may take in total before it accepts no more Follow-ups, and the longest it may wait for the operator. A Run step over its time limit ends the Run as timed out; one more Run step than allowed ends it as failed; a Run waiting too long is cancelled by Studio.
_Avoid_: Quota, timeout (unqualified)

**Question**:
What the agent asks the operator when it is blocked on a decision that is the operator's. It ends a Run step with a `needs_input` result (text, offered options, a recommendation); the Run then waits for the operator. Shown as plain text.
_Avoid_: Prompt, approval request

**Answer**:
The operator's reply to a Question. It queues the Run again, and the agent worker that holds its Working copy resumes the same agent session with the answer as the next Run step. It is not a Follow-up: an Answer replies to a Question while the Run waits.
_Avoid_: Reply (for the stored record)

**Conversation**:
The ordered list of a Run's Questions, Answers and Follow-ups, from the Task to the Run's latest result. It is distinct from a part of a Run, which is one segment between two ends of the agent's work (the Task, or a Follow-up, up to the result it ends with). The name "conversation" is proposed; the operator confirms it in review.
_Avoid_: Thread, history

**Cancel**:
The operator's stop of a Run. A queued or waiting Run is cancelled at once; a running Run gets a cancel request that the agent worker carries out by stopping the Run step, and the Run ends as cancelled. Nothing is pushed; the Working copy is kept.
_Avoid_: Abort, kill

**Reported checks**:
What the agent says it ran in a Run step, and with what outcome, in its result.
_Avoid_: Checks (unqualified), test results

**Pull request checks**:
The Git host's check results for a Run's pull request.
_Avoid_: Checks (unqualified), CI status

**Review comment**:
A comment on a Run's pull request on the Git host: a review's summary with its verdict, an inline comment on the diff, or a conversation comment. Anyone can write one on a public pull request, so it is untrusted text: the operator loads them on request, sees them (their own, by the configured GitHub login, preselected; everyone else's collapsed and unselected), and sends only the ones they choose, as a Follow-up prepared from them.
_Avoid_: Feedback, remark

### Architecture vocabulary

Terms of the API's structure rules ([Backend](backend.md) §3), not of the business domain.

**Aggregate root**:
The one object through which a group of objects that must stay consistent is created, changed and stored. Anything with its own repository is an aggregate root; it refers to other roots by id only.

**Entity**:
An object with an identity that outlives its values, and rules about what can happen to it. A root is an entity; a child entity has its identity only within its root (a Run step within its Run).

**Value object**:
An immutable object defined by its values, with no identity of its own; a change returns a new value. It owns the rules about the concept it names (a Run's state with its transitions).

**Snapshot**:
An entity's current values as read-only plain data, produced by the entity. It is what a handler returns where its result contains a whole aggregate; an entity class itself never leaves the application layer.

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
The separate Git host account through which Run branches are pushed, draft pull requests opened, and a pull request's state, Pull request checks and Review comments read; it is not the operator's account.
_Avoid_: Bot account, machine user, operator account
