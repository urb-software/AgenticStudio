import { Inject, Injectable, Logger } from '@nestjs/common';
import { type FollowUpOrigin } from '../../../domain/entities/run-follow-up-facts.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import type { FollowUpSource } from '../../../domain/value-objects/follow-up-source.js';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
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
    @Inject(RUN_TRANSACTIONS) private readonly transactions: RunTransactions,
  ) {}

  async execute(input: FollowUpRunInput): Promise<void> {
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
    await this.transactions.withRunLocked(run.id, async (repositories) => {
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
    });
    await this.lookups
      .request(run.id, 'pull_request_state', this.clock.now())
      .catch((error: unknown) => {
        // The Follow-up is accepted anyway; the worker reads the state again before it starts.
        this.logger.warn(
          `Asking for the pull request state of run ${run.id} failed: ${redactSecrets(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
      });
  }
}
