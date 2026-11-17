import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RunLookup } from '../domain/entities/run-lookup.js';
import { RunNotFoundError } from '../domain/repositories/run-repository.js';
import type { ReviewCommentsRequest } from '../domain/value-objects/review-comments.js';
import {
  canRefreshPullRequest,
  type LookupKind,
  type LookupRequestOutcome,
} from '../domain/value-objects/run-lookup.js';
import { RUN_TRANSACTIONS, type RunTransactions } from './ports/run-transactions.js';

/**
 * Requesting a lookup (Issues #142, #145, #146), for the five entry points that need one (the
 * Run page's refresh, the preparation of failing checks, the load of Review comments, the
 * Follow-up's own refresh and the daily refresh). It is a collaborator because none of the
 * simpler homes fits (backend.md §3 rule 3): the steps are one transaction across two aggregates,
 * the Run and the lookup, so they cannot sit on either, the answer is needed at once (no job), and
 * the use cases that need it do not share their other steps.
 *
 * In one transaction the Run is locked first, so two requests at once record one: the Run must
 * have a pull request and a Run branch ({@link canRefreshPullRequest}), no lookup of the kind may
 * be open, and then the lookup is stored and the Run marked as refreshing or preparing as its own
 * method says. Orchestration only: every rule is the Run's or the lookup's.
 */
@Injectable()
export class RunLookupRequests {
  constructor(@Inject(RUN_TRANSACTIONS) private readonly transactions: RunTransactions) {}

  async request(
    runId: string,
    kind: LookupKind,
    now: Date,
    review?: ReviewCommentsRequest,
  ): Promise<LookupRequestOutcome> {
    try {
      return await this.transactions.withRunLocked(runId, async ({ runs, lookups }) => {
        const run = await runs.findById(runId);
        if (!run || !canRefreshPullRequest(run)) return 'not_possible';
        if ((await lookups.findOpen(runId, kind)) !== null) return 'open';
        await lookups.add(
          RunLookup.request({
            id: randomUUID(),
            runId,
            kind,
            now,
            ...(review === undefined ? {} : { review }),
          }),
        );
        // Issue #145: the logs of failing checks are not a refresh of the state; Issue #146: a load
        // of Review comments marks nothing on the Run (its state is read from the lookups).
        if (kind === 'pull_request_state') run.recordRefreshRequested(now);
        else if (kind === 'failing_check_logs') run.recordPreparationRequested(now);
        await runs.save(run);
        return 'requested';
      });
    } catch (error) {
      // An unknown Run has no pull request to look up.
      if (error instanceof RunNotFoundError) return 'not_possible';
      throw error;
    }
  }
}
