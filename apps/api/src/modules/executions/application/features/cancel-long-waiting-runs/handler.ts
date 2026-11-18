import { Inject, Injectable } from '@nestjs/common';
import { LongWaitRule } from '../../../domain/value-objects/long-wait-rule.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface CancelLongWaitingRunsResult {
  cancelled: number;
}

@Injectable()
export class CancelLongWaitingRunsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<CancelLongWaitingRunsResult> {
    const now = this.clock.now();
    const rule = LongWaitRule.at(now);
    let cancelled = 0;
    for (const run of await this.runs.listWaiting()) {
      const cancellation = rule.cancellationFor(run);
      if (!cancellation) continue;
      // Conditional: an answer or an operator's cancel in between wins.
      if (await this.runs.cancelUnheld(run.id, 'waiting_for_operator', cancellation, now)) {
        cancelled++;
      }
    }
    return { cancelled };
  }
}
