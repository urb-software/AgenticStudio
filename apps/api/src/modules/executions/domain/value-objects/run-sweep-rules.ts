import { type Run, lostWorkerRule, type RunFailure } from '../entities/run.js';

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
    const rule = lostWorkerRule(now, leaseSeconds);
    return new LostWorkerRule(rule.staleBefore, rule.failure, rule.deliveryFailure);
  }

  /** Whether the Run has lost its worker. */
  selects(run: Pick<Run, 'claimedBy' | 'heartbeatAt'>): boolean {
    return run.claimedBy !== null && run.heartbeatAt !== null && run.heartbeatAt < this.staleBefore;
  }

  /** What happens to a selected Run. */
  resultFor(run: Pick<Run, 'state'>): { failure: RunFailure; retryEnds: boolean } {
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
  private constructor(
    readonly now: Date,
    readonly graceMinutes: number,
  ) {}

  static at(now: Date, graceMinutes: number): OverdueStepRule {
    return new OverdueStepRule(now, graceMinutes);
  }

  selects(run: Pick<Run, 'state' | 'stepStartedAt' | 'limits'>): boolean {
    if (run.state !== 'running' || run.stepStartedAt === null) return false;
    const allowedMs = (run.limits.stepMinutes + this.graceMinutes) * 60_000;
    return this.now.getTime() - run.stepStartedAt.getTime() > allowedMs;
  }
}
