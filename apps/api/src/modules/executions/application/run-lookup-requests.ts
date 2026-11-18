import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RunLookup } from '../domain/entities/run-lookup.js';
import type { ReviewCommentsRequest } from '../domain/value-objects/review-comments-request.js';
import { type LookupKind } from '../domain/value-objects/lookup-kind.js';
import { type LookupRequestOutcome } from '../domain/value-objects/lookup-request-outcome.js';
import { RUN_TRANSACTIONS, type RunTransactions } from './ports/run-transactions.js';
import { RunNotFoundError } from '../domain/errors/run-errors.js';

/** The Run is locked first, so two requests at once record one lookup. */
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
        if (!run || !run.canRefreshPullRequest()) return 'not_possible';
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
        // Failing-check logs and Review comments do not mark the Run as refreshing.
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
