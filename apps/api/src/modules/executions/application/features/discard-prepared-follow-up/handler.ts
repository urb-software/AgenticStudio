import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export interface DiscardPreparedFollowUpInput {
  runId: string;
}

export type DiscardPreparedFollowUpResult = void;

/** Discarding what is not there succeeds. Throws {@link RunNotFoundError} for a non-UUID id. */
@Injectable()
export class DiscardPreparedFollowUpHandler {
  constructor(
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY) private readonly prepared: PreparedFollowUpRepository,
  ) {}

  async execute(input: DiscardPreparedFollowUpInput): Promise<DiscardPreparedFollowUpResult> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    await this.prepared.discard(input.runId);
  }
}
