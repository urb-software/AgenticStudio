import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type RunSnapshot } from '../../../domain/entities/run-snapshot.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export interface CancelRunInput {
  runId: string;
}

export interface CancelRunResult {
  run: RunSnapshot;
  preparedFollowUp: boolean;
}

/**
 * Repeating a cancel succeeds. The Run's `cancel` decides under the row lock, so a Run claimed or
 * finished in between is decided on as it is. Throws `RunNotFoundError` or `RunAlreadyFinishedError`.
 */
@Injectable()
export class CancelRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY)
    private readonly preparedFollowUps: PreparedFollowUpRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: CancelRunInput): Promise<CancelRunResult> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    const now = this.clock.now();
    const cancelled = await this.runs.change(input.runId, (run) => run.cancel(now));
    if (!cancelled) throw new RunNotFoundError();
    return {
      run: cancelled.snapshot(),
      preparedFollowUp: (await this.preparedFollowUps.findRunIdsAmong([cancelled.id])).has(
        cancelled.id,
      ),
    };
  }
}
