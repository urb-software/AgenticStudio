import type { Provider } from '../value-objects/provider.js';
import type { PullRequestState } from '../value-objects/pull-request-state.js';
import type { ResumeFacts } from '../entities/run-resume-facts.js';
import type { Run } from '../entities/run.js';
import type { RunFailure } from '../value-objects/run-failure.js';
import type { RunState } from '../value-objects/run-state.js';
import type { RunStepKind } from '../value-objects/run-step-kind.js';

export {
  RunNotHeldError,
  StepLimitReachedError,
  StepOutOfOrderError,
} from '../errors/run-errors.js';

export const RUN_REPOSITORY = Symbol('RUN_REPOSITORY');

export interface RunStateView {
  runId: string;
  projectId: string;
  provider: Provider;
  /** Internal: only the agent worker is told. */
  sessionRef: string | null;
  state: RunState;
  /** Set exactly in a final state. */
  finishedAt: Date | null;
  hasPullRequest: boolean;
  pullRequestState: PullRequestState | null;
  pullRequestEndedAt: Date | null;
  lastActivityAt: Date;
}

/** A final Run without a pull request, whose Working copy the per-Project limit counts. */
export interface LimitedRunView {
  runId: string;
  projectId: string;
  finishedAt: Date;
}

export interface RunsSummary {
  running: number;
  waiting: number;
}

/** A step as the step list shows it; `reportedAt` is when the store recorded it. */
export interface RunStepView {
  index: number;
  kind: RunStepKind;
  result: unknown;
  reportedAt: Date;
}

export interface RunRepository {
  add(run: Run): Promise<Run>;

  findById(id: string): Promise<Run | null>;

  exists(id: string): Promise<boolean>;

  /**
   * Only for a caller that holds the Run's row lock, so what it decided from the Run holds until
   * the save.
   */
  save(run: Run): Promise<void>;

  /**
   * One transaction: loads the Run `FOR UPDATE`, calls `mutate`, saves what it changed. `null` when
   * no Run has this id. `mutate` does no I/O; what it throws rolls back and reaches the caller.
   */
  change(runId: string, mutate: (run: Run) => void): Promise<Run | null>;

  /**
   * {@link change} serialized with claims (it takes the lock a claim takes first), so the facts
   * `mutate` gets hold until the save. The partial unique index refusing it is `RunSlotTakenError`.
   */
  changeSerializedWithClaims(
    runId: string,
    mutate: (run: Run, facts: ResumeFacts) => void,
  ): Promise<Run | null>;

  /** Newest first (creation time, then id). `messages` is empty: `findById` reads it. */
  listNewestFirst(): Promise<Run[]>;

  listByProjectNewestFirst(projectId: string): Promise<Run[]>;

  summarize(): Promise<RunsSummary>;

  /**
   * Hands the oldest eligible Run to `workerId`; a delivery retry or a resumable Run goes only to
   * the worker that last claimed it. Serialized against concurrent claims. `null`
   * when none is eligible. Runs of `excludeProjectId` are never handed out.
   */
  claimNext(workerId: string, now: Date, excludeProjectId?: string | null): Promise<Run | null>;

  listWaiting(): Promise<Run[]>;

  /**
   * At most once per lease period, stored, so an API that keeps restarting cannot keep a dead
   * worker's Run alive. `null` when a renewal happened less than `leaseSeconds` ago.
   */
  renewClaimsOncePerLease(now: Date, leaseSeconds: number): Promise<number | null>;

  /** Backstop for the step time limit: its `stepMinutes` plus `graceMinutes`. Returns how many. */
  timeOutOverdueSteps(now: Date, graceMinutes: number): Promise<number>;

  listPendingDeliveryRetries(): Promise<{ runId: string; startedBy: string | null }[]>;

  listPendingResumes(): Promise<{ runId: string; startedBy: string | null }[]>;

  /** Ids must be valid UUIDs; ids that name no Run are left out. */
  findStates(ids: readonly string[]): Promise<RunStateView[]>;

  /**
   * Only final Runs without a pull request and without a removed Working copy: what the per-Project
   * limit counts.
   */
  findLimitedRuns(projectIds: readonly string[]): Promise<LimitedRunView[]>;

  /** The steps of a Run in report order. */
  listSteps(runId: string): Promise<RunStepView[]>;

  /**
   * Runs whose pull request state is `draft`, `open` or unknown and whose last state lookup was
   * requested before `attemptedBefore` (counted from the attempt, not the last success), oldest
   * attempt first.
   */
  listDueForDailyRefresh(attemptedBefore: Date, limit: number): Promise<string[]>;

  /**
   * A `failed` Run held for a delivery retry keeps `failed` with
   * `deliveryFailure`. Returns how many.
   */
  failStaleClaims(
    staleBefore: Date,
    failure: RunFailure,
    deliveryFailure: RunFailure,
    now: Date,
  ): Promise<number>;

  /** `null` when none, or already deleted. */
  findEnvironmentFileSecret(runId: string): Promise<string | null>;

  /**
   * Excludes a `failed` Run with `delivery_failed` that finished at or after
   * `retryableFinishedBefore` or retries.
   */
  listReleasableEnvironmentFileSecrets(
    retryableFinishedBefore: Date,
  ): Promise<{ runId: string; secretRef: string }[]>;

  /** Only if the reference is still `secretRef`. */
  clearEnvironmentFileSecret(runId: string, secretRef: string): Promise<void>;

  /** Every reference any Run holds; the orphan sweep keeps exactly these. */
  listEnvironmentFileSecretRefs(): Promise<string[]>;
}
