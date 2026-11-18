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
  requested: number;
}

/** Only records requests, and removes finished lookups older than a week. */
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
