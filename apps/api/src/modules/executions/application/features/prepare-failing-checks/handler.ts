import { Inject, Injectable } from '@nestjs/common';
import { isRunId, type Run } from '../../../domain/entities/run.js';
import {
  canRefreshPullRequest,
  hasFailedPullRequestCheck,
} from '../../../domain/value-objects/run-lookup.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../../domain/repositories/run-lookup-repository.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import type { FollowUpView } from '../../../domain/value-objects/retention-policy.js';
import { WorkerStatus } from '../../../domain/value-objects/worker-status.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RETENTION_POLICY, type RetentionPolicy } from '../../ports/retention-policy.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';
import { PullRequestNotRefreshableError } from '../../../domain/value-objects/run-lookup.js';

/** None of the Run's stored Pull request checks has failed: nothing to prepare (Issue #145). */
export class NoFailingChecksError extends Error {
  constructor() {
    super('No pull request check of the run is known to have failed.');
    this.name = 'NoFailingChecksError';
  }
}

/**
 * Command (Issue #145): the operator asks for the failing Pull request checks to be turned into a
 * Follow-up. Studio only records a request; an agent worker reads, through the Agent account, the
 * end of the log of each failed check and reports it, and Studio stores the prepared text for
 * the operator to review. Nothing is sent to an agent: sending is the normal Follow-up, on the
 * operator's own action. When a preparation is under way already, it is that one. The answer is
 * the Run as it is now, marked as preparing. Throws {@link RunNotFoundError},
 * {@link PullRequestNotRefreshableError} (no pull request to read) or
 * {@link NoFailingChecksError}.
 */
@Injectable()
export class PrepareFailingChecksHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_STATUS_STORE) private readonly workers: WorkerStatusStore,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    @Inject(RETENTION_POLICY) private readonly retention: RetentionPolicy,
  ) {}

  async execute(
    runId: string,
  ): Promise<{ run: Run; followUp: FollowUpView; workerConnected: boolean }> {
    const found = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!found) throw new RunNotFoundError();
    if (!canRefreshPullRequest(found)) throw new PullRequestNotRefreshableError();
    if (!hasFailedPullRequestCheck(found)) throw new NoFailingChecksError();
    const now = this.clock.now();
    const outcome = await this.lookups.request(found.id, 'failing_check_logs', now);
    if (outcome === 'not_possible') throw new PullRequestNotRefreshableError();
    const run = (await this.runs.findById(found.id)) ?? found;
    const facts = run.retentionFacts();
    const over =
      this.retention.isLimited(facts) &&
      this.retention.overLimit(await this.runs.findLimitedRuns([run.projectId])).has(run.id);
    const latest = this.workers.latest();
    const eligibility = run.followUpAvailability(
      {
        holderLastSeen:
          run.lastClaimedBy === null ? undefined : this.workers.lastSeen(run.lastClaimedBy),
        latest,
      },
      now,
      this.lease.seconds,
    );
    return {
      run,
      followUp: this.retention.followUpView(eligibility, facts, over, now),
      workerConnected: WorkerStatus.isAnyConnected(latest, now, this.lease.seconds),
    };
  }
}
