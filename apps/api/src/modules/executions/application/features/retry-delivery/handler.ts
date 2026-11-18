import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type RunSnapshot } from '../../../domain/entities/run-snapshot.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export interface RetryDeliveryInput {
  runId: string;
}

export interface RetryDeliveryResult {
  run: RunSnapshot;
  preparedFollowUp: boolean;
}

/**
 * The Run's `requestDeliveryRetry` decides, under the row lock the repository's `change` takes.
 * Throws `RunNotFoundError` or `DeliveryNotRetryableError`.
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
