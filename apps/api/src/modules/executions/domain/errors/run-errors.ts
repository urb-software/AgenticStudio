import type { FollowUpRefusal } from '../value-objects/follow-up.js';
import type { Provider } from '../value-objects/provider.js';
import type { RunState } from '../value-objects/run-state.js';
import type { ProviderUnavailableReason } from '../value-objects/worker-status.js';

/** Retrying the delivery of a Run that is not `failed` with `delivery_failed`. */
export class DeliveryNotRetryableError extends Error {
  constructor() {
    super('Only a run whose delivery failed can retry its delivery.');
    this.name = 'DeliveryNotRetryableError';
  }
}

/** A transition the state machine does not allow. */
export class IllegalRunTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`A Run cannot go from ${from} to ${to}.`);
    this.name = 'IllegalRunTransitionError';
  }
}

/** Cancelling a Run that has already reached a final state (Issue #100). */
export class RunAlreadyFinishedError extends Error {
  constructor(readonly state: RunState) {
    super('Run already finished');
    this.name = 'RunAlreadyFinishedError';
  }
}

/** A Follow-up the Run cannot take now (Issue #141), with the reason. */
export class FollowUpNotAllowedError extends Error {
  constructor(readonly reason: FollowUpRefusal) {
    super(`The run cannot take a Follow-up now (${reason}).`);
    this.name = 'FollowUpNotAllowedError';
  }
}

/** Resuming a Run that did not stop at the usage limit with a session to resume (Issue #105). */
export class RunNotResumableError extends Error {
  constructor() {
    super('Only a run stopped at the usage limit, with an agent session, can be resumed.');
    this.name = 'RunNotResumableError';
  }
}

/**
 * Resuming a Run stopped at the usage limit while its place is taken (review R1 of #129):
 * another Run of its project is active, or the server's places are.
 */
export class RunSlotTakenError extends Error {
  /** `maxPlaces`: the server's limit, shown in the message of the `server` scope. */
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

/** Answering a Run that is not waiting for the operator (Issue #103). */
export class RunNotWaitingError extends Error {
  constructor(readonly state: RunState) {
    super('The run is not waiting for an answer.');
    this.name = 'RunNotWaitingError';
  }
}

/**
 * The reporting agent worker does not hold the Run: another worker claimed it, it was released
 * (waiting for the operator, or final), or it was failed as `worker_lost`.
 */
export class RunNotHeldError extends Error {
  constructor() {
    super('This agent worker does not hold the run.');
    this.name = 'RunNotHeldError';
  }
}

/** A Run step's number is neither the last stored one nor the next (review of #121). */
export class StepOutOfOrderError extends Error {
  constructor(readonly expected: number) {
    super(`The next run step is number ${expected}.`);
    this.name = 'StepOutOfOrderError';
  }
}

/** A Run step beyond the Run's maximum was reported; the Run is now `failed` (Issue #100). */
export class StepLimitReachedError extends Error {
  constructor() {
    super('The run reached its maximum number of run steps.');
    this.name = 'StepLimitReachedError';
  }
}

/** Starting a Run: no project has this id. */
export class RunProjectNotFoundError extends Error {
  constructor() {
    super('The project does not exist.');
    this.name = 'RunProjectNotFoundError';
  }
}

/** Starting a Run: the project has no Repository, or its Repository is not `ready`. */
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

/**
 * The comments chosen for a Follow-up are not all in the Run's loaded set (loaded again meanwhile,
 * sent already, or never loaded): the operator loads them again.
 */
export class ReviewCommentsNotLoadedError extends Error {
  constructor() {
    super('Some of the selected review comments are not loaded.');
    this.name = 'ReviewCommentsNotLoadedError';
  }
}

/** No Run has this id. */
export class RunNotFoundError extends Error {
  constructor() {
    super('The run does not exist.');
    this.name = 'RunNotFoundError';
  }
}

/** The Run has no pull request (or no known Run branch) whose state could be read. */
export class PullRequestNotRefreshableError extends Error {
  constructor() {
    super('The run has no pull request to refresh.');
    this.name = 'PullRequestNotRefreshableError';
  }
}

/** A Task the Run cannot be started with: empty after trimming, or longer than the limit. */
export class InvalidTaskError extends Error {
  constructor(
    readonly reason: 'empty' | 'too_long',
    maxLength: number,
  ) {
    super(reason === 'empty' ? 'Enter a task.' : `Use at most ${maxLength} characters.`);
    this.name = 'InvalidTaskError';
  }
}

/** A Run cannot start: Studio knows its provider is unavailable. */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: Provider,
    readonly reason: ProviderUnavailableReason,
  ) {
    super(reason);
    this.name = 'ProviderUnavailableError';
  }
}
