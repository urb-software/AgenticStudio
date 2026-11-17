import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type RunSnapshot } from '../../../domain/value-objects/run-snapshot.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { PullRequestNotRefreshableError } from '../../../domain/value-objects/run-lookup.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import type { FollowUpView } from '../../../domain/value-objects/retention-policy.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RunLookupRequests } from '../../run-lookup-requests.js';
import { RETENTION_POLICY, type RetentionPolicy } from '../../ports/retention-policy.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

export interface RefreshPullRequestInput {
  runId: string;
  /** The Run page's own request on opening: at most one a minute per Run is recorded. */
  onOpen: boolean;
}

export interface RefreshPullRequestResult {
  run: RunSnapshot;
  followUp: FollowUpView;
  workerConnected: boolean;
  /** Whether a prepared Follow-up waits for the operator (the Run page shows it). */
  preparedFollowUp: boolean;
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
    private readonly lookups: RunLookupRequests,
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY)
    private readonly preparedFollowUps: PreparedFollowUpRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_STATUS_STORE) private readonly workers: WorkerStatusStore,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    @Inject(RETENTION_POLICY) private readonly retention: RetentionPolicy,
  ) {}

  async execute(input: RefreshPullRequestInput): Promise<RefreshPullRequestResult> {
    const { runId, onOpen } = input;
    const found = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!found) throw new RunNotFoundError();
    if (!found.canRefreshPullRequest()) throw new PullRequestNotRefreshableError();
    const now = this.clock.now();
    if (!onOpen || found.pullRequestStatus.pageRefreshDue(now)) {
      const outcome = await this.lookups.request(found.id, 'pull_request_state', now);
      if (outcome === 'not_possible') throw new PullRequestNotRefreshableError();
    }
    const run = (await this.runs.findById(found.id)) ?? found;
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
