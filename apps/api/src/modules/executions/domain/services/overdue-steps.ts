import { STEP_TIME_LIMIT_GRACE_MINUTES } from '../entities/run.js';
import type { RunRepository } from '../repositories/run-repository.js';

/**
 * Studio's backstop for the step time limit (review of #121), the one place it is written: a
 * `running` Run whose current step has run longer than its `stepMinutes` plus
 * {@link STEP_TIME_LIMIT_GRACE_MINUTES} → `timed_out`. The agent worker stays the primary
 * enforcer (it stops the step at `stepMinutes`); this ends the Run when a live worker failed to.
 * The interval sweep and every claim use it. Returns how many Runs timed out.
 */
export function timeOutOverdueSteps(runs: RunRepository, now: Date): Promise<number> {
  return runs.timeOutOverdueSteps(now, STEP_TIME_LIMIT_GRACE_MINUTES);
}
