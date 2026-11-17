import { Inject, Injectable } from '@nestjs/common';
import { isRunId, type Run } from '../../../domain/entities/run.js';
import {
  canRefreshPullRequest,
  pageRefreshDue,
  PullRequestNotRefreshableError,
} from '../../../domain/entities/run-lookup.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../../domain/repositories/run-lookup-repository.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import { type FollowUpView, runView } from '../../../domain/services/follow-up-context.js';
import { isOverLimit } from '../../../domain/services/retention.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RETENTION_POLICY, type RetentionPolicy } from '../../ports/retention-policy.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

/**
 * Command (Issue #142): the operator, or the Run page when it opens, asks for the state of the
 * Run's pull request to be read again. Studio only records a request; an agent worker carries it
 * out through the Agent account and reports the result, so the answer is the Run as it is now,
 * marked as refreshing. When a refresh is under way already, it is that one. From the Run page's
 * own request (`onOpen`) at most one request a minute per Run is recorded. Throws
 * {@link RunNotFoundError} or {@link PullRequestNotRefreshableError}.
 */
@Injectable()
export class RefreshPullRequestHandler {
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
    options: { onOpen: boolean },
  ): Promise<{ run: Run; followUp: FollowUpView; workerConnected: boolean }> {
    const found = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!found) throw new RunNotFoundError();
    if (!canRefreshPullRequest(found)) throw new PullRequestNotRefreshableError();
    const now = this.clock.now();
    if (!options.onOpen || pageRefreshDue(found, now)) {
      const outcome = await this.lookups.request(found.id, 'pull_request_state', now);
      if (outcome === 'not_possible') throw new PullRequestNotRefreshableError();
    }
    const run = (await this.runs.findById(found.id)) ?? found;
    return runView(
      run,
      this.workers,
      now,
      this.lease.seconds,
      this.retention,
      await isOverLimit(this.runs, run, this.retention),
    );
  }
}
