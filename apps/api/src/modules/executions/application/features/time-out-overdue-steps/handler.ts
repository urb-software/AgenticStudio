import { Inject, Injectable } from '@nestjs/common';
import { OverdueStepRule } from '../../../domain/value-objects/overdue-step-rule.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface TimeOutOverdueStepsResult {
  timedOut: number;
}

/**
 * Backstop: the agent worker is the primary enforcer of the step limit; this ends the Run when a
 * live worker failed to.
 */
@Injectable()
export class TimeOutOverdueStepsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<TimeOutOverdueStepsResult> {
    const rule = OverdueStepRule.at(this.clock.now());
    return { timedOut: await this.runs.timeOutOverdueSteps(rule.now, rule.graceMinutes) };
  }
}
