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

**Host key**:
The public SSH key a Git host presents. Studio connects over SSH only to a host whose key it trusts: one configured for the host, or the one the operator confirmed by its fingerprint.
_Avoid_: Server key, known host

**Remote address**:
The IP address of a Repository's Git host. Whether Studio may connect to it depends on its range (public, private or blocked).
_Avoid_: Remote, IP

**Repository lifecycle**:
The states a connected Repository goes through and which operation each state accepts: `awaiting_key` (an SSH Repository whose Deploy key must still be added on the Git host, then verified); `awaiting_host_key` (the Git host is not trusted yet and the operator must confirm its host key); `connecting` (the first Clone is being made); `ready` (the Clone is up to date as of the last fetch); `fetching` (the Clone is being brought up to date); `failed` (the last connect or fetch failed); `disconnecting` (the operator disconnected it and its data is still being removed; the record goes last).
_Avoid_: Status, workflow

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
Where a Run's pull request stands on the Git host: draft, open, merged, closed or missing (the pull request or its Run branch was not found: gone, or not visible to the Agent account), with the Run branch's position behind and ahead of the Integration branch and whether the host reports it mergeable. The agent worker reads it, through the Agent account, when Studio asks (a Lookup); at merge or close time the API reads the pull request and its checks itself, with the Merge credential. Studio keeps the last known state and when it was read. A Follow-up is refused for a merged, closed or missing pull request, and allowed while the state is unknown.
_Avoid_: PR status, sync

**Lookup**:
Studio's request to the agent worker to read something from the Git host, such as a Run's Pull request state. Any connected agent worker answers it with read access only; it needs no Working copy and starts no agent.

**Merge**:
The operator's action that lands a Run's pull request in the Integration branch from Studio. It is one confirmed action, "Approve and merge", pinned to the approved commit, and uses the Project's merge method (squash by default, or merge commit; rebase is not offered). Studio refuses it with a failing or running Pull request check, a conflict with the Integration branch, an active Run or a Run branch that moved after the operator looked; there is no override. Afterwards Studio deletes the Run branch, fetches the Project's Clone and refreshes the Pull request state. The Agent account never merges.
_Avoid_: Approve (for the whole action), land, ship

