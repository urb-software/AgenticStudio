import { Inject, Injectable } from '@nestjs/common';
import { isRunId, type Run } from '../../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

/**
 * Command (Issue #100): the operator cancels a Run. A `queued` or `waiting_for_operator` Run
 * (no worker holds it) is `cancelled` at once. A `preparing` or `running` Run gets a cancel
 * request; its state stays until the agent worker, told with its next heartbeat, has stopped
 * the Run step and reports `cancelled`. Repeating a cancel changes nothing and succeeds. The
 * Run's `cancel` method decides which, under the row lock the repository's `change` takes, so
 * a Run that is claimed or finished in between is decided on as it is. Throws
 * `RunNotFoundError` or `RunAlreadyFinishedError`.
 */
@Injectable()
export class CancelRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(runId: string): Promise<Run> {
    if (!isRunId(runId)) throw new RunNotFoundError();
    const cancelled = await this.runs.change(runId, (run) => run.cancel(this.clock.now()));
    if (!cancelled) throw new RunNotFoundError();
    return cancelled;
  }
}
