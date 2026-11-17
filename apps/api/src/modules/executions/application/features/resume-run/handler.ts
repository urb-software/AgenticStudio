import { Inject, Injectable } from '@nestjs/common';
import {
  isRunId,
  type Run,
  RunNotResumableError,
  RunSlotTakenError,
  USAGE_LIMIT_RESUME_TEXT,
} from '../../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

/**
 * Command (Issue #105): the operator resumes a Run that stopped at the subscription's usage
 * limit, typically once the limit has reset. "Continue where you stopped." is stored as the
 * operator's answer and the Run goes back to `queued`; the agent worker that holds its Working
 * copy then claims it and resumes the same agent session, exactly like an answered Run (Issue
 * #103). Only a `failed` Run with `usage_limit`, a session and a Working copy can be resumed;
 * a second request is refused. Like an answered Run it holds its project's place and one of the
 * server's, so it is refused while those are taken (review R1 of #129). Throws
 * {@link RunNotFoundError}, {@link RunNotResumableError} or {@link RunSlotTakenError}.
 */
@Injectable()
export class ResumeRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(runId: string): Promise<Run> {
    const run = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!run) throw new RunNotFoundError();
    const outcome = await this.runs.resumeAfterUsageLimit(
      run.id,
      USAGE_LIMIT_RESUME_TEXT,
      this.clock.now(),
    );
    if (outcome.status === 'slot_taken') throw new RunSlotTakenError(outcome.scope);
    if (outcome.status === 'not_resumable') throw new RunNotResumableError();
    return outcome.run;
  }
}
