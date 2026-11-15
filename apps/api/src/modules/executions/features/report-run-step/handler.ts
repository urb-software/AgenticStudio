import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  RunNotHeldError,
  type RunRepository,
  type RunStepRecord,
} from '../../domain/repositories/run-repository.js';

export interface ReportRunStepInput extends RunStepRecord {
  runId: string;
  workerId: string;
}

/**
 * Command (Issue #96): the agent worker holding a `running` Run reports the structured result
 * of a Run step; it is stored (internal for now). Returns the step's number. Throws
 * {@link RunNotFoundError} or {@link RunNotHeldError} (not running, or not held by it).
 */
@Injectable()
export class ReportRunStepHandler {
  constructor(@Inject(RUN_REPOSITORY) private readonly runs: RunRepository) {}

  async execute(input: ReportRunStepInput): Promise<number> {
    if (!isRunId(input.runId) || !(await this.runs.findById(input.runId))) {
      throw new RunNotFoundError();
    }
    const index = await this.runs.appendStep(input.runId, input.workerId, {
      kind: input.kind,
      result: input.result,
    });
    if (index === null) throw new RunNotHeldError();
    return index;
  }
}
