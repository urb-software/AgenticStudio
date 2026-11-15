import { Inject, Injectable } from '@nestjs/common';
import { isRunId, type RunWorkingCopy } from '../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  RunNotHeldError,
  type RunRepository,
  type RunStepRecord,
  StepLimitReachedError,
} from '../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface ReportRunStepInput extends RunStepRecord {
  runId: string;
  workerId: string;
  /** The Working copy's state after the step (Issue #98). */
  workingCopy: RunWorkingCopy;
}

/**
 * Command (Issue #96): the agent worker holding a `running` Run reports the structured result
 * of a Run step; it is stored (internal for now), and the Working copy's state it reports
 * becomes the Run's latest (Issue #98). A step beyond the Run's maximum is refused and the
 * Run fails with `step_limit` (Issue #100). Returns the step's number. Throws
 * {@link RunNotFoundError}, {@link RunNotHeldError} (not running, or not held by it) or
 * {@link StepLimitReachedError}.
 */
@Injectable()
export class ReportRunStepHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: ReportRunStepInput): Promise<number> {
    if (!isRunId(input.runId) || !(await this.runs.findById(input.runId))) {
      throw new RunNotFoundError();
    }
    const outcome = await this.runs.appendStep(
      input.runId,
      input.workerId,
      { kind: input.kind, result: input.result },
      input.workingCopy,
      this.clock.now(),
    );
    if (outcome.status === 'not_held') throw new RunNotHeldError();
    if (outcome.status === 'step_limit') throw new StepLimitReachedError();
    return outcome.index;
  }
}
