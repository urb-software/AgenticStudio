import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { WORKFLOW_PLANS, type WorkflowPlans } from '../../../contracts/index.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface ContinueFromCheckpointInput {
  runId: string;
  /** The operator's note for the next Phase, untrusted text; at most 4,000 characters. */
  comment?: string;
  /** The Checkpoint the operator saw; a request for another one is refused. */
  checkpoint?: string;
}

/**
 * The Run decides under the row lock, so a second Continue, or one after a cancel, is refused and
 * starts nothing. The Workflow decides what follows the Checkpoint. Throws `RunNotFoundError` or
 * `RunNotAtCheckpointError`.
 */
@Injectable()
export class ContinueFromCheckpointHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKFLOW_PLANS) private readonly plans: WorkflowPlans,
  ) {}

  async execute(input: ContinueFromCheckpointInput): Promise<void> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    const now = this.clock.now();
    const changed = await this.runs.change(input.runId, (run) => {
      run.assertAtCheckpoint(input.checkpoint);
      const next = this.plans.afterCheckpoint(run.workflow!.toData(), run.checkpointItem!);
      run.continueFromCheckpoint(next, input.comment, now);
    });
    if (!changed) throw new RunNotFoundError();
  }
}
