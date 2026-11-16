import { Inject, Injectable } from '@nestjs/common';
import {
  followUpEligibility,
  type FollowUpEligibility,
  isRunId,
  type Run,
} from '../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';
import { anyWorkerConnected, followUpContext } from '../../domain/services/follow-up-context.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

/**
 * Query (Issue #96): one Run, and whether it can take a Follow-up now (Issue #141). Throws
 * {@link RunNotFoundError}, also for an id that is not a UUID.
 */
@Injectable()
export class GetRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_STATUS_STORE) private readonly workers: WorkerStatusStore,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
  ) {}

  async execute(
    runId: string,
  ): Promise<{ run: Run; followUp: FollowUpEligibility; workerConnected: boolean }> {
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    const now = this.clock.now();
    const context = followUpContext(run, this.workers, now, this.lease.seconds);
    return {
      run,
      followUp: followUpEligibility(run, context),
      workerConnected: anyWorkerConnected(this.workers, now, this.lease.seconds),
    };
  }
}
