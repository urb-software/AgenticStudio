import { Inject, Injectable } from '@nestjs/common';
import { isRunId, type Run } from '../../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import type { FollowUpView } from '../../../domain/value-objects/retention-policy.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RETENTION_POLICY, type RetentionPolicy } from '../../ports/retention-policy.js';
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
    @Inject(RETENTION_POLICY) private readonly retention: RetentionPolicy,
  ) {}

  async execute(
    runId: string,
  ): Promise<{ run: Run; followUp: FollowUpView; workerConnected: boolean }> {
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    const now = this.clock.now();
    const over =
      this.retention.isLimited(run.retentionFacts()) &&
      this.retention.overLimit(await this.runs.findLimitedRuns([run.projectId])).has(run.id);
    return this.retention.runView(
      run,
      {
        holderLastSeen:
          run.lastClaimedBy === null ? undefined : this.workers.lastSeen(run.lastClaimedBy),
        latest: this.workers.latest(),
      },
      now,
      this.lease.seconds,
      over,
    );
  }
}
