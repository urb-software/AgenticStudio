import { Inject, Injectable } from '@nestjs/common';
import { PullRequestRefreshRule } from '../../../domain/value-objects/pull-request-refresh-rule.js';
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
    const rule = PullRequestRefreshRule.at(now);
    await this.lookups.deleteFinishedBefore(rule.finishedLookupsBefore);
    let requested = 0;
    for (const runId of await this.runs.listDueForDailyRefresh(
      rule.staleBefore,
      PullRequestRefreshRule.BATCH,
    )) {
      if ((await this.requests.request(runId, 'pull_request_state', now)) === 'requested') {
        requested++;
      }
    }
    return { requested };
  }
}
