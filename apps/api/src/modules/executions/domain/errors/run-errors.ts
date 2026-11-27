import type { ClosePullRequestRefusal } from '../value-objects/close-pull-request-refusal.js';
import type { FollowUpRefusal } from '../value-objects/follow-up-refusal.js';
import type { Provider } from '../value-objects/provider.js';
import type { RunState } from '../value-objects/run-state.js';
import type { ProviderUnavailableReason } from '../value-objects/provider-unavailable-reason.js';

export class DeliveryNotRetryableError extends Error {
  constructor() {
    super('Only a run whose delivery failed can retry its delivery.');
    this.name = 'DeliveryNotRetryableError';
  }
}

export class IllegalRunTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`A Run cannot go from ${from} to ${to}.`);
    this.name = 'IllegalRunTransitionError';
  }
}

export class RunAlreadyFinishedError extends Error {
  constructor(readonly state: RunState) {
    super('Run already finished');
    this.name = 'RunAlreadyFinishedError';
  }
}

export class FollowUpNotAllowedError extends Error {
  constructor(readonly reason: FollowUpRefusal) {
    super(`The run cannot take a Follow-up now (${reason}).`);
    this.name = 'FollowUpNotAllowedError';
  }
}

export class RunNotResumableError extends Error {
  constructor() {
    super('Only a run stopped at the usage limit, with an agent session, can be resumed.');
    this.name = 'RunNotResumableError';
  }
}

export class RunSlotTakenError extends Error {
  constructor(scope: 'project');
  constructor(scope: 'server', maxPlaces: number);
  constructor(
    readonly scope: 'project' | 'server',
    maxPlaces?: number,
  ) {
    super(
      scope === 'project'
        ? 'Another run of this project is active. Resume this run when that run has ended.'
        : `${maxPlaces} runs are already active on the server. Resume this run when one of them has ended.`,
    );
    this.name = 'RunSlotTakenError';
  }
}

export class RunNotWaitingError extends Error {
  constructor(readonly state: RunState) {
    super('The run is not waiting for an answer.');
    this.name = 'RunNotWaitingError';
  }
}

/** The Run does not wait at the Checkpoint the request is about (or at any). */
export class RunNotAtCheckpointError extends Error {
  constructor(readonly state: RunState) {
    super('The run is not waiting at a Checkpoint.');
    this.name = 'RunNotAtCheckpointError';
  }
}

/**
 * Not held: claimed by another worker, released (waiting for the operator, or final),
 * or failed as `worker_lost`.
 */
export class RunNotHeldError extends Error {
  constructor() {
    super('This agent worker does not hold the run.');
    this.name = 'RunNotHeldError';
  }
}

export class StepOutOfOrderError extends Error {
  constructor(readonly expected: number) {
    super(`The next run step is number ${expected}.`);
    this.name = 'StepOutOfOrderError';
  }
}

export class StepLimitReachedError extends Error {
  constructor() {
    super('The run reached its maximum number of run steps.');
    this.name = 'StepLimitReachedError';
  }
}

/** No Workflow has the name at the definitions commit. */
export class WorkflowUnknownError extends Error {
  constructor(readonly workflow: string) {
    super(`No Workflow is named ${workflow}.`);
    this.name = 'WorkflowUnknownError';
  }
}

/** The Workflow cannot be used to start a Run; `reason` says why, for the operator. */
export class WorkflowNotUsableError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'WorkflowNotUsableError';
  }
}

export class RunProjectNotFoundError extends Error {
  constructor() {
    super('The project does not exist.');
    this.name = 'RunProjectNotFoundError';
  }
}

/** The project is the definitions Repository, which accepts no Run. */
export class DefinitionsProjectRunError extends Error {
  constructor() {
    super('The definitions Repository accepts no Run.');
    this.name = 'DefinitionsProjectRunError';
  }
}

export class RepositoryNotReadyError extends Error {
  constructor(readonly reason: 'no_repository' | 'not_ready') {
    super(
      reason === 'no_repository'
        ? 'The project has no repository. Connect one before starting a run.'
        : "The project's repository is not ready. Wait until it is ready, then start the run.",
    );
    this.name = 'RepositoryNotReadyError';
  }
}

