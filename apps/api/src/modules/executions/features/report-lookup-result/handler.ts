import { LOOKUP_ERROR_MAX_LENGTH, type LookupResultRequest } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { retryDelaySeconds } from '../../domain/entities/run-lookup.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../domain/repositories/run-lookup-repository.js';
import { prepareFailingChecksDraft } from '../../domain/services/failing-checks-draft.js';
import { redactLogText } from '../../domain/services/log-redaction.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';

/** The lookup does not exist. */
export class LookupNotFoundError extends Error {
  constructor() {
    super('The lookup does not exist.');
    this.name = 'LookupNotFoundError';
  }
}

/** The answering worker does not hold the lookup. */
export class LookupNotHeldError extends Error {
  constructor() {
    super('This agent worker does not hold the lookup.');
    this.name = 'LookupNotHeldError';
  }
}

/** The answer is of another kind than the lookup. */
export class LookupKindMismatchError extends Error {
  constructor() {
    super("The answer is not of the lookup's kind.");
    this.name = 'LookupKindMismatchError';
  }
}

/**
 * Command (Issue #142): the agent worker holding a lookup reports its result, or why it failed.
 * A result replaces what Studio knows of the Run's pull request (Issue #145: with its Pull
 * request checks) or, for the logs of failing checks, becomes the Run's prepared Follow-up for the
 * operator to review, never sent by itself; a failure keeps the last known state and records why
 * (the worker's words, redacted: never a token), and a rate limit puts the lookup back in the
 * queue for later. A repeated answer changes nothing. Throws
 * {@link LookupNotFoundError}, {@link LookupNotHeldError} or {@link LookupKindMismatchError}.
 */
@Injectable()
export class ReportLookupResultHandler {
  constructor(
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RUN_SECRET_VALUES) private readonly secrets: RunSecretValues,
  ) {}

  async execute(lookupId: string, answer: LookupResultRequest): Promise<void> {
    const found = await this.lookups.findRef(lookupId);
    if (found === null) throw new LookupNotFoundError();
    const { kind } = found;
    const now = this.clock.now();
    if (answer.ok) {
      if (answer.kind !== kind) throw new LookupKindMismatchError();
      // Text from CI jobs is redacted like the Run's log: with the Run's known secret values too.
      const known = await this.secrets.forRun(found.runId);
      if (answer.kind === 'failing_check_logs') {
        const stored = await this.lookups.completeFailingCheckLogs(
          lookupId,
          answer.workerId,
          prepareFailingChecksDraft(answer.result, known),
          now,
        );
        if (stored === 'not_held') throw new LookupNotHeldError();
        return;
      }
      const { state, behindBy, aheadBy, mergeable, checksCommit, checks, checksUnavailable } =
        answer.result;
      // The answer's own fields are what is kept: a merged or missing pull request has no branch
      // position, a closed one no merge verdict, and only an open one has checks.
      const outcome = await this.lookups.completePullRequestState(
        lookupId,
        answer.workerId,
        {
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
                  name: redactLogText(check.name, known),
                  url: redactLogText(check.url, known),
                })),
              }),
          ...(checksUnavailable === undefined ? {} : { checksUnavailable }),
        },
        now,
      );
      if (outcome === 'not_held') throw new LookupNotHeldError();
      return;
    }
    const error = redactLogText(answer.error, []).slice(0, LOOKUP_ERROR_MAX_LENGTH);
    const retry = retryDelaySeconds({
      code: answer.code,
      error,
      ...(answer.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: answer.retryAfterSeconds }),
    });
    const outcome = await this.lookups.fail(lookupId, answer.workerId, error, retry, now);
    if (outcome === 'not_held') throw new LookupNotHeldError();
  }
}
