import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export interface RecordHeartbeatInput {
  runId: string;
  workerId: string;
}

export interface RecordHeartbeatResult {
  cancelRequested: boolean;
}

/**
 * Decided under the Run's row lock, so a heartbeat and the lost-worker sweep never both win.
 * Throws {@link RunNotFoundError} or `RunNotHeldError`.
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
