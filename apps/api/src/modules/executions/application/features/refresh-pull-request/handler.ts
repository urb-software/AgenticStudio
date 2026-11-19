import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RunLookupRequests } from '../../run-lookup-requests.js';
import {
  PullRequestNotRefreshableError,
  RunNotFoundError,
} from '../../../domain/errors/run-errors.js';

export interface RefreshPullRequestInput {
  runId: string;
  /** Request on opening the Run page: at most one a minute per Run is recorded. */
  onOpen: boolean;
}

export type RefreshPullRequestResult = void;

/** Throws {@link RunNotFoundError} or {@link PullRequestNotRefreshableError}. */
@Injectable()
export class RefreshPullRequestHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    private readonly lookups: RunLookupRequests,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: RefreshPullRequestInput): Promise<RefreshPullRequestResult> {
    const { runId, onOpen } = input;
    const found = isRunId(runId) ? await this.runs.findById(runId) : null;
    if (!found) throw new RunNotFoundError();
    if (!found.canRefreshPullRequest()) throw new PullRequestNotRefreshableError();
    const now = this.clock.now();
    if (!onOpen || found.pullRequestStatus.pageRefreshDue(now)) {
      const outcome = await this.lookups.request(found.id, 'pull_request_state', now);
      if (outcome === 'not_possible') throw new PullRequestNotRefreshableError();
    }
  }
}
