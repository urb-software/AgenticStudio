import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface StopAtCheckpointInput {
  runId: string;
  /** The Checkpoint the operator saw; a request for another one is refused. */
  checkpoint?: string;
}

/**
 * Ends the Workflow at the Checkpoint: the Run delivers what exists, once, or finishes without a
 * pull request when nothing changed. Refused under the row lock like a second Continue. Throws
 * `RunNotFoundError` or `RunNotAtCheckpointError`.
 */
@Injectable()
export class StopAtCheckpointHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: StopAtCheckpointInput): Promise<void> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    const now = this.clock.now();
    const changed = await this.runs.change(input.runId, (run) => {
      run.assertAtCheckpoint(input.checkpoint);
      run.stopAtCheckpoint(now);
    });
    if (!changed) throw new RunNotFoundError();
  }
}
