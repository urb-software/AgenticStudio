import { Inject, Injectable, Logger } from '@nestjs/common';
import { type FollowUpOrigin } from '../../../domain/value-objects/run-facts.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type RunSnapshot } from '../../../domain/value-objects/run-snapshot.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import type { FollowUpSource } from '../../../domain/value-objects/follow-up.js';
import type { FollowUpView } from '../../../domain/value-objects/retention-policy.js';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RETENTION_POLICY, type RetentionPolicy } from '../../ports/retention-policy.js';
import { RUN_TRANSACTIONS, type RunTransactions } from '../../ports/run-transactions.js';
import { RunLookupRequests } from '../../run-lookup-requests.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';
import { RunNotFoundError } from '../../../domain/value-objects/run-errors.js';

export interface FollowUpRunInput {
  runId: string;
  /** The operator's text: stored as given (the endpoint trims and bounds it). */
  text: string;
  /** What the text was prepared from, when it was (Issues #145, #146, #147). */
  source?: FollowUpSource;
  /** With source `review_comments`: the ids of the comments the operator selected. */
  reviewCommentIds?: readonly string[];
}

export interface FollowUpRunResult {
  /** The Run, queued for the Follow-up. */
  run: RunSnapshot;
  /** Whether the Run can take another Follow-up now, and until when it stays open to one. */
  followUp: FollowUpView;
  workerConnected: boolean;
  /** Whether a prepared Follow-up waits for the operator (the Run page shows it). */
  preparedFollowUp: boolean;
}

/**
 * Command (Issue #141): the operator sends a Follow-up to a finished Run. When the Run can take
 * one (its `followUp` method decides, with what the handler knows of the agent worker), the text
 * is stored in its conversation and the Run goes back to `queued`; the agent worker that holds
 * its Working copy then claims it, under the concurrency limits, and resumes the same agent
 * session with the Follow-up as the next Run step. The method runs in the module's
 * `RunTransactions`, under the Run's row lock taken first, so a second submission is refused.
 * The text is the operator's input: stored as given (the endpoint trims and bounds it), with its
 * `source` when it was prepared from failing checks (Issue #145: the prepared draft is then
 * removed in the same step). Issue #147: the source `bring_up_to_date` marks a request to bring
 * the Run branch up to date, which is a Follow-up in every other respect (its text is the
 * operator's note, possibly empty). Returns the queued Run and its eligibility now. Issue #146: a
 * Follow-up from `review_comments` names the selected comments, which must all be in the Run's
 * loaded set (its text is the operator's): what the selection comes to is read under the Run's
 * lock and passed to the Run as values; the Follow-up records how many there are and their
 * authors, and the loaded set is removed in the same transaction. Throws `RunNotFoundError`,
 * `FollowUpNotAllowedError` or `ReviewCommentsNotLoadedError`.
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
      // Issue #146: what the selected comments come to in the loaded set, as values for the Run.
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
      // What the Follow-up used up beyond the Run goes in the same transaction (Issues #145, #146).
      if (consumed === 'review_comments') await repositories.reviewComments.discard(run.id);
      else if (consumed !== undefined)
        await repositories.preparedFollowUps.discard(run.id, consumed);
      return (await repositories.runs.findById(run.id)) ?? locked;
    });
    // Issue #142: the pull request state is read again with every Follow-up (the agent worker
    // also checks it before it starts the agent); the page then shows the state it found.
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
    const view = this.retention.runView(
      refreshed,
      {
        holderLastSeen:
          refreshed.claim.lastClaimedBy === null
            ? undefined
            : this.workers.lastSeen(refreshed.claim.lastClaimedBy),
        latest: this.workers.latest(),
      },
      viewedAt,
      this.lease.seconds,
      over,
    );
    return {
      ...view,
      preparedFollowUp: (await this.preparedFollowUps.findRunIdsAmong([refreshed.id])).has(
        refreshed.id,
      ),
    };
  }
}
