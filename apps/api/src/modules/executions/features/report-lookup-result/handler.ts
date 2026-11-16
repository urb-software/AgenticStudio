import { LOOKUP_ERROR_MAX_LENGTH, type LookupResultRequest } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { retryDelaySeconds } from '../../domain/entities/run-lookup.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../domain/repositories/run-lookup-repository.js';
import { redactLogText } from '../../domain/services/log-redaction.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

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
 * A result replaces what Studio knows of the Run's pull request; a failure keeps the last known
 * state and records why (the worker's words, redacted: never a token), and a rate limit puts the
 * lookup back in the queue for later. A repeated answer changes nothing. Throws
 * {@link LookupNotFoundError}, {@link LookupNotHeldError} or {@link LookupKindMismatchError}.
 */
@Injectable()
export class ReportLookupResultHandler {
  constructor(
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(lookupId: string, answer: LookupResultRequest): Promise<void> {
    const kind = await this.lookups.findKind(lookupId);
    if (kind === null) throw new LookupNotFoundError();
    const now = this.clock.now();
    if (answer.ok) {
      if (answer.kind !== kind) throw new LookupKindMismatchError();
      const { state, behindBy, aheadBy, mergeable } = answer.result;
      // A merged, closed or missing pull request has no branch position worth keeping.
      const outcome = await this.lookups.completePullRequestState(
        lookupId,
        answer.workerId,
        {
          state,
          ...(behindBy === undefined ? {} : { behindBy }),
          ...(aheadBy === undefined ? {} : { aheadBy }),
          ...(mergeable === undefined ? {} : { mergeable }),
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
