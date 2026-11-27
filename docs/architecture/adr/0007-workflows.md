---
status: accepted
date: 2026-11-27
---

# A Workflow is a file: a sequence of Phases on one Run

Decided in the refinement of Epic #343, 2026-11-27. The operator decided that sending work back is allowed with a limit, that a Checkpoint is part of this Epic, and that a Workflow is a file with a read-only diagram; the rest was settled in the refinement as technical decisions. This is step 3 of the end-to-end outcome in [MVP](../../product/mvp.md) §2 ("a small sequential flow and human approval") and the first content of the `workflows` module. A Workflow uses the storage, versions, editor, Draft and Publish of [ADR 0005](0005-agent-definitions-in-git.md); [ADR 0002](0002-agent-run-isolation.md) still decides the isolation of Runs.

Until now one Run is one agent. A **Workflow** lets the operator describe a small sequence of agents, for example one implements, a second reviews and the first fixes what the review found, and choose it when starting a Run.

## Context

- **A Run must stay one thing.** The pull request, its review and its merge (ADR 0002) are built around one Run, one branch and one pull request.
- **A review must not change code.** An agent that reviews and also edits is not a review.
- **Sending work back needs a bound.** An unbounded loop spends the Run's limits and the operator's subscription on an argument between two agents.
- **Both Providers must keep working as they are.** Phases may differ in Provider, and no CLI command may change.
- **A Run must be reproducible.** What the sequence was is part of what the Run did.
- **One operator, one dedicated server.** A small sequential flow is enough; branches and parallel work are not needed yet.

## Decision

- **Vocabulary.** A Workflow consists of **Phases**. "Step" is not used for a Phase: a Run step is one execution of the agent CLI, and a Phase takes one or more Run steps. A review Phase ends with a **Verdict** (approved, or changes requested with findings). A **Checkpoint** makes the Run wait for the operator.
- **A Workflow is a file in the definitions Repository** and a sequence of Phases. It is edited in the existing editor with validation, Draft and Publish (ADR 0005), shown with a read-only diagram. The exact format and limits belong to the validation's code, not to this document.
- **One Run, one branch, one pull request.** A Workflow changes who works inside a Run and nothing else about it. How a Run is approved and merged is unchanged.
- **A Phase names one Agent definition** and is of one of two kinds: **work** (may change the Working copy) or **review** (ends with a Verdict).
- **A review cannot change the Working copy.** After a review Phase the agent worker restores the Working copy to what it was before the Phase.
- **Phases may use different Providers.** A Workflow that names an invalid agent, or an agent of a disabled Provider, is listed with the reason and cannot be chosen.
- **Each Phase has its own agent session.** A send-back resumes the work Phase's session with the findings.
- **Sending work back is allowed, with a limit.** On "changes requested" Studio hands the findings to the work Phase and then runs the review again, at most two times per Run by default; a Workflow can set a lower number, never a higher one. At the limit the Run finishes as "review not passed", still delivers its pull request and shows the open findings.
- **A Checkpoint is part of the Workflow.** A Workflow can say "wait for the operator here". The Run waits, and the operator continues or stops it, with an optional comment that the next Phase receives.
- **Delivery happens once,** when the Workflow ends or stops.
- **A Follow-up** to a finished Workflow Run runs the Workflow again from its first Phase, with the sessions resumed.
- **A Question** from any Phase makes the Run wait for the operator, as today.
- **Limits.** Every Phase gets the Run-step allowance a Run has today; the Run's total limit bounds the whole Workflow. A Workflow raises no limit.
- **A version is a commit.** A Run records the Workflow, its Phases and their agents at its start, and a later change to the definition changes nothing for it.
- **Choosing.** At a Run's start the operator chooses an agent or a Workflow in one place; a Project's default may be either. A Run started with an agent, without a Workflow, is unchanged.
- **Ownership.** `workflows` owns the definition and decides which Phase comes next. `executions` owns the Run and its Run steps and reports each result. `workflows` reads definition files through the public face of `agents`, and `executions` imports nothing from `workflows`.
- **No CLI command changes, so neither [Provider compliance record](../../engineering/provider-compliance/README.md) is amended.** Each Phase is an ordinary Run step under the Mode already approved: no new CLI command, option or credential is added, and the approved mode, options and credentials stay exactly as recorded. The restore after a review is done by the agent worker on the Working copy, not by a CLI option.

## Considered Options

Sending back:

- **Not allowed: a review only reports.** Rejected: the operator would fix every finding by hand or start a Follow-up, and the point of the sequence is lost.
- **Unlimited.** Rejected: two agents can disagree for ever, spending the Run's limits and the subscription.
- **Limited, two by default, a Workflow may lower it.** Chosen: it bounds the cost, and "review not passed" still gives the operator the pull request and the open findings.

Checkpoint:

- **Later.** Rejected: human approval is half of the MVP's outcome for this step, and the Run already knows how to wait for the operator (a Question).
- **Now, part of this Epic.** Chosen.

Editing:

- **A graph editor.** Rejected for now: it is a large piece of interface for a sequence of a few Phases. It waits until Workflows have branches or parallel Phases.
- **A file with a read-only diagram.** Chosen: the existing editor, validation, Draft and Publish apply with no new mechanism, and the diagram shows the sequence.

Execution:

- **One Run per Phase.** Rejected: it would give several branches and pull requests for one piece of work and break the one-Run model of the pull request and its merge.
- **One Run for the whole Workflow.** Chosen.

## Consequences and accepted risks

- **A published Workflow changes every later Run that chooses it,** as ADR 0005 states for agents; a Run keeps the version it started with.
- **Findings and the Checkpoint comment are text from agents and from the operator's own hand,** handed to the next Phase as untrusted text, bounded by the guardrails as any instruction is.
- **A Phase's agent may disagree with a review that is wrong.** The limit ends the argument; the operator reads the open findings and decides at the merge.
- **A Workflow costs more Run steps** than one agent. The per-Phase allowance and the Run's total limit bound it.
- **A new model in `workflows`** to validate, list, run and test.

## Upgrade paths

Branches, conditions beyond the Verdict, parallel Phases, a Workflow that spans several Runs or pull requests, the graph editor, and a Workflow started by an event or a schedule each need a separate decision. The last also needs a look at the compliance records, which allow Runs only on the operator's action.
