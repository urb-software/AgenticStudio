import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import type { PreparedFollowUpSnapshot } from '../../../domain/value-objects/prepared-follow-up-snapshot.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RunNotFoundError } from '../../../domain/value-objects/run-errors.js';

/** The Run has no prepared Follow-up (none asked for, or it was sent or discarded). */
export class PreparedFollowUpNotFoundError extends Error {
  constructor() {
    super('The run has no prepared Follow-up.');
    this.name = 'PreparedFollowUpNotFoundError';
  }
}

export interface GetPreparedFollowUpInput {
  runId: string;
}

export type GetPreparedFollowUpResult = PreparedFollowUpSnapshot;

/**
 * Query (Issue #145): the Follow-up Studio prepared from the Run's failing checks, for the
 * operator to review before anything is sent. Throws {@link RunNotFoundError} (also for an id
 * that is not a UUID) or {@link PreparedFollowUpNotFoundError}.
 */
@Injectable()
export class GetPreparedFollowUpHandler {
  constructor(
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY) private readonly prepared: PreparedFollowUpRepository,
  ) {}

  async execute(input: GetPreparedFollowUpInput): Promise<GetPreparedFollowUpResult> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    const draft = await this.prepared.find(input.runId);
    if (!draft) throw new PreparedFollowUpNotFoundError();
    return draft;
  }
}
