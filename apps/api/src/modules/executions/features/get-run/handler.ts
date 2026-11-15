import { Inject, Injectable } from '@nestjs/common';
import { isRunId, type Run } from '../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';

/** Query (Issue #96): one Run. Throws {@link RunNotFoundError}, also for an id that is not a UUID. */
@Injectable()
export class GetRunHandler {
  constructor(@Inject(RUN_REPOSITORY) private readonly runs: RunRepository) {}

  async execute(runId: string): Promise<Run> {
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    return run;
  }
}
