import { Inject, Injectable } from '@nestjs/common';
import {
  canRetryDelivery,
  DeliveryNotRetryableError,
  isRunId,
  type Run,
} from '../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';

/**
 * Command (Issue #102): the operator asks to repeat only the delivery of a Run whose delivery
 * failed, without running the agent again. The Run stays `failed` and is marked for a retry;
 * the next claim hands it to an agent worker as a delivery. Repeating the request while the
 * retry is pending changes nothing. Throws {@link RunNotFoundError} or
 * {@link DeliveryNotRetryableError}.
 */
@Injectable()
export class RetryDeliveryHandler {
  constructor(@Inject(RUN_REPOSITORY) private readonly runs: RunRepository) {}

  async execute(runId: string): Promise<Run> {
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    if (!canRetryDelivery(run)) throw new DeliveryNotRetryableError();
    const requested = await this.runs.requestDeliveryRetry(run.id);
    // The Run changed between the read and the write.
    if (!requested) throw new DeliveryNotRetryableError();
    return requested;
  }
}
