import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface RecordHeartbeatInput {
  runId: string;
  workerId: string;
}

export interface RecordHeartbeatResult {
  /** Whether the operator asked to cancel the Run (Issue #100). */
  cancelRequested: boolean;
}

/**
 * Command (Issue #96): the agent worker holding a Run says it is still alive, which renews
 * its lease. The answer tells it whether the operator asked to cancel the Run (Issue #100).
 * The Run's `recordHeartbeat` decides under its row lock, so a heartbeat and the lost-worker
 * sweep never both win (Issue #169). Throws {@link RunNotFoundError} or `RunNotHeldError`.
 */
@Injectable()
export class RecordHeartbeatHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: RecordHeartbeatInput): Promise<RecordHeartbeatResult> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    let answer: RecordHeartbeatResult | undefined;
    const saved = await this.runs.change(input.runId, (run) => {
      answer = run.recordHeartbeat(input.workerId, this.clock.now());
    });
    if (!saved || !answer) throw new RunNotFoundError();
    return answer;
  }
}
