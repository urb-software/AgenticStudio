import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RunLookupRequests } from '../../run-lookup-requests.js';
import {
  RunNotFoundError,
  PullRequestNotRefreshableError,
} from '../../../domain/errors/run-errors.js';

export class NoFailingChecksError extends Error {
  constructor() {
    super('No pull request check of the run is known to have failed.');
    this.name = 'NoFailingChecksError';
  }
}

export interface PrepareFailingChecksInput {
  runId: string;
}

export type PrepareFailingChecksResult = void;

/**
 * Throws {@link RunNotFoundError}, {@link PullRequestNotRefreshableError} or
 * {@link NoFailingChecksError}.
 */
@Injectable()
export class PrepareFailingChecksHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    private readonly lookups: RunLookupRequests,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: PrepareFailingChecksInput): Promise<PrepareFailingChecksResult> {
    const { runId } = input;
    const found = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!found) throw new RunNotFoundError();
    if (!found.canRefreshPullRequest()) throw new PullRequestNotRefreshableError();
    if (!found.pullRequestStatus.hasFailedCheck) throw new NoFailingChecksError();
    const now = this.clock.now();
    const outcome = await this.lookups.request(found.id, 'failing_check_logs', now);
    if (outcome === 'not_possible') throw new PullRequestNotRefreshableError();
  }
}