**Merge approval**:
The record stored first when the operator presses "Approve and merge": who, when, the commit approved, the merge method used (the Project's setting when it was approved) and the Pull request checks seen. A merge the Git host refuses leaves it in place, marked as not carried out. The operator's review of the Studio-side diff of that commit is the independent review, because the author is the agent.
_Avoid_: Approval (alone), sign-off, review approval

**Close without merging**:
The operator's action that closes a Run's pull request without merging it, when the Run's work is rejected. Studio then deletes the Run branch, fetches the Project's Clone and refreshes the Pull request state.
_Avoid_: Reject, abandon, discard

**Merge review**:
What the Integration branch would gain from a Run's branch, computed on Studio's side: Studio fetches the Run branch into the Project's Clone with the Project's own credentials, merges it with the Integration branch in the Clone (no working tree) and shows the result's changes, redacted. It is the diff the operator reviews before a Merge; the Run diff is the agent worker's account and is not the basis of an approval. A review is of one commit and reads as out of date once the Run branch has another.
_Avoid_: Preview (a different concept: see [Preview](#environments)), PR diff

**Merge credential**:
The token on Studio's side that a Merge or a Close without merging uses on the Git host: a fine-grained token of the operator's Git host account, limited to the managed Repositories, with write access to pull requests and contents. It is never given to the agent side. While it is unset, merging and closing are switched off.
_Avoid_: Merge token (for the concept), operator token, Agent account

**Working copy**:
A Run's own clone of the Repository, on its Run branch. It is not the Project's Clone.
_Avoid_: Worktree, workspace, checkout

**Run branch**:
The branch in a Working copy that holds a Run's commits.

**Run lifecycle**:
A Run's state with the transitions each state allows, and how it ended (its failure or its cancellation, the times it started and finished, a pending cancel request). Queued, preparing, running, waiting for the operator, and the final states succeeded, failed, cancelled and timed out.

**Delivery**:
How a Run's work reached the Git host: the Integration branch its pull request is based on, whether the Run branch was delivered with a draft pull request, delivered nothing (no changes) or failed, the commit last pushed, and whether the operator asked to retry a failed delivery.

**Worker claim**:
The claim an agent worker has on a Run: the worker holding it now, the one that held it last (only it has the Working copy and the agent session), the one that released it, its last heartbeat, the agent session, and what the claim handed over (the Environment file's path).
_Avoid_: Lease (the lease is the time limit on the heartbeat)

**Run progress**:
How far a Run has come: the Run steps taken in total and before the current part, the Follow-ups sent, when the current Run step started and the Run began waiting, its latest activity, and the Run limits it was started with.

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
The ordered list of a Run's Questions, Answers and Follow-ups, from the Task to the Run's latest result. It is distinct from a part of a Run, which is one segment between two ends of the agent's work (the Task, or a Follow-up, up to the result it ends with).
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

### `environments`

**Preview**:
A Project's own Compose stack, built from the Integration branch and reachable in the browser under its own hostname, behind the Preview password. A Project has one shared Preview, not one per Run. It rebuilds after a merge made through Studio and on the operator's "Rebuild"; it runs until the operator stops it. It has one state, derived from its operations: `resetting_data` (a data removal is queued or running), `stopping` (a stop is), `building` (a build is queued or running), `running` (the last finished change was a succeeded build), `not_configured` (no settings), `failed` (the latest build failed and nothing runs) or `stopped` (settings, nothing running), picked in that order. A failed build beside an earlier one that still runs leaves it `running`. At most three Previews run at the same time (a setting): a Project takes a place while its Preview runs or a build of it is queued or running.
_Avoid_: Environment (alone), staging, deployment

**Preview operation**:
One piece of work the environment controller claims from Studio for a Project's Preview: build, stop, remove data or report its state. It is requested, claimed by one controller process (which must keep reporting, or Studio fails it as lost), then succeeded or failed, and a Project has at most one claimed at a time. A build carries what it was asked to build and keeps a redacted, capped log.
_Avoid_: Job, task, command

**Preview build**:
One attempt to build and start a Preview from the Integration branch at a commit, with its status and its redacted, capped log. It is started by the operator (a Rebuild, or a Reset) or by the merge of a named Run through Studio; nothing else starts one. Its status is `queued` (waiting for the controller), `building` (claimed), `succeeded` or `failed`. A build that fails before the stack starts leaves the previous Preview running; one that fails after it removes that Preview.
_Avoid_: Deploy, pipeline

**Preview settings**:
What a Project provides for its Preview: the path of its Compose file in the Repository, and the one service and port to show. Without them the Project has no Preview.
_Avoid_: Environment settings

**Preview user**:
The third operating-system user on the server, used only for Previews. It has its own rootless Docker daemon and runs the environment-controller. It is not the agent user.
_Avoid_: Preview account, controller user

**Preview password**:
The secret that protects every Preview at the reverse proxy. It is not Studio's login and is kept outside Git.
_Avoid_: Preview token

### Architecture vocabulary

Terms of the API's structure rules ([Backend](backend.md) §3), not of the business domain.

**Aggregate root**:
The one object through which a group of objects that must stay consistent is created, changed and stored. Anything with its own repository is an aggregate root; it refers to other roots by id only.

**Entity**:
An object with an identity that outlives its values, and rules about what can happen to it. A root is an entity; a child entity has its identity only within its root (a Run step within its Run).

**Value object**:
An immutable object defined by its values, with no identity of its own; a change returns a new value. It validates on creation and owns the rules about the concept it names (a Run's state with its transitions); where it owns no rule beyond its shape it may be a plain type.

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
The separate Git host account through which Run branches are pushed, draft pull requests opened, and a pull request's state, Pull request checks and Review comments read; it is not the operator's account. It never merges or closes: that uses the Merge credential on Studio's side.
_Avoid_: Bot account, machine user, operator account
