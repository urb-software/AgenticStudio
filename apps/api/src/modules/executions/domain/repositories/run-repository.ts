import type { Provider } from '../value-objects/provider.js';
import type { PullRequestState } from '../value-objects/run-pull-request-status.js';
import type { ResumeFacts } from '../entities/run-resume-facts.js';
import type { Run } from '../entities/run.js';
import type { RunSnapshot } from '../entities/run-snapshot.js';
import type { RunCancellation } from '../value-objects/run-cancellation.js';
import type { RunFailure } from '../value-objects/run-failure.js';
import type { RunState } from '../value-objects/run-state.js';
import type { RunStepSnapshot } from '../entities/run-step-snapshot.js';

export {
  RunNotHeldError,
  StepLimitReachedError,
  StepOutOfOrderError,
} from '../errors/run-errors.js';

/** DI token for the {@link RunRepository} adapter. */
export const RUN_REPOSITORY = Symbol('RUN_REPOSITORY');

/**
 * A Run's state for the agent worker's retention (Issue #98), with what Studio decides the
 * Working copy's retention from (Issue #143; the fields of `RetentionFacts`).
 */
export interface RunStateView {
  runId: string;
  projectId: string;
  provider: Provider;
  /** The agent session of the Run (internal: only the agent worker is told). */
  sessionRef: string | null;
  state: RunState;
  /** Set exactly in a final state. */
  finishedAt: Date | null;
  hasPullRequest: boolean;
  pullRequestState: PullRequestState | null;
  pullRequestEndedAt: Date | null;
  lastActivityAt: Date;
}

/** A final Run without a pull request, whose Working copy the per-Project limit counts (#143). */
export interface LimitedRunView {
  runId: string;
  projectId: string;
  finishedAt: Date;
}

/**
 * How many Runs are under way (`UNDER_WAY_RUN_STATES`) and how many wait for the operator,
 * across all projects (Issue #115).
 */
export interface RunsSummary {
  running: number;
  waiting: number;
}

/**
 * The Run aggregate's store (Issue #96). A Run's rules are the {@link Run}'s own: the operator's
 * operations and what the agent worker reports for one Run are Run methods, run through
 * {@link RunRepository.change} (load under the row lock, call, save). What stays here, besides
 * loading, saving and the queries the screens and the worker need, is what a Run's own methods
 * cannot do: handing out the next Run (`claimNext`, one atomic step under the claim lock) and the
 * sweeps over many Runs (the lost-worker, step time-limit, long-wait and gone-worker sweeps, the
 * lease renewal), each paired with a named rule in the domain that supplies its selection and its
 * result (Issue #169).
 */
export interface RunRepository {
  /** Persists a new `queued` Run (`Run.start`). */
  add(run: Run): Promise<Run>;

  /** The Run with this id, or `null`. */
  findById(id: string): Promise<Run | null>;

  /** Whether a Run has this id; reads no Run. */
  exists(id: string): Promise<boolean>;

  /**
   * Saves what the Run's methods changed ({@link Run.pendingChanges}): its fields, the messages it
   * added and the steps it created. Only for a caller that holds the Run's row lock, as the
   * module's `RunTransactions` does, so that what it decided from the Run holds until the save.
   */
  save(run: Run): Promise<void>;

  /**
   * Changes a Run the operator acts on (Issue #167), in one transaction: loads it `FOR UPDATE`,
   * calls `mutate` with it, and saves what `mutate` changed ({@link Run.pendingChanges}); returns
   * the saved Run, or `null` when no Run has this id (`mutate` is then not called). `mutate` is
   * pure: it calls the Run's methods only and does no I/O; whatever it throws (a domain refusal)
   * rolls the transaction back and reaches the caller. The row lock serializes this change with
   * every other change of the Run: a worker's conditional update waits for it and then finds the
   * state it checks as it is after this change, so two simultaneous changes cannot both win.
   */
  change(runId: string, mutate: (run: Run) => void): Promise<Run | null>;

  /**
   * {@link change} for resuming after the usage limit (review R1 of #129): serialized with claims
   * (it takes the lock a claim takes first), so `mutate` gets the places held, and whether the
   * Run's Environment file snapshot is still there, as they stay until the change is saved. When
   * the partial unique index on a Project's active Run refuses the saved change, it is reported
   * as `RunSlotTakenError` (scope `project`).
   */
  changeSerializedWithClaims(
    runId: string,
    mutate: (run: Run, facts: ResumeFacts) => void,
  ): Promise<Run | null>;

