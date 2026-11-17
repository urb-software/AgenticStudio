import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type RunSnapshot } from '../../../domain/value-objects/run-snapshot.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface AnswerRunInput {
  runId: string;
  /** The operator's text: stored as given (the endpoint trims and bounds it). */
  text: string;
}

export interface AnswerRunResult {
  /** The Run as it is now, queued again. */
  run: RunSnapshot;
  /** Whether a prepared Follow-up waits for the operator (the Run page shows it). */
  preparedFollowUp: boolean;
}

/**
 * Command (Issue #103): the operator answers the agent's open question. The answer is stored
 * after the question and the Run goes back to `queued`; the agent worker that holds its Working
 * copy then claims it and resumes the same agent session with the answer as the next Run step.
 * Only a `waiting_for_operator` Run with an open question takes an answer: the Run's `answer`
 * method decides that under the row lock the repository's `change` takes, so a second answer, or
 * one after a cancel, is refused. The answer is the operator's input: stored as given (the
 * endpoint trims and bounds it). Throws `RunNotFoundError` or `RunNotWaitingError`.
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
