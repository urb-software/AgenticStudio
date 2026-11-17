import { Inject, Injectable } from '@nestjs/common';
import { STEP_TIME_LIMIT_GRACE_MINUTES } from '../../../domain/entities/run.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

/**
 * Command (review of #121): Studio's backstop for the step time limit. A `running` Run whose
 * current step has run longer than its `stepMinutes` plus {@link STEP_TIME_LIMIT_GRACE_MINUTES}
 * is `timed_out`. The agent worker stays the primary enforcer (it stops the step at
 * `stepMinutes`); this ends the Run when a live worker failed to. Run on the sweep interval
 * (`claim-run` repeats the same call before every claim). Returns how many Runs timed out.
 */
@Injectable()
export class TimeOutOverdueStepsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  execute(): Promise<number> {
    return this.runs.timeOutOverdueSteps(this.clock.now(), STEP_TIME_LIMIT_GRACE_MINUTES);
  }
}
