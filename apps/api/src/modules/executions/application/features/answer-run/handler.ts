import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export interface AnswerRunInput {
  runId: string;
  text: string;
}

/**
 * The Run's `answer` decides under the row lock, so a second answer, or one after a cancel, is
 * refused. Throws `RunNotFoundError` or `RunNotWaitingError`.
 */
@Injectable()
export class AnswerRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: AnswerRunInput): Promise<void> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    const now = this.clock.now();
    const answered = await this.runs.change(input.runId, (run) => run.answer(input.text, now));
    if (!answered) throw new RunNotFoundError();
  }
}
