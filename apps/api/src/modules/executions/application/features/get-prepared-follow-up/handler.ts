import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import type { FollowUpSource } from '../../../domain/value-objects/follow-up-source.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export class PreparedFollowUpNotFoundError extends Error {
  constructor() {
    super('The run has no prepared Follow-up.');
    this.name = 'PreparedFollowUpNotFoundError';
  }
}

export interface GetPreparedFollowUpInput {
  runId: string;
}

export interface GetPreparedFollowUpResult {
  source: FollowUpSource;
  text: string;
  items: { name: string; url: string; logAvailable: boolean; section: string }[];
}

/**
 * Throws {@link RunNotFoundError} (also for a non-UUID id) or
 * {@link PreparedFollowUpNotFoundError}.
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
    return {
      source: draft.source,
      text: draft.text,
      items: draft.items.map(({ name, url, logAvailable, section }) => ({
        name,
        url,
        logAvailable,
        section,
      })),
    };
  }
}
