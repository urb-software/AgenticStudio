import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  RunNotHeldError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

/**
 * Command (Issue #96): the agent worker holding a Run says it is still alive, which renews
 * its lease. The answer tells it whether the operator asked to cancel the Run (Issue #100).
 * Throws {@link RunNotFoundError} or {@link RunNotHeldError}.
 */
@Injectable()
export class RecordHeartbeatHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: { runId: string; workerId: string }): Promise<{ cancelRequested: boolean }> {
    if (!isRunId(input.runId) || !(await this.runs.findById(input.runId))) {
      throw new RunNotFoundError();
    }
    const answer = await this.runs.heartbeat(input.runId, input.workerId, this.clock.now());
    if (!answer) throw new RunNotHeldError();
    return answer;
  }
}
