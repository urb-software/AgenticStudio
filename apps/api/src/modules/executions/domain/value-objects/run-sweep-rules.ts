import type { RunCancellation } from './run-cancellation.js';
import type { RunFailure } from './run-failure.js';
import type { RunLimits } from './run-limits.js';
import type { RunState } from './run-state.js';

/**
 * What the sweep rules read of a Run, as values: the entity's snapshot (and the store's rows)
 * carry these fields, and each rule picks the ones it needs.
 */
export interface RunSweepFacts {
  state: RunState;
  claimedBy: string | null;
  heartbeatAt: Date | null;
  stepStartedAt: Date | null;
  waitingSince: Date | null;
  limits: RunLimits;
  deliveryRequested: boolean;
  sessionRef: string | null;
}

/**
 * The lost-worker rule (Issue #96, #102, #169): a Run a worker holds whose last heartbeat is older
 * than the lease has lost its worker. A `preparing` or `running` one fails with `failure`; a
 * `failed` one held for a delivery retry stays `failed` with `deliveryFailure` and its retry
 * request cleared. The store's sweep (`failStaleClaims`) is one set-wide statement with the cut-off
 * and the failures this rule supplies; {@link LostWorkerRule.selects} is the same selection over
 * one Run, which a test uses to prove the statement follows it.
 */
export class LostWorkerRule {
  private constructor(
    readonly staleBefore: Date,
    readonly failure: RunFailure,
    readonly deliveryFailure: RunFailure,
  ) {}

  static at(now: Date, leaseSeconds: number): LostWorkerRule {
    return new LostWorkerRule(
      new Date(now.getTime() - leaseSeconds * 1000),
      {
        code: 'worker_lost',
        detail: `The agent worker sent no heartbeat for ${leaseSeconds} seconds.`,
      },
      // A delivery retry whose worker was lost stays a failed delivery, so it can be retried.
      {
        code: 'delivery_failed',
        detail:
          `The agent worker sent no heartbeat for ${leaseSeconds} seconds while it retried the ` +
          'delivery. Retry the delivery.',
      },
    );
  }

  /** Whether the Run has lost its worker. */
  selects(run: Pick<RunSweepFacts, 'claimedBy' | 'heartbeatAt'>): boolean {
    return run.claimedBy !== null && run.heartbeatAt !== null && run.heartbeatAt < this.staleBefore;
  }

  /** What happens to a selected Run. */
  resultFor(run: Pick<RunSweepFacts, 'state'>): { failure: RunFailure; retryEnds: boolean } {
    return run.state === 'failed'
      ? { failure: this.deliveryFailure, retryEnds: true }
      : { failure: this.failure, retryEnds: false };
  }
}

/**
 * Studio's backstop for the step time limit (review of #121, Issue #169): a `running` Run whose
 * current step (not yet reported) started more than its `stepMinutes` plus the grace before `now`
 * is `timed_out`, released and finished at `now`. The store's sweep (`timeOutOverdueSteps`) is one
 * set-wide statement; {@link OverdueStepRule.selects} is the same selection over one Run.
 */
export class OverdueStepRule {
  /**
   * The agent worker stops a Run step at `stepMinutes`; if a `running` Run's step is still going
   * this much later, Studio itself ends the Run as `timed_out`.
   */
  static readonly GRACE_MINUTES = 5;

  private constructor(
    readonly now: Date,
    readonly graceMinutes: number,
  ) {}

  static at(now: Date, graceMinutes: number = OverdueStepRule.GRACE_MINUTES): OverdueStepRule {
    return new OverdueStepRule(now, graceMinutes);
  }

  selects(run: Pick<RunSweepFacts, 'state' | 'stepStartedAt' | 'limits'>): boolean {
    if (run.state !== 'running' || run.stepStartedAt === null) return false;
    const allowedMs = (run.limits.stepMinutes + this.graceMinutes) * 60_000;
    return this.now.getTime() - run.stepStartedAt.getTime() > allowedMs;
  }
}

/**
 * The long-wait rule (Issue #100, #169): a Run waiting for the operator longer than its own
 * `waitingDays` is cancelled by Studio, with the reason `cancellationFor` states. The store lists
 * the Runs waiting for the operator (`listWaiting`: the only condition it holds is the state, the
 * rule's {@link LongWaitRule.candidate}) and cancels one only while it still waits
 * (`cancelUnheld`); {@link LongWaitRule.selects} decides which of them are cancelled.
 */
