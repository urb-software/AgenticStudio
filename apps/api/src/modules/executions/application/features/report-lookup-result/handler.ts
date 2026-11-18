import { LOOKUP_ERROR_MAX_LENGTH, type LookupResultRequest } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PreparedFollowUp } from '../../../domain/entities/prepared-follow-up.js';
import { ReviewComments } from '../../../domain/entities/review-comments.js';
import type { RunLookup } from '../../../domain/entities/run-lookup.js';
import type { PullRequestStateResult } from '../../../domain/value-objects/run-pull-request-status.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../../domain/repositories/run-lookup-repository.js';
import { CheckLink } from '../../../domain/value-objects/check-link.js';
import { LogRedaction } from '../../../domain/value-objects/log-redaction.js';
import {
  type LookupAnswerOutcome,
  LookupFailure,
} from '../../../domain/value-objects/run-lookup.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';
import {
  RUN_TRANSACTIONS,
  type RunTransactionRepositories,
  type RunTransactions,
} from '../../ports/run-transactions.js';

export class LookupNotFoundError extends Error {
  constructor() {
    super('The lookup does not exist.');
    this.name = 'LookupNotFoundError';
  }
}

export class LookupNotHeldError extends Error {
  constructor() {
    super('This agent worker does not hold the lookup.');
    this.name = 'LookupNotHeldError';
  }
}

export class LookupKindMismatchError extends Error {
  constructor() {
    super("The answer is not of the lookup's kind.");
    this.name = 'LookupKindMismatchError';
  }
}

export interface ReportLookupResultInput {
  lookupId: string;
  answer: LookupResultRequest;
}

export type ReportLookupResultResult = void;

/**
 * The answer changes the lookup and another aggregate in one transaction, the Run locked first.
 * Throws {@link LookupNotFoundError}, {@link LookupNotHeldError} or {@link LookupKindMismatchError}.
 */
