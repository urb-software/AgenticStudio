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

export interface AnswerRunInput {
  runId: string;
  text: string;
}

export interface AnswerRunResult {
  run: RunSnapshot;
  preparedFollowUp: boolean;
}

/**
 * The Run's `answer` decides under the row lock, so a second answer, or one after a cancel, is
 * refused. Throws `RunNotFoundError` or `RunNotWaitingError`.
 */
@Injectable()
export class AnswerRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY)
    private readonly preparedFollowUps: PreparedFollowUpRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: AnswerRunInput): Promise<AnswerRunResult> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    const now = this.clock.now();
    const answered = await this.runs.change(input.runId, (run) => run.answer(input.text, now));
    if (!answered) throw new RunNotFoundError();
    return {
      run: answered.snapshot(),
      preparedFollowUp: (await this.preparedFollowUps.findRunIdsAmong([answered.id])).has(
        answered.id,
      ),
    };
  }
}
