import { Inject, Injectable } from '@nestjs/common';
import {
  DAILY_REFRESH_AGE_HOURS,
  DAILY_REFRESH_BATCH,
  FINISHED_LOOKUPS_KEPT_DAYS,
} from '../../../domain/value-objects/run-lookup.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../../domain/repositories/run-lookup-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RunLookupRequests } from '../../run-lookup-requests.js';

export interface RequestDailyPullRequestRefreshesResult {
  /** How many requests were recorded. */
  requested: number;
}

/**
 * Command (Issue #142): the daily refresh. Records a pull request lookup for every Run that has a
 * pull request which is draft, open or of unknown state and was last asked about more than a day ago (or
 * never), so a pull request merged or closed on GitHub is noticed even if nobody opens its Run.
 * It only records requests: an agent worker carries them out with read access through the Agent
 * account, and no agent CLI is started. A merged, closed or missing pull request is not asked
 * about again here; the Run page's own refresh finds it if it is reopened. It also removes finished lookups older
 * than a week. Returns how many requests it recorded.
 */
@Injectable()
export class RequestDailyPullRequestRefreshesHandler {
  constructor(
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    private readonly requests: RunLookupRequests,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<RequestDailyPullRequestRefreshesResult> {
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - DAILY_REFRESH_AGE_HOURS * 60 * 60 * 1000);
    // Finished lookups are not kept for ever (review S10 of #152).
    await this.lookups.deleteFinishedBefore(
      new Date(now.getTime() - FINISHED_LOOKUPS_KEPT_DAYS * 24 * 60 * 60 * 1000),
    );
    let requested = 0;
    for (const runId of await this.runs.listDueForDailyRefresh(staleBefore, DAILY_REFRESH_BATCH)) {
      if ((await this.requests.request(runId, 'pull_request_state', now)) === 'requested') {
        requested++;
      }
    }
    return { requested };
  }
}