@Injectable()
export class ReportLookupResultHandler {
  constructor(
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_SECRET_VALUES) private readonly secrets: RunSecretValues,
    @Inject(RUN_TRANSACTIONS) private readonly transactions: RunTransactions,
  ) {}

  async execute(input: ReportLookupResultInput): Promise<ReportLookupResultResult> {
    const { lookupId, answer } = input;
    const found = await this.lookups.findById(lookupId);
    if (found === null) throw new LookupNotFoundError();
    const { kind, runId } = found;
    const now = this.clock.now();
    if (!answer.ok) {
      await this.fail(runId, lookupId, answer, now);
      return;
    }
    if (answer.kind !== kind) throw new LookupKindMismatchError();
    // Text from CI jobs is redacted like the Run's log: with the Run's known secret values too.
    const redaction = LogRedaction.of(await this.secrets.forRun(runId));
    // A check's link that redaction would break is replaced by the pull request's checks page.
    const pull = (await this.runs.findById(runId))?.delivery.pullRequest;
    const fallbackUrl = pull ? `${pull.url}/checks` : 'https://github.com';
    if (answer.kind === 'review_comments') {
      // Untrusted text from the Git host: redacted and capped before it is stored.
      const clean = ReviewComments.sanitize(
        answer.result.comments,
        answer.result.truncated,
        redaction,
      );
      await this.answer(runId, lookupId, async (lookup, repositories) => {
        // The comments are kept in the Run's set only, not twice.
        const outcome = lookup.complete(
          answer.workerId,
          { comments: clean.comments.length, truncated: clean.truncated },
          now,
        );
        if (outcome !== 'stored') return outcome;
        if (lookup.scope === null) {
          throw new Error('Unexpected review comment scope in the database: null');
        }
        await repositories.lookups.save(lookup);
        await repositories.reviewComments.replace(
          runId,
          ReviewComments.load({
            scope: lookup.scope,
            comments: clean.comments,
            truncated: clean.truncated,
            loadedAt: now,
          }),
        );
        return outcome;
      });
      return;
    }
    if (answer.kind === 'failing_check_logs') {
      const draft = PreparedFollowUp.fromFailingChecks(answer.result, redaction, fallbackUrl);
      await this.answer(runId, lookupId, async (lookup, repositories) => {
        // The text is kept in the prepared Follow-up only, not twice.
        const outcome = lookup.complete(answer.workerId, { items: draft.items.length }, now);
        if (outcome !== 'stored') return outcome;
        await repositories.lookups.save(lookup);
        await repositories.preparedFollowUps.replace(runId, draft, now);
        const run = await repositories.runs.findById(runId);
        if (run) {
          run.recordPreparationDone();
          await repositories.runs.save(run);
        }
        return outcome;
      });
      return;
    }
    const { state, behindBy, aheadBy, mergeable, checksCommit, checks, checksUnavailable } =
      answer.result;
    // The answer's own fields are what is kept: a merged or missing pull request has no branch
    // position, a closed one no merge verdict, and only an open one has checks.
    const result: PullRequestStateResult = {
      state,
      ...(behindBy === undefined ? {} : { behindBy }),
      ...(aheadBy === undefined ? {} : { aheadBy }),
      ...(mergeable === undefined ? {} : { mergeable }),
      ...(checksCommit === undefined ? {} : { checksCommit }),
      ...(checks === undefined
        ? {}
        : {
            // Names and links come from CI jobs: masked like any log text.
            checks: checks.map((check) => ({
              ...check,
              name: redaction.text(check.name),
              url: CheckLink.of(check.url).safe(redaction, fallbackUrl),
            })),
          }),
      ...(checksUnavailable === undefined ? {} : { checksUnavailable }),
    };
    await this.answer(runId, lookupId, async (lookup, repositories) => {
      const outcome = lookup.complete(answer.workerId, result, now);
      if (outcome !== 'stored') return outcome;
      await repositories.lookups.save(lookup);
      const run = await repositories.runs.findById(runId);
      if (run) {
        run.recordPullRequestState(result, now);
        await repositories.runs.save(run);
      }
      return outcome;
    });
  }

  private async fail(
    runId: string,
    lookupId: string,
    answer: Extract<LookupResultRequest, { ok: false }>,
    now: Date,
  ): Promise<void> {
    const error = LogRedaction.NONE.text(answer.error).slice(0, LOOKUP_ERROR_MAX_LENGTH);
    const retry = LookupFailure.of({
      code: answer.code,
      error,
      retryAfterSeconds: answer.retryAfterSeconds,
    }).retryDelaySeconds;
    await this.answer(runId, lookupId, async (lookup, repositories) => {
      const outcome = lookup.fail(answer.workerId, error, retry, now);
      if (outcome !== 'stored') return outcome;
      await repositories.lookups.save(lookup);
      const run = await repositories.runs.findById(runId);
      if (run) {
        // A retry keeps the Run refreshing or preparing until it; reading Review comments marks
        // no Run column.
        if (lookup.kind === 'failing_check_logs') {
          run.recordPreparationFailed(error, lookup.retryAt, lookup.requestedAt);
        } else if (lookup.kind === 'pull_request_state') {
          run.recordRefreshFailed(error, lookup.retryAt, lookup.requestedAt);
        }
        await repositories.runs.save(run);
      }
      return outcome;
    });
  }

  /** The Run is locked first, then the lookup, read again under the lock. */
  private async answer(
    runId: string,
    lookupId: string,
    work: (
      lookup: RunLookup,
      repositories: RunTransactionRepositories,
    ) => Promise<LookupAnswerOutcome>,
  ): Promise<void> {
    const outcome = await this.transactions.withRunLocked(runId, async (repositories) => {
      // Read under the row lock too: a claim does not take the Run's lock, so a lookup re-claimed
      // meanwhile is seen as it is, not overwritten.
      const lookup = await repositories.lookups.findByIdForUpdate(lookupId);
      return lookup === null ? 'not_held' : work(lookup, repositories);
    });
    if (outcome === 'not_held') throw new LookupNotHeldError();
  }
}
