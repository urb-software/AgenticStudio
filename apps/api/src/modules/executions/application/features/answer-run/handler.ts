import { Inject, Injectable } from '@nestjs/common';
import { isRunId, type Run, RunNotWaitingError } from '../../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

/**
 * Command (Issue #103): the operator answers the agent's open question. The answer is stored
 * after the question and the Run goes back to `queued`; the agent worker that holds its Working
 * copy then claims it and resumes the same agent session with the answer as the next Run step.
 * Only a `waiting_for_operator` Run with an open question takes an answer: a second answer, or
 * one after a cancel, is refused. The answer is the operator's input: stored as given (the
 * endpoint trims and bounds it). Throws {@link RunNotFoundError} or {@link RunNotWaitingError}.
 */
@Injectable()
export class AnswerRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(runId: string, text: string): Promise<Run> {
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    const answered = await this.runs.answer(run.id, text, this.clock.now());
    if (answered) return answered;
    // Not waiting (any more): the store decided; report the state it is in now.
    const now = await this.runs.findById(run.id);
    throw new RunNotWaitingError(now?.state ?? run.state);
  }
}
