import type {
  Provider,
  Run,
  RunDeliveryOutcome,
  RunFailure,
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

/** One reported Run step: its kind and the structured result, as validated JSON. */
export interface RunStepRecord {
  kind: 'start' | 'resume';
  result: unknown;
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
   * `running` it stays held (heartbeat at `now`); to `waiting_for_operator` it is released;
   * to a final state it is released and finished at `now`. `null` if the condition failed.
   */
  transitionClaimed(change: ClaimedRunChange): Promise<Run | null>;

  /** Records a heartbeat of the worker holding the Run; false if it does not hold it. */
  heartbeat(runId: string, workerId: string, now: Date): Promise<boolean>;

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
   * failing checks (Issue #102), in one transaction; returns its number, or `null` (nothing
   * changed) if the Run is not `running` or not held by it.
   */
  appendStep(
    runId: string,
    workerId: string,
    step: RunStepRecord,
    workingCopy: RunWorkingCopy,
    failingChecks: readonly string[],
  ): Promise<number | null>;

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

  /** The Runs in a final state that still hold an Environment file snapshot reference. */
  listFinalEnvironmentFileSecrets(): Promise<{ runId: string; secretRef: string }[]>;

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
