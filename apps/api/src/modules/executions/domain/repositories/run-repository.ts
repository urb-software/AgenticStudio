import type { Provider, Run, RunFailure, RunState, RunWorkingCopy } from '../entities/run.js';

/** DI token for the {@link RunRepository} adapter. */
export const RUN_REPOSITORY = Symbol('RUN_REPOSITORY');

export interface NewRun {
  projectId: string;
  provider: Provider;
  task: string;
  startCommit: string;
  remoteUrl: string;
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
   * Hands the oldest eligible `queued` Run (by creation time, then id) to `workerId`: →
   * `preparing`, started and heartbeat at `now`. Eligible: its project has no active Run and
   * fewer than `MAX_ACTIVE_RUNS` are active across the server. Serialized against concurrent
   * claims, so they cannot exceed the limits. `null` when nothing is eligible.
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

  /** The states of the Runs with these ids (valid UUIDs); ids that name no Run are left out. */
  findStates(ids: readonly string[]): Promise<RunStateView[]>;

  /**
   * Stores a Run step of a `running` Run held by `workerId`, numbered 1, 2, … in report
   * order, and makes `workingCopy` the Run's latest Working copy state, in one transaction;
   * returns its number, or `null` (nothing changed) if the Run is not `running` or not held by it.
   */
  appendStep(
    runId: string,
    workerId: string,
    step: RunStepRecord,
    workingCopy: RunWorkingCopy,
  ): Promise<number | null>;

  /** The Run's stored steps, by number (Issue #99). */
  listSteps(runId: string): Promise<StoredRunStep[]>;

  /**
   * Every held Run (`preparing` or `running`) whose last heartbeat is before `staleBefore` →
   * `failed` with `failure`, released and finished at `now`; returns how many.
   */
  failStaleClaims(staleBefore: Date, failure: RunFailure, now: Date): Promise<number>;
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
