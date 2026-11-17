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

export interface ResumeRunInput {
  runId: string;
}

export interface ResumeRunResult {
  /** The Run as it is now, queued again. */
  run: RunSnapshot;
  /** Whether a prepared Follow-up waits for the operator (the Run page shows it). */
  preparedFollowUp: boolean;
}

/**
 * Command (Issue #105): the operator resumes a Run that stopped at the subscription's usage
 * limit, typically once the limit has reset. "Continue where you stopped." is stored as the
 * operator's answer and the Run goes back to `queued`; the agent worker that holds its Working
 * copy then claims it and resumes the same agent session, exactly like an answered Run (Issue
 * #103). Only a `failed` Run with `usage_limit`, a session and a Working copy can be resumed;
 * a second request is refused. Like an answered Run it holds its project's place and one of the
 * server's, so it is refused while those are taken (review R1 of #129). The Run's
 * `resumeAfterUsageLimit` method decides, with the places the repository reads under the lock
 * that serializes claims. Throws
 * `RunNotFoundError`, `RunNotResumableError` or `RunSlotTakenError`.
 */
@Injectable()
export class ResumeRunHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY)
    private readonly preparedFollowUps: PreparedFollowUpRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: ResumeRunInput): Promise<ResumeRunResult> {
    if (!isRunId(input.runId)) throw new RunNotFoundError();
    const now = this.clock.now();
    const resumed = await this.runs.changeSerializedWithClaims(input.runId, (run, facts) =>
      run.resumeAfterUsageLimit(now, facts),
    );
    if (!resumed) throw new RunNotFoundError();
    return {
      run: resumed.snapshot(),
      preparedFollowUp: (await this.preparedFollowUps.findRunIdsAmong([resumed.id])).has(
        resumed.id,
      ),
    };
  }
}
