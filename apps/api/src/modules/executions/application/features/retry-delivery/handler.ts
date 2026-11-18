import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export interface RetryDeliveryInput {
  runId: string;
}

/**
 * The Run's `requestDeliveryRetry` decides, under the row lock the repository's `change` takes.
 * Throws `RunNotFoundError` or `DeliveryNotRetryableError`.
 */
@Injectable()
export class RetryDeliveryHandler {
  constructor(@Inject(RUN_REPOSITORY) private readonly runs: RunRepository) {}

  async execute(input: RetryDeliveryInput): Promise<void> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    const requested = await this.runs.change(input.runId, (run) => run.requestDeliveryRetry());
    if (!requested) throw new RunNotFoundError();
  }
}
