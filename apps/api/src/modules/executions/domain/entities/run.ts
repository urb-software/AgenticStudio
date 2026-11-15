/**
 * The Run (Issue #96): one Task carried out by a Provider on one Project, from a recorded
 * commit of the integration branch. The worker protocol's enums (`@agentic-studio/contracts`)
 * and the HTTP contract's are pinned to the lists here by tests; the database CHECK
 * constraints are written from them.
 */

export const RUN_STATES = [
  'queued',
  'preparing',
  'running',
  'waiting_for_operator',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export type RunState = (typeof RUN_STATES)[number];

/** States that count against the concurrency limits: an agent worker or the operator holds the Run. */
export const ACTIVE_RUN_STATES = [
  'preparing',
  'running',
  'waiting_for_operator',
] as const satisfies readonly RunState[];

/** States an agent worker holds the Run in (it sends heartbeats); the lost-worker sweep's scope. */
export const CLAIMED_RUN_STATES = ['preparing', 'running'] as const satisfies readonly RunState[];

/** Final states: terminal, the Run is over. */
export const FINAL_RUN_STATES = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const satisfies readonly RunState[];

/** At most this many active Runs across the server (ADR 0002). */
export const MAX_ACTIVE_RUNS = 2;

export const PROVIDERS = ['claude_code', 'codex'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Why a Run failed: the fixed codes of Issue #96. */
export const RUN_FAILURE_CODES = [
  'provider_disabled',
  'preparation_failed',
  'agent_failed',
  'usage_limit',
  'worker_lost',
  'delivery_failed',
  'step_limit',
  'unknown',
] as const;
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];

export interface RunFailure {
  code: RunFailureCode;
  /** A short explanation; never a secret. */
  detail: string;
}

/** Longest Task, in characters. */
export const TASK_MAX_LENGTH = 20_000;

/** One commit on a Run branch: its id and subject line. */
export interface RunCommit {
  id: string;
  subject: string;
}

/**
 * The Working copy's state as the agent worker last reported it after a Run step (Issue #98):
 * the Run branch, its commits since the start commit (oldest first, capped by the worker
 * protocol) and whether uncommitted changes remain.
 */
export interface RunWorkingCopy {
  runBranch: string;
  commits: RunCommit[];
  hasUncommittedChanges: boolean;
}

/**
 * The limits of a Run (Issue #100), from the API's configuration, copied onto the Run when it
 * is started: the longest a Run step may work, the most Run steps the Run may take, and the
 * longest it may wait for the operator before it is cancelled.
 */
export interface RunLimits {
  stepMinutes: number;
  maxSteps: number;
  waitingDays: number;
}

/** Who cancelled a Run (Issue #100): the operator, or Studio itself (a Run waiting too long). */
export const RUN_CANCELLED_BY = ['operator', 'system'] as const;
export type RunCancelledBy = (typeof RUN_CANCELLED_BY)[number];

/** Why a Run was cancelled; set exactly when `cancelled`. */
export interface RunCancellation {
  by: RunCancelledBy;
  /** A short explanation, shown to the operator. */
  reason: string;
}

export interface Run {
  id: string;
  projectId: string;
  provider: Provider;
  task: string;
  state: RunState;
  /** The integration branch's commit when the Run was started. */
  startCommit: string;
  /** The Repository's remote URL when the Run was started (Issue #98); never a credential. */
  remoteUrl: string;
  /** The latest reported Working copy state; `null` until the first Run step is reported. */
  workingCopy: RunWorkingCopy | null;
  createdAt: Date;
  /** When an agent worker claimed it. */
  startedAt: Date | null;
  /** When it reached a final state. */
  finishedAt: Date | null;
  /** Set exactly when `failed`. */
  failure: RunFailure | null;
  /** The agent worker holding it; set exactly when `preparing` or `running`. */
  claimedBy: string | null;
  /** The limits in force for this Run (Issue #100). */
  limits: RunLimits;
  /**
   * When the operator asked to cancel a `preparing` or `running` Run (Issue #100); the Run
   * stays in its state until the agent worker confirms the stop.
   */
  cancelRequestedAt: Date | null;
  /** Set exactly when `cancelled`. */
  cancellation: RunCancellation | null;
  /** When it began waiting for the operator; set exactly when `waiting_for_operator`. */
  waitingSince: Date | null;
  /** When the current (or last) Run step started: set whenever the Run goes to `running`. */
  stepStartedAt: Date | null;
  /**
   * The agent worker that released the Run (to `waiting_for_operator` or a final state), so a
   * retried report of that same change is recognised (review of #121).
   */
  releasedBy: string | null;
}

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['preparing', 'cancelled', 'timed_out'],
  preparing: ['running', 'failed', 'cancelled', 'timed_out'],
  running: ['waiting_for_operator', 'succeeded', 'failed', 'cancelled', 'timed_out'],
  waiting_for_operator: ['running', 'cancelled', 'timed_out'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isFinal(state: RunState): boolean {
  return (FINAL_RUN_STATES as readonly RunState[]).includes(state);
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

/** Throws {@link IllegalRunTransitionError} unless `from` → `to` is allowed. */
export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new IllegalRunTransitionError(from, to);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` can be a Run id (a UUID); anything else names no Run. */
export function isRunId(value: string): boolean {
  return UUID.test(value);
}

/** Cancelling a Run that has already reached a final state (Issue #100). */
export class RunAlreadyFinishedError extends Error {
  constructor(readonly state: RunState) {
    super('Run already finished');
    this.name = 'RunAlreadyFinishedError';
  }
}

/** The cancellation recorded when the operator cancels a Run (Issue #100). */
export const OPERATOR_CANCELLATION: RunCancellation = {
  by: 'operator',
  reason: 'Cancelled by the operator.',
};

/**
 * The long-wait rule (Issue #100): a Run waiting for the operator longer than its
 * `waitingDays` is cancelled by Studio, with that stated as the reason. Returns the
 * cancellation when the rule applies at `now`, otherwise `null`.
 */
export function longWaitCancellation(run: Run, now: Date): RunCancellation | null {
  if (run.state !== 'waiting_for_operator' || run.waitingSince === null) return null;
  const limitMs = run.limits.waitingDays * 24 * 60 * 60 * 1000;
  if (now.getTime() - run.waitingSince.getTime() <= limitMs) return null;
  const days = run.limits.waitingDays;
  return {
    by: 'system',
    reason: `Cancelled automatically: the run waited for the operator longer than ${days} ${days === 1 ? 'day' : 'days'}.`,
  };
}

/**
 * Studio's backstop for the step time limit (review of #121): the agent worker stops a Run step
 * at `stepMinutes`; if a `running` Run's step is still going this much later, Studio itself ends
 * the Run as `timed_out`.
 */
export const STEP_TIME_LIMIT_GRACE_MINUTES = 5;

/** The failure of a Run that would exceed its maximum number of Run steps (Issue #100). */
export function stepLimitFailure(maxSteps: number): RunFailure {
  return {
    code: 'step_limit',
    detail: `The run reached its limit of ${maxSteps} run ${maxSteps === 1 ? 'step' : 'steps'}; no further step was started.`,
  };
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
 * The lost-worker rule (Issue #96): a held Run whose last heartbeat is older than the lease
 * has lost its agent worker. Returns the cut-off and the failure it gets.
 */
export function lostWorkerRule(
  now: Date,
  leaseSeconds: number,
): { staleBefore: Date; failure: RunFailure } {
  return {
    staleBefore: new Date(now.getTime() - leaseSeconds * 1000),
    failure: {
      code: 'worker_lost',
      detail: `The agent worker sent no heartbeat for ${leaseSeconds} seconds.`,
    },
  };
}