  /**
   * Every Run, newest first: by creation time, then by id, as snapshots. Lists leave the
   * conversation out (`messages` is empty; Issue #103): `findById` reads it.
   */
  listNewestFirst(): Promise<RunSnapshot[]>;

  /** A project's Runs, newest first: by creation time, then by id; without their messages. */
  listByProjectNewestFirst(projectId: string): Promise<RunSnapshot[]>;

  /** The counts of Runs under way and waiting for the operator, read in one query (Issue #115). */
  summarize(): Promise<RunsSummary>;

  /**
   * Hands the oldest eligible Run (by creation time, then id) to `workerId`: a `queued` one →
   * `preparing`, started and heartbeat at `now`; or a `failed` one whose delivery retry was
   * requested, that no worker holds and that `workerId` itself started (it alone has the
   * Working copy; Issue #102, review R4 of #122) → held by `workerId` (heartbeat at `now`),
   * still `failed`. A resumable `queued` Run (answered, with a session reference; Issue #103)
   * goes only to the worker that started it, like a delivery retry, and keeps its first start
   * time. Eligible: its project has no other active or held Run and fewer than `HandOutRule.MAX_PLACES`
   * others are active or held across the server; a resumable Run keeps its place while it waits
   * for its worker. Serialized against concurrent claims, so they cannot exceed the limits.
   * `null` when nothing is eligible.
   */
  claimNext(workerId: string, now: Date): Promise<RunSnapshot | null>;

  /**
   * Cancels a Run that no worker holds (`queued` or `waiting_for_operator`) if it is still in
   * `from`: → `cancelled` with `cancellation`, finished at `now` (Issue #100). `null` if not.
   * Kept for the long-wait sweep that runs with a claim and as a scheduled sweep (Studio's own
   * cancel, not the operator's): a sweep is not an operator-triggered operation (Issue #167).
   */
  cancelUnheld(
    runId: string,
    from: 'queued' | 'waiting_for_operator',
    cancellation: RunCancellation,
    now: Date,
  ): Promise<RunSnapshot | null>;

  /** Every Run waiting for the operator (Issue #100: the long-wait sweep); without messages. */
  listWaiting(): Promise<RunSnapshot[]>;

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

  /** Requested delivery retries no worker holds, with the worker that started each (#102). */
  listPendingDeliveryRetries(): Promise<{ runId: string; startedBy: string | null }[]>;

  /**
   * Gives up a requested delivery retry no worker holds (review N2 of #122): it stays `failed`
   * with `failure`, the request is cleared, finished at `now`. False if the condition failed.
   */
  abandonDeliveryRetry(runId: string, failure: RunFailure, now: Date): Promise<boolean>;

  /** Resumable Runs no worker claimed yet, with the worker that started each (Issue #103). */
  listPendingResumes(): Promise<{ runId: string; startedBy: string | null }[]>;

  /**
   * Gives up a resumable Run whose worker is gone (Issue #103): if it is still resumable, →
   * `failed` with `failure`, finished at `now`. False if the condition failed.
   */
  abandonResume(runId: string, failure: RunFailure, now: Date): Promise<boolean>;

  /** The states of the Runs with these ids (valid UUIDs); ids that name no Run are left out. */
  findStates(ids: readonly string[]): Promise<RunStateView[]>;

  /**
   * Issue #143: the final Runs without a pull request, in these Projects, whose Working copy was
   * not reported removed: what the per-Project retention limit counts.
   */
  findLimitedRuns(projectIds: readonly string[]): Promise<LimitedRunView[]>;

  /** The Run's stored steps, by number (Issue #99), as their snapshots. */
  listSteps(runId: string): Promise<(RunStepSnapshot & { reportedAt: Date })[]>;

  /**
   * Ids of Runs with a pull request whose state is `draft`, `open` or unknown, whose last lookup
   * was requested before `attemptedBefore` (or never; a read before it counts when no attempt is
   * recorded) and that are not being refreshed, oldest attempt first (Issue #142: the daily
   * refresh; review S2 of #152: counted from the attempt, not from the last success).
   */
  listDueForDailyRefresh(attemptedBefore: Date, limit: number): Promise<string[]>;

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
