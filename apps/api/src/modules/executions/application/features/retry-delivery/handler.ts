import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type RunSnapshot } from '../../../domain/entities/run.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';

export interface RetryDeliveryInput {
  runId: string;
}

export interface RetryDeliveryResult {
  /** The Run as it is now, marked for the retry. */
  run: RunSnapshot;
  /** Whether a prepared Follow-up waits for the operator (the Run page shows it). */
  preparedFollowUp: boolean;
}

/**
 * Command (Issue #102): the operator asks to repeat only the delivery of a Run whose delivery
 * failed, without running the agent again. The Run stays `failed` and is marked for a retry;
 * the next claim hands it to an agent worker as a delivery. Repeating the request while the
 * retry is pending changes nothing. The Run's `requestDeliveryRetry` method decides, under the
 * row lock the repository's `change` takes. Throws `RunNotFoundError` or
 * `DeliveryNotRetryableError`.
 */
@Injectable()
export class RetryDeliveryHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY)
    private readonly preparedFollowUps: PreparedFollowUpRepository,
  ) {}

  async execute(input: RetryDeliveryInput): Promise<RetryDeliveryResult> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    const requested = await this.runs.change(input.runId, (run) => run.requestDeliveryRetry());
    if (!requested) throw new RunNotFoundError();
    return {
      run: requested.snapshot(),
      preparedFollowUp: (await this.preparedFollowUps.findRunIdsAmong([requested.id])).has(
        requested.id,
      ),
    };
  }
}
