import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type FollowUpOrigin,
  type FollowUpSource,
  isRunId,
  type Run,
} from '../../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../../domain/repositories/run-lookup-repository.js';
import type { FollowUpView } from '../../../domain/value-objects/retention-policy.js';
import { WorkerStatus } from '../../../domain/value-objects/worker-status.js';
import { redactSecrets } from '../../../../../platform/http/redact.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RETENTION_POLICY, type RetentionPolicy } from '../../ports/retention-policy.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

/**
 * Command (Issue #141): the operator sends a Follow-up to a finished Run. When the Run can take
 * one (its `followUp` method decides, with what the handler knows of the agent worker), the text
 * is stored in its conversation and the Run goes back to `queued`; the agent worker that holds
 * its Working copy then claims it, under the concurrency limits, and resumes the same agent
 * session with the Follow-up as the next Run step. The method runs under the row lock the
 * repository's `changeWithReviewComments` takes, so a second submission is refused.
 * The text is the operator's input: stored as given (the endpoint trims and bounds it), with its
 * `source` when it was prepared from failing checks (Issue #145: the prepared draft is then
 * removed in the same step). Issue #147: the source `bring_up_to_date` marks a request to bring
 * the Run branch up to date, which is a Follow-up in every other respect (its text is the
 * operator's note, possibly empty). Returns the queued Run and its eligibility now. Issue #146: a
 * Follow-up from `review_comments` names the selected comments, which must all be in the Run's
 * loaded set (its text is the operator's); the Follow-up records how many there are and their
 * authors, and the loaded set is removed with it. Throws `RunNotFoundError`,
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
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
    @Inject(RETENTION_POLICY) private readonly retention: RetentionPolicy,
  ) {}

  async execute(
    runId: string,
    text: string,
    source?: FollowUpSource,
    reviewCommentIds: readonly string[] = [],
  ): Promise<{ run: Run; followUp: FollowUpView; workerConnected: boolean }> {
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    const now = this.clock.now();
    const facts = run.followUpFacts(
      {
        holderLastSeen:
          run.lastClaimedBy === null ? undefined : this.workers.lastSeen(run.lastClaimedBy),
        latest: this.workers.latest(),
      },
      now,
      this.lease.seconds,
    );
    // Issue #146: the selected comments are checked against the loaded set under the lock.
    const origin: FollowUpOrigin | undefined =
      source === 'review_comments' ? { source, commentIds: reviewCommentIds } : source;
    const queued = await this.runs.changeWithReviewComments(run.id, (locked, loaded) =>
      locked.followUp(text, now, facts, origin, loaded),
    );
    if (!queued) throw new RunNotFoundError();
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
    const retention = refreshed.retentionFacts();
    const over =
      this.retention.isLimited(retention) &&
      this.retention
        .overLimit(await this.runs.findLimitedRuns([refreshed.projectId]))
        .has(refreshed.id);
    const latest = this.workers.latest();
    const eligibility = refreshed.followUpAvailability(
      {
        holderLastSeen:
          refreshed.lastClaimedBy === null
            ? undefined
            : this.workers.lastSeen(refreshed.lastClaimedBy),
        latest,
      },
      viewedAt,
      this.lease.seconds,
    );
    return {
      run: refreshed,
      followUp: this.retention.followUpView(eligibility, retention, over, viewedAt),
      workerConnected: WorkerStatus.isAnyConnected(latest, viewedAt, this.lease.seconds),
    };
  }
}
