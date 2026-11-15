import type {
  Provider,
  Run,
  RunCancellation,
  RunDeliveryOutcome,
  RunFailure,
  RunLimits,
  RunState,
  RunWorkingCopy,
} from '../entities/run.js';

/** DI token for the {@link RunRepository} adapter. */
export const RUN_REPOSITORY = Symbol('RUN_REPOSITORY');

export interface NewRun {
  projectId: string;
  provider: Provider;
  task: string;
  startCommit: string;
  remoteUrl: string;
  /** The limits in force when the Run is started (Issue #100). */
  limits: RunLimits;
  integrationBranch: string;
}

/** A change of state reported by the agent worker holding the Run. */
export interface ClaimedRunChange {
  runId: string;
  workerId: string;
  from: RunState;
  to: RunState;
  /** Exactly when `to` is `failed`. */
  failure: RunFailure | null;
  /** When set, becomes the Run's latest Working copy state (a failed Run, Issue #98). */
  workingCopy?: RunWorkingCopy | null;
  /** Exactly when `to` is `cancelled` (Issue #100). */
  cancellation?: RunCancellation | null;
  /**
   * Whether the caller saw a cancel request on the Run (Issue #100); the change applies only
   * if that is still so, so a cancel that arrives in between is never lost.
   */
  cancelRequested: boolean;
  /**
   * With `succeeded` (Issue #102): how the Run was delivered. A `failed` Run with
   * `delivery_failed` records the delivery `failed` by itself.
   */
  delivery?: RunDeliveryOutcome | null;
  now: Date;
}

/**
 * The outcome of a delivery retry (Issue #102), reported by the agent worker holding the
 * `failed` Run: `succeeded` with the delivery, or still `failed` with `delivery_failed` and the
 * new reason. Either way the Run is released and finished again at `now`.
 */
export interface DeliveryRetryOutcome {
  runId: string;
  workerId: string;
  result:
    { state: 'succeeded'; delivery: RunDeliveryOutcome } | { state: 'failed'; failure: RunFailure };
  /** When set, becomes the Run's latest Working copy state. */
  workingCopy: RunWorkingCopy | null;
  now: Date;
}

/** What storing a Run step did (Issue #100: the API also enforces the step limit). */
export type AppendStepOutcome =
  /** Stored now, or (`duplicate`) already stored by an earlier delivery of the same report. */
  | { status: 'stored'; index: number; duplicate?: boolean }
  /** The reported number is neither the stored last one nor the next one; nothing changed. */
  | { status: 'out_of_order'; expected: number }
  /** The Run is not `running` or not held by this worker; nothing changed. */
  | { status: 'not_held' }
  /** The step would exceed the Run's `maxSteps`: it was not stored, and the Run is `failed`. */
  | { status: 'step_limit' };

/** One reported Run step: its kind and the structured result, as validated JSON. */
export interface RunStepRecord {
  kind: 'start' | 'resume';
  result: unknown;
  /** The step's number as the worker reports it (review of #121); the next one when absent. */
  index?: number;
}

/** A stored Run step: its number, kind, report time and the result as stored JSON. */
export interface StoredRunStep extends RunStepRecord {
  index: number;
  reportedAt: Date;
}

/** A Run's state for the agent worker's retention (Issue #98). */
export interface RunStateView {
  runId: string;
  state: RunState;
  /** Set exactly in a final state. */
  finishedAt: Date | null;
}

/**
 * The Run aggregate's store (Issue #96). Every change a worker reports is conditional on the
 * stored state and holder still being what the caller read, so a late or repeated report
 * changes nothing; the store, not a prior read, decides.
 */
export interface RunRepository {
  /** Persists a new `queued` Run; the store assigns its id and creation time. */
  add(run: NewRun): Promise<Run>;

  /** The Run with this id, or `null`. */
  findById(id: string): Promise<Run | null>;

  /** Every Run, newest first: by creation time, then by id. */
  listNewestFirst(): Promise<Run[]>;

  /** A project's Runs, newest first: by creation time, then by id. */
  listByProjectNewestFirst(projectId: string): Promise<Run[]>;

  /**
   * Hands the oldest eligible Run (by creation time, then id) to `workerId`: a `queued` one →
   * `preparing`, started and heartbeat at `now`; or a `failed` one whose delivery retry was
   * requested, that no worker holds and that `workerId` itself started (it alone has the
   * Working copy; Issue #102, review R4 of #122) → held by `workerId` (heartbeat at `now`),
   * still `failed`. Eligible: its project has no active or held Run and fewer than `MAX_ACTIVE_RUNS`
   * are active or held across the server. Serialized against concurrent claims, so they cannot
   * exceed the limits. `null` when nothing is eligible.
   */
  claimNext(workerId: string, now: Date): Promise<Run | null>;

  /**
   * Applies `change` if the Run is still in `change.from` and held by `change.workerId`. To
   * `running` it stays held (heartbeat at `now`); to `waiting_for_operator` it is released
   * (waiting since `now`); to a final state it is released and finished at `now`. Applies
   * only if the Run's cancel request is still as `change.cancelRequested` says (Issue #100).
   * `null` if a condition failed.
   */
  transitionClaimed(change: ClaimedRunChange): Promise<Run | null>;

  /**
   * Records a heartbeat of the worker holding the Run and tells it whether the operator asked
   * to cancel (Issue #100); `null` if it does not hold the Run.
   */
  heartbeat(
    runId: string,
    workerId: string,
    now: Date,
  ): Promise<{ cancelRequested: boolean } | null>;

