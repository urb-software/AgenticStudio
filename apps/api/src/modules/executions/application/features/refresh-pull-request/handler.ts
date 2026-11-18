import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type RunSnapshot } from '../../../domain/entities/run-snapshot.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import type { FollowUpView } from '../../../domain/value-objects/follow-up-view.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RunLookupRequests } from '../../run-lookup-requests.js';
import { RETENTION_POLICY, type RetentionPolicy } from '../../ports/retention-policy.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';
import {
  PullRequestNotRefreshableError,
  RunNotFoundError,
} from '../../../domain/errors/run-errors.js';

export interface RefreshPullRequestInput {
  runId: string;
  /** Request on opening the Run page: at most one a minute per Run is recorded. */
  onOpen: boolean;
}

export interface RefreshPullRequestResult {
  run: RunSnapshot;
  followUp: FollowUpView;
  workerConnected: boolean;
  preparedFollowUp: boolean;
}

/** Throws {@link RunNotFoundError} or {@link PullRequestNotRefreshableError}. */
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
    const workers = {
      holderLastSeen:
        run.claim.lastClaimedBy === null
          ? undefined
          : this.workers.lastSeen(run.claim.lastClaimedBy),
      latest: this.workers.latest(),
    };
    const view = {
      run: run.snapshot(),
      ...this.retention.runView(
        run.followUpAvailability(workers, now, this.lease.seconds),
        run.retentionFacts(),
        workers.latest,
        now,
        this.lease.seconds,
        over,
      ),
    };
    return {
      ...view,
      preparedFollowUp: (await this.preparedFollowUps.findRunIdsAmong([run.id])).has(run.id),
    };
  }
}
