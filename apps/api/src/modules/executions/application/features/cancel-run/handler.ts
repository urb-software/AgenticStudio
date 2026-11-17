import { Inject, Injectable } from '@nestjs/common';
import {
  isFinal,
  isRunId,
  OPERATOR_CANCELLATION,
  type Run,
  RunAlreadyFinishedError,
} from '../../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

/** A Run that changes state between the read and the write is read again, this many times. */
const MAX_ATTEMPTS = 5;

/**
 * Command (Issue #100): the operator cancels a Run. A `queued` or `waiting_for_operator` Run
 * (no worker holds it) is `cancelled` at once. A `preparing` or `running` Run gets a cancel
 * request; its state stays until the agent worker, told with its next heartbeat, has stopped
 * the Run step and reports `cancelled`. Repeating a cancel changes nothing and succeeds.
 * Throws {@link RunNotFoundError} or {@link RunAlreadyFinishedError}.
 */
@Injectable()
export class CancelRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(runId: string): Promise<Run> {
    if (!isRunId(runId)) throw new RunNotFoundError();
    for (let attempt = 1; ; attempt++) {
      const run = await this.runs.findById(runId);
      if (!run) throw new RunNotFoundError();
      if (isFinal(run.state)) throw new RunAlreadyFinishedError(run.state);
      const now = this.clock.now();
      const changed =
        run.state === 'queued' || run.state === 'waiting_for_operator'
          ? await this.runs.cancelUnheld(run.id, run.state, OPERATOR_CANCELLATION, now)
          : await this.runs.requestCancel(run.id, now);
      if (changed) return changed;
      // The Run moved on in between (claimed, released, finished): decide again.
      if (attempt === MAX_ATTEMPTS) throw new Error(`Run ${run.id} kept changing while cancelled.`);
    }
  }
}