export class LongWaitRule {
  private constructor(readonly now: Date) {}

  static at(now: Date): LongWaitRule {
    return new LongWaitRule(now);
  }

  /** The Runs the store lists for the sweep. */
  static candidate(run: Pick<RunSweepFacts, 'state'>): boolean {
    return run.state === 'waiting_for_operator';
  }

  selects(run: Pick<RunSweepFacts, 'state' | 'waitingSince' | 'limits'>): boolean {
    return this.cancellationFor(run) !== null;
  }

  /** What happens to a selected Run: cancelled by Studio, with the reason stated; else `null`. */
  cancellationFor(
    run: Pick<RunSweepFacts, 'state' | 'waitingSince' | 'limits'>,
  ): RunCancellation | null {
    if (run.state !== 'waiting_for_operator' || run.waitingSince === null) return null;
    const limitMs = run.limits.waitingDays * 24 * 60 * 60 * 1000;
    if (this.now.getTime() - run.waitingSince.getTime() <= limitMs) return null;
    const days = run.limits.waitingDays;
    return {
      by: 'system',
      reason: `Cancelled automatically: the run waited for the operator longer than ${days} ${days === 1 ? 'day' : 'days'}.`,
    };
  }
}

/**
 * The gone-worker rule (Issue #102, #103, #169): a requested delivery retry that no worker holds,
 * and an answered Run no worker claimed yet, can only be taken by the worker that started the Run;
 * when that worker has not reported for longer than the lease they fail (the failures below). The store lists the pending ones and gives one up only while it is
 * still pending; these are the predicates behind the two lists.
 */
export class GoneWorkerRule {
  private constructor(
    /** The worker that has not reported since this time (or since Studio started) is gone. */
    readonly seenBefore: Date,
    /** A requested delivery retry whose worker is gone fails with this and is released. */
    readonly deliveryRetryFailure: RunFailure,
    /** An answered Run whose worker is gone fails with this. */
    readonly resumeFailure: RunFailure,
  ) {}

  static at(now: Date, leaseSeconds: number): GoneWorkerRule {
    return new GoneWorkerRule(
      new Date(now.getTime() - leaseSeconds * 1000),
      {
        code: 'delivery_failed',
        detail:
          `Working copy no longer exists (agent worker gone): the agent worker that started this ` +
          `run has not reported for more than ${leaseSeconds} seconds.`,
      },
      {
        code: 'preparation_failed',
        detail:
          `Working copy no longer exists (agent worker gone) — run again: the agent worker that ` +
          `started this run has not reported for more than ${leaseSeconds} seconds.`,
      },
    );
  }

  /** Whether a worker last seen at `seen` is gone. */
  isGone(seen: Date): boolean {
    return seen < this.seenBefore;
  }

  /** A `failed` Run whose delivery retry was requested and that nobody holds. */
  static pendingDeliveryRetry(
    run: Pick<RunSweepFacts, 'state' | 'deliveryRequested' | 'claimedBy'>,
  ): boolean {
    return run.state === 'failed' && run.deliveryRequested && run.claimedBy === null;
  }

  /** A `queued` Run with an agent session: answered, or sent a Follow-up, and not claimed yet. */
  static pendingResume(run: Pick<RunSweepFacts, 'state' | 'sessionRef'>): boolean {
    return run.state === 'queued' && run.sessionRef !== null;
  }
}

/**
 * The lease renewal (Issue #100, review of #121, #169): when the API starts, every Run a worker
 * holds in `preparing` or `running` gets a heartbeat of `now`, so a short outage does not fail the
 * Runs their workers kept carrying; at most once per lease period, so a restart loop cannot keep a
 * dead worker's Run alive. The store renews in one statement and records the time of the renewal.
 */
export class LeaseRenewalRule {
  private constructor(
    readonly now: Date,
    readonly leaseSeconds: number,
  ) {}

  static at(now: Date, leaseSeconds: number): LeaseRenewalRule {
    return new LeaseRenewalRule(now, leaseSeconds);
  }

  /** Whether the Run's lease is renewed. */
  renews(run: Pick<RunSweepFacts, 'state'>): boolean {
    return run.state === 'preparing' || run.state === 'running';
  }

  /** Whether a renewal is due: none yet, or the last one is at least a lease old. */
  isDue(lastRenewal: Date | null): boolean {
    return (
      lastRenewal === null || this.now.getTime() - lastRenewal.getTime() >= this.leaseSeconds * 1000
    );
  }
}
