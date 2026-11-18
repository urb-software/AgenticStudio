import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type RunSnapshot } from '../../../domain/entities/run-snapshot.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export interface ResumeRunInput {
  runId: string;
}

export interface ResumeRunResult {
  run: RunSnapshot;
  preparedFollowUp: boolean;
}

/**
 * Holds its project's place and one of the server's, like an answered Run; `resumeAfterUsageLimit` decides with the places read under the lock that serializes claims.
 * Throws `RunNotFoundError`, `RunNotResumableError` or `RunSlotTakenError`.
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