export class ReviewCommentsNotLoadedError extends Error {
  constructor() {
    super('Some of the selected review comments are not loaded.');
    this.name = 'ReviewCommentsNotLoadedError';
  }
}

export class RunNotFoundError extends Error {
  constructor() {
    super('The run does not exist.');
    this.name = 'RunNotFoundError';
  }
}

export class PullRequestNotRefreshableError extends Error {
  constructor() {
    super('The run has no pull request to refresh.');
    this.name = 'PullRequestNotRefreshableError';
  }
}

export class InvalidTaskError extends Error {
  constructor(
    readonly reason: 'empty' | 'too_long',
    maxLength: number,
  ) {
    super(reason === 'empty' ? 'Enter a task.' : `Use at most ${maxLength} characters.`);
    this.name = 'InvalidTaskError';
  }
}

export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: Provider,
    readonly reason: ProviderUnavailableReason,
  ) {
    super(reason);
    this.name = 'ProviderUnavailableError';
  }
}

/** `detail` is the Git host's redacted reason, for `host_refused` only. */
export class ClosePullRequestRefusedError extends Error {
  constructor(
    readonly reason: ClosePullRequestRefusal,
    readonly detail?: string,
  ) {
    super(`The pull request cannot be closed from Studio (${reason}).`);
    this.name = 'ClosePullRequestRefusedError';
  }
}

export class CloseInProgressError extends Error {
  constructor() {
    super('Another request is closing this pull request.');
    this.name = 'CloseInProgressError';
  }
}

/** A start request names neither an agent nor a provider. */
export class AgentNotChosenError extends Error {
  constructor() {
    super('Name an agent or a provider.');
    this.name = 'AgentNotChosenError';
  }
}

/** No agent has the requested name. */
export class AgentUnknownError extends Error {
  constructor(readonly agent: string) {
    super('No agent has this name.');
    this.name = 'AgentUnknownError';
  }
}

/** The agent exists but its definition has problems. */
export class AgentNotUsableError extends Error {
  constructor(readonly agent: string) {
    super('The agent cannot be used: its definition has problems.');
    this.name = 'AgentNotUsableError';
  }
}

/** The request names both an agent and a provider, and the agent belongs to another provider. */
export class AgentProviderMismatchError extends Error {
  constructor(
    readonly agentProvider: Provider,
    readonly requestedProvider: Provider,
  ) {
    super('The agent belongs to another provider than the one requested.');
    this.name = 'AgentProviderMismatchError';
  }
}

/** The Clone no longer holds what the Run's agent folder is read from. */
export class AgentFolderUnavailableError extends Error {
  constructor() {
    super("The agent's files are no longer available in the definitions Repository.");
    this.name = 'AgentFolderUnavailableError';
  }
}

/** The Run's agent folder fails the shared validation; `detail` names paths and codes only. */
export class AgentFolderInvalidError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'AgentFolderInvalidError';
  }
}

/** The agent's files could not be read right now (Git failed); trying again may work. */
export class AgentFolderReadFailedError extends Error {
  constructor() {
    super("The agent's files could not be read from the definitions Repository right now.");
    this.name = 'AgentFolderReadFailedError';
  }
}

/** The definitions Repository's listing is cut, so the agent's folder may be partial. */
export class AgentFolderCutError extends Error {
  constructor() {
    super("The definitions Repository has too many files to read this agent's folder safely.");
    this.name = 'AgentFolderCutError';
  }
}

/** The Clone no longer holds the commit or a skill the Run recorded. */
export class SkillsUnavailableError extends Error {
  constructor() {
    super("The agent's skills are no longer available in the definitions Repository.");
    this.name = 'SkillsUnavailableError';
  }
}

/** A skill of the Run fails the shared validation; `detail` names skills, paths and codes only. */
export class SkillsInvalidError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'SkillsInvalidError';
  }
}

/** The skills could not be read right now (Git failed); trying again may work. */
export class SkillsReadFailedError extends Error {
  constructor() {
    super("The agent's skills could not be read from the definitions Repository right now.");
    this.name = 'SkillsReadFailedError';
  }
}
