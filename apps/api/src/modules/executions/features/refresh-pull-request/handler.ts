import { Inject, Injectable } from '@nestjs/common';
import {
  followUpEligibility,
  type FollowUpEligibility,
  isRunId,
  type Run,
} from '../../domain/entities/run.js';
import { canRefreshPullRequest, pageRefreshDue } from '../../domain/entities/run-lookup.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../domain/repositories/run-lookup-repository.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';
import { anyWorkerConnected, followUpContext } from '../../domain/services/follow-up-context.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

/** The Run has no pull request (or no known Run branch) whose state could be read. */
export class PullRequestNotRefreshableError extends Error {
  constructor() {
    super('The run has no pull request to refresh.');
    this.name = 'PullRequestNotRefreshableError';
  }
}

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
  ) {}

  async execute(
    runId: string,
    options: { onOpen: boolean },
  ): Promise<{ run: Run; followUp: FollowUpEligibility; workerConnected: boolean }> {
    const found = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!found) throw new RunNotFoundError();
    if (!canRefreshPullRequest(found)) throw new PullRequestNotRefreshableError();
    const now = this.clock.now();
    if (!options.onOpen || pageRefreshDue(found, now)) {
      const outcome = await this.lookups.request(found.id, 'pull_request_state', now);
      if (outcome === 'not_possible') throw new PullRequestNotRefreshableError();
    }
    const run = (await this.runs.findById(found.id)) ?? found;
    return {
      run,
      followUp: followUpEligibility(
        run,
        followUpContext(run, this.workers, now, this.lease.seconds),
      ),
      workerConnected: anyWorkerConnected(this.workers, now, this.lease.seconds),
    };
  }
}
