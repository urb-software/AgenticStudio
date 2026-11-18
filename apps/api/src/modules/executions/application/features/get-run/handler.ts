import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type RunSnapshot } from '../../../domain/value-objects/run-snapshot.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import type { FollowUpView } from '../../../domain/value-objects/retention-policy.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RETENTION_POLICY, type RetentionPolicy } from '../../ports/retention-policy.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';
import { RunNotFoundError } from '../../../domain/value-objects/run-errors.js';

export interface GetRunInput {
  runId: string;
}

export interface GetRunResult {
  run: RunSnapshot;
  followUp: FollowUpView;
  workerConnected: boolean;
  /** Whether a prepared Follow-up waits for the operator (the Run page shows it). */
  preparedFollowUp: boolean;
}

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
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY)
    private readonly preparedFollowUps: PreparedFollowUpRepository,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    @Inject(RETENTION_POLICY) private readonly retention: RetentionPolicy,
  ) {}

  async execute(input: GetRunInput): Promise<GetRunResult> {
    const { runId } = input;
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    const now = this.clock.now();
    const over =
      this.retention.isLimited(run.retentionFacts()) &&
      this.retention.overLimit(await this.runs.findLimitedRuns([run.projectId])).has(run.id);
    const view = this.retention.runView(
      run,
      {
        holderLastSeen:
          run.claim.lastClaimedBy === null
            ? undefined
            : this.workers.lastSeen(run.claim.lastClaimedBy),
        latest: this.workers.latest(),
      },
      now,
      this.lease.seconds,
      over,
    );
    return {
      ...view,
      preparedFollowUp: (await this.preparedFollowUps.findRunIdsAmong([run.id])).has(run.id),
    };
  }
}
