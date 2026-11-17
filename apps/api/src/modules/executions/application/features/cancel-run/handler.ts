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

export interface CancelRunInput {
  runId: string;
}

export interface CancelRunResult {
  /** The Run as it is now: cancelled, or with its cancel request. */
  run: RunSnapshot;
  /** Whether a prepared Follow-up waits for the operator (the Run page shows it). */
  preparedFollowUp: boolean;
}

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
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY)
    private readonly preparedFollowUps: PreparedFollowUpRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: CancelRunInput): Promise<CancelRunResult> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    const now = this.clock.now();
    const cancelled = await this.runs.change(input.runId, (run) => run.cancel(now));
    if (!cancelled) throw new RunNotFoundError();
    return {
      run: cancelled.snapshot(),
      preparedFollowUp: (await this.preparedFollowUps.findRunIdsAmong([cancelled.id])).has(
        cancelled.id,
      ),
    };
  }
}