  /**
   * Cancels a Run that no worker holds (`queued` or `waiting_for_operator`) if it is still in
   * `from`: → `cancelled` with `cancellation`, finished at `now` (Issue #100). `null` if not.
   */
  cancelUnheld(
    runId: string,
    from: 'queued' | 'waiting_for_operator',
    cancellation: RunCancellation,
    now: Date,
  ): Promise<Run | null>;

  /**
   * Records the operator's cancel request on a held Run (`preparing` or `running`), keeping
   * the first request's time (Issue #100). `null` if the Run is not held any more.
   */
  requestCancel(runId: string, now: Date): Promise<Run | null>;

  /** Every Run waiting for the operator (Issue #100: the long-wait sweep). */
  listWaiting(): Promise<Run[]>;

  /**
   * Renews the lease of every held Run to `now` (Issue #100), run when the API starts so a short
   * Studio outage does not fail the Runs their workers kept carrying, but at most once per lease
   * period (review of #121): the time of the last renewal is stored, so an API that keeps
   * crashing and restarting cannot keep a dead worker's Run alive. Returns how many Runs were
   * renewed, or `null` when a renewal happened less than `leaseSeconds` ago.
   */
  renewClaimsOncePerLease(now: Date, leaseSeconds: number): Promise<number | null>;

  /**
   * Studio's backstop for the step time limit (review of #121): every `running` Run whose
   * current step (not yet reported) started more than its `stepMinutes` plus `graceMinutes` before `now` →
   * `timed_out`, released and finished at `now`. Returns how many.
   */
  timeOutOverdueSteps(now: Date, graceMinutes: number): Promise<number>;

  /**
   * Requests a retry of the Run's failed delivery (Issue #102) if it is still `failed` with
   * `delivery_failed`; repeating it changes nothing. The Run, or `null` if the condition failed.
   */
  requestDeliveryRetry(runId: string): Promise<Run | null>;

  /** Requested delivery retries no worker holds, with the worker that started each (#102). */
  listPendingDeliveryRetries(): Promise<{ runId: string; startedBy: string | null }[]>;

  /**
   * Gives up a requested delivery retry no worker holds (review N2 of #122): it stays `failed`
   * with `failure`, the request is cleared, finished at `now`. False if the condition failed.
   */
  abandonDeliveryRetry(runId: string, failure: RunFailure, now: Date): Promise<boolean>;

  /**
   * Applies a delivery retry's outcome if the Run is still `failed`, its retry requested and
   * held by `outcome.workerId`; the request is cleared. `null` if the condition failed.
   */
  finishDeliveryRetry(outcome: DeliveryRetryOutcome): Promise<Run | null>;

  /** The states of the Runs with these ids (valid UUIDs); ids that name no Run are left out. */
  findStates(ids: readonly string[]): Promise<RunStateView[]>;

  /**
   * Stores a Run step of a `running` Run held by `workerId`, numbered 1, 2, … in report
   * order, and makes `workingCopy` the Run's latest Working copy state and `failingChecks` its
   * failing checks (Issue #102), in one transaction. A step beyond the Run's `maxSteps` is not
   * stored: the Run fails with `stepLimitFailure`, released and finished at `now` (Issue #100).
   */
  appendStep(
    runId: string,
    workerId: string,
    step: RunStepRecord,
    workingCopy: RunWorkingCopy,
    failingChecks: readonly string[],
    now: Date,
  ): Promise<AppendStepOutcome>;

  /** The Run's stored steps, by number (Issue #99). */
  listSteps(runId: string): Promise<StoredRunStep[]>;

  /**
   * Every held Run whose last heartbeat is before `staleBefore`: a `preparing` or `running` one
   * → `failed` with `failure`; a `failed` one held for a delivery retry (Issue #102) keeps
   * `failed` with `deliveryFailure` and its retry request cleared. Each is released and finished
   * at `now`; returns how many.
   */
  failStaleClaims(
    staleBefore: Date,
    failure: RunFailure,
    deliveryFailure: RunFailure,
    now: Date,
  ): Promise<number>;

  /**
   * Records that a `preparing` Run held by `workerId` was given its Project's Environment file
   * (Issue #104): its path and the secret store's reference to its snapshot; false (nothing
   * changed) if the Run is no longer `preparing` or held by it.
   */
  attachEnvironmentFile(
    runId: string,
    workerId: string,
    file: { path: string; secretRef: string },
  ): Promise<boolean>;

  /** The reference to the Run's Environment file snapshot, or `null` (none, or already deleted). */
  findEnvironmentFileSecret(runId: string): Promise<string | null>;

  /**
   * The Runs in a final state that still hold an Environment file snapshot reference and no
   * longer need it: every final Run, except a `failed` one with `delivery_failed` (its delivery
   * can be retried) that finished at or after `retryableFinishedBefore` or whose retry is in
   * progress.
   */
  listReleasableEnvironmentFileSecrets(
    retryableFinishedBefore: Date,
  ): Promise<{ runId: string; secretRef: string }[]>;

  /** Forgets the Run's snapshot reference if it is still `secretRef` (after its secret is deleted). */
  clearEnvironmentFileSecret(runId: string, secretRef: string): Promise<void>;

  /** Every snapshot reference any Run holds (the orphan sweep keeps these). */
  listEnvironmentFileSecretRefs(): Promise<string[]>;
}

/** No Run has this id. */
export class RunNotFoundError extends Error {
  constructor() {
    super('The run does not exist.');
    this.name = 'RunNotFoundError';
  }
}

/**
 * The reporting agent worker does not hold the Run: another worker claimed it, it was
 * released (waiting for the operator, or final), or it was failed as `worker_lost`.
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
