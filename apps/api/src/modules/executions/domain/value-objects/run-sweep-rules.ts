import type { RunCancellation } from './run-cancellation.js';
import type { RunFailure } from './run-failure.js';
import type { RunLimits } from './run-limits.js';
import type { RunState } from './run-state.js';

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
 * The store's sweep (`failStaleClaims`) is one set-wide statement with the cut-off and the failures
 * this rule supplies; `selects` is the same selection over one Run, which a test uses to prove the
 * statement follows it.
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

  selects(run: Pick<RunSweepFacts, 'claimedBy' | 'heartbeatAt'>): boolean {
    return run.claimedBy !== null && run.heartbeatAt !== null && run.heartbeatAt < this.staleBefore;
  }

  resultFor(run: Pick<RunSweepFacts, 'state'>): { failure: RunFailure; retryEnds: boolean } {
    return run.state === 'failed'
      ? { failure: this.deliveryFailure, retryEnds: true }
      : { failure: this.failure, retryEnds: false };
  }
}

/**
 * The store's sweep (`timeOutOverdueSteps`) is one set-wide statement; `selects` is the same
 * selection over one Run.
 */
export class OverdueStepRule {
  /**
   * The agent worker stops a step at `stepMinutes`; Studio ends the Run itself
   * only this much later.
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
 * The store lists the waiting Runs (`listWaiting`, the state only) and cancels one only while it
 * still waits (`cancelUnheld`).
 */
export class LongWaitRule {
  private constructor(readonly now: Date) {}

  static at(now: Date): LongWaitRule {
    return new LongWaitRule(now);
  }

  static candidate(run: Pick<RunSweepFacts, 'state'>): boolean {
    return run.state === 'waiting_for_operator';
  }

  selects(run: Pick<RunSweepFacts, 'state' | 'waitingSince' | 'limits'>): boolean {
    return this.cancellationFor(run) !== null;
  }

  cancellationFor(
    run: Pick<RunSweepFacts, 'state' | 'waitingSince' | 'limits'>,
  ): RunCancellation | null {
    if (run.state !== 'waiting_for_operator' || run.waitingSince === null) return null;
    // The waiting limit is Studio's own: the agent worker never enforces it.
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
 * A pending delivery retry or resume can only be taken by the worker that last claimed the Run;
 * when that worker has not reported for longer than the lease, it fails. The store gives one up
 * only while it is pending.
 */
export class GoneWorkerRule {
  private constructor(
    readonly seenBefore: Date,
    readonly deliveryRetryFailure: RunFailure,
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

  isGone(seen: Date): boolean {
    return seen < this.seenBefore;
  }

  static pendingDeliveryRetry(
    run: Pick<RunSweepFacts, 'state' | 'deliveryRequested' | 'claimedBy'>,
  ): boolean {
    return run.state === 'failed' && run.deliveryRequested && run.claimedBy === null;
  }

  static pendingResume(run: Pick<RunSweepFacts, 'state' | 'sessionRef'>): boolean {
    return run.state === 'queued' && run.sessionRef !== null;
  }
}

/**
 * At most once per lease period, so a restart loop cannot keep a dead worker's Run alive. The store
 * renews in one statement.
 */
export class LeaseRenewalRule {
  private constructor(
    readonly now: Date,
    readonly leaseSeconds: number,
  ) {}

  static at(now: Date, leaseSeconds: number): LeaseRenewalRule {
    return new LeaseRenewalRule(now, leaseSeconds);
  }

  renews(run: Pick<RunSweepFacts, 'state'>): boolean {
    return run.state === 'preparing' || run.state === 'running';
  }

  isDue(lastRenewal: Date | null): boolean {
    return (
      lastRenewal === null || this.now.getTime() - lastRenewal.getTime() >= this.leaseSeconds * 1000
    );
  }
}
