import { Inject, Injectable } from '@nestjs/common';
import { isRunId, type Run } from '../../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';

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
  constructor(@Inject(RUN_REPOSITORY) private readonly runs: RunRepository) {}

  async execute(runId: string): Promise<Run> {
    if (!isRunId(runId)) throw new RunNotFoundError();
    const requested = await this.runs.change(runId, (run) => run.requestDeliveryRetry());
    if (!requested) throw new RunNotFoundError();
    return requested;
  }
}
