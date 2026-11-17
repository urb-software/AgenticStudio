import { Inject, Injectable } from '@nestjs/common';
import { longWaitCancellation } from '../../../domain/entities/run.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

/**
 * Command (Issue #100): every Run left waiting for the operator longer than its own
 * `waitingDays` → `cancelled` by the system, with that stated as the reason. Time spent
 * waiting never counts against the Run step limit; this is its own limit. Run on the sweep
 * interval with the lost-worker sweep, and before every claim (`claim-run`). Returns how many
 * Runs were cancelled.
 */
@Injectable()
export class CancelLongWaitingRunsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<number> {
    const now = this.clock.now();
    let cancelled = 0;
    for (const run of await this.runs.listWaiting()) {
      const cancellation = longWaitCancellation(run, now);
      if (!cancellation) continue;
      // Conditional: an answer or an operator's cancel in between wins.
      if (await this.runs.cancelUnheld(run.id, 'waiting_for_operator', cancellation, now)) {
        cancelled++;
      }
    }
    return cancelled;
  }
}
