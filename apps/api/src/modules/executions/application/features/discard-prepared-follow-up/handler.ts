import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/entities/run.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RunNotFoundError } from '../../../domain/repositories/run-repository.js';

/**
 * Command (Issue #145): the operator discards the Follow-up prepared from the Run's failing
 * checks without sending it. Discarding what is not there is fine. Throws
 * {@link RunNotFoundError} for an id that is not a UUID.
 */
@Injectable()
export class DiscardPreparedFollowUpHandler {
  constructor(
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY) private readonly prepared: PreparedFollowUpRepository,
  ) {}

  async execute(runId: string): Promise<void> {
    if (!isRunId(runId)) throw new RunNotFoundError();
    await this.prepared.discard(runId);
  }
}
