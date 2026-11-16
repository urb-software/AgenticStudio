import { Inject, Injectable } from '@nestjs/common';
import {
  followUpEligibility,
  type FollowUpEligibility,
  FollowUpNotAllowedError,
  isRunId,
  type Run,
} from '../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';
import { followUpContext } from '../../domain/services/follow-up-context.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

/**
 * Command (Issue #141): the operator sends a Follow-up to a finished Run. When the Run can take
 * one ({@link followUpEligibility}), the text is stored in its conversation and the Run goes
 * back to `queued`; the agent worker that holds its Working copy then claims it, under the
 * concurrency limits, and resumes the same agent session with the Follow-up as the next Run
 * step. The store re-checks the conditions under a row lock, so a second submission is refused.
 * The text is the operator's input: stored as given (the endpoint trims and bounds it). Returns
 * the queued Run and its eligibility now. Throws {@link RunNotFoundError} or
 * {@link FollowUpNotAllowedError}.
 */
@Injectable()
export class FollowUpRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_STATUS_STORE) private readonly workers: WorkerStatusStore,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
  ) {}

  async execute(runId: string, text: string): Promise<{ run: Run; followUp: FollowUpEligibility }> {
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    const before = this.eligibility(run);
    if (!before.allowed) throw new FollowUpNotAllowedError(before.reason);
    const queued = await this.runs.queueFollowUp(run.id, text, this.clock.now());
    if (queued) return { run: queued, followUp: this.eligibility(queued) };
    // The Run changed in between (a second submission, a claim): report why, as it is now.
    const current = await this.runs.findById(run.id);
    const after = current ? this.eligibility(current) : before;
    throw new FollowUpNotAllowedError(after.allowed ? 'not_finished' : after.reason);
  }

  private eligibility(run: Run): FollowUpEligibility {
    return followUpEligibility(
      run,
      followUpContext(run, this.workers, this.clock.now(), this.lease.seconds),
    );
  }
}
