import { Inject, Injectable, Logger } from '@nestjs/common';
import { type FollowUpOrigin } from '../../../domain/entities/run-follow-up-facts.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type RunSnapshot } from '../../../domain/entities/run-snapshot.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import type { FollowUpSource } from '../../../domain/value-objects/follow-up-source.js';
import type { FollowUpView } from '../../../domain/value-objects/retention-policy.js';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RETENTION_POLICY, type RetentionPolicy } from '../../ports/retention-policy.js';
import { RUN_TRANSACTIONS, type RunTransactions } from '../../ports/run-transactions.js';
import { RunLookupRequests } from '../../run-lookup-requests.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export interface FollowUpRunInput {
  runId: string;
  text: string;
  source?: FollowUpSource;
  reviewCommentIds?: readonly string[];
}

export interface FollowUpRunResult {
  run: RunSnapshot;
  followUp: FollowUpView;
  workerConnected: boolean;
  preparedFollowUp: boolean;
}

/**
 * Runs in `RunTransactions` under the Run's row lock, so a second submission is refused. Throws
 * `RunNotFoundError`, `FollowUpNotAllowedError` or `ReviewCommentsNotLoadedError`.
 */
@Injectable()
export class FollowUpRunHandler {
  private readonly logger = new Logger('FollowUpRun');

  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_STATUS_STORE) private readonly workers: WorkerStatusStore,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    private readonly lookups: RunLookupRequests,
    @Inject(RETENTION_POLICY) private readonly retention: RetentionPolicy,
    @Inject(RUN_TRANSACTIONS) private readonly transactions: RunTransactions,
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY)
    private readonly preparedFollowUps: PreparedFollowUpRepository,
  ) {}

  async execute(input: FollowUpRunInput): Promise<FollowUpRunResult> {
    const { runId, text, source, reviewCommentIds = [] } = input;
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    const now = this.clock.now();
    const facts = run.followUpFacts(
      {
        holderLastSeen:
          run.claim.lastClaimedBy === null
            ? undefined
            : this.workers.lastSeen(run.claim.lastClaimedBy),
        latest: this.workers.latest(),
      },
      now,
      this.lease.seconds,
    );
    // Run locked first, then the Review comments (the order of every operation across aggregates):
    // a load that completes meanwhile waits for this transaction, so the set the selection is
    // checked against is the set that is removed with the Follow-up.
    const queued = await this.transactions.withRunLocked(run.id, async (repositories) => {
      const locked = await repositories.runs.findById(run.id);
      if (!locked) throw new RunNotFoundError();
      const origin: FollowUpOrigin | undefined =
        source === 'review_comments'
          ? {
              source,
              comments:
                (await repositories.reviewComments.find(run.id))?.selection(reviewCommentIds) ??
                null,
            }
          : source;
      const consumed = locked.followUp(text, now, facts, origin);
      await repositories.runs.save(locked);
      if (consumed === 'review_comments') await repositories.reviewComments.discard(run.id);
      else if (consumed !== undefined)
        await repositories.preparedFollowUps.discard(run.id, consumed);
      return (await repositories.runs.findById(run.id)) ?? locked;
    });
    await this.lookups
      .request(queued.id, 'pull_request_state', this.clock.now())
      .catch((error: unknown) => {
        // The Follow-up is accepted anyway; the worker reads the state again before it starts.
        this.logger.warn(
          `Asking for the pull request state of run ${queued.id} failed: ${redactSecrets(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
      });
    const refreshed = (await this.runs.findById(queued.id)) ?? queued;
    const viewedAt = this.clock.now();
    const over =
      this.retention.isLimited(refreshed.retentionFacts()) &&
      this.retention
        .overLimit(await this.runs.findLimitedRuns([refreshed.projectId]))
        .has(refreshed.id);
    const workers = {
      holderLastSeen:
        refreshed.claim.lastClaimedBy === null
          ? undefined
          : this.workers.lastSeen(refreshed.claim.lastClaimedBy),
      latest: this.workers.latest(),
    };
    const view = {
      run: refreshed.snapshot(),
      ...this.retention.runView(
        refreshed.followUpAvailability(workers, viewedAt, this.lease.seconds),
        refreshed.retentionFacts(),
        workers.latest,
        viewedAt,
        this.lease.seconds,
        over,
      ),
    };
    return {
      ...view,
      preparedFollowUp: (await this.preparedFollowUps.findRunIdsAmong([refreshed.id])).has(
        refreshed.id,
      ),
    };
  }
}
