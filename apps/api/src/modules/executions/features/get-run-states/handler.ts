import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  RUN_REPOSITORY,
  type RunRepository,
  type RunStateView,
} from '../../domain/repositories/run-repository.js';

/**
 * Query (Issue #98): the agent worker asks for the states of the Runs it keeps Working copies
 * for, to apply the retention rules: which are final, and since when. Ids that name no Run
 * are left out, so the worker removes their directories. The shared contract has validated
 * every id as a UUID. Issue #141: the worker also reports the Runs whose Working copies its
 * retention removed; Studio records it (only for final Runs that worker holds the Working copy
 * of), so their pages say a Follow-up is no longer possible.
 */
@Injectable()
export class GetRunStatesHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    runIds: readonly string[],
    removed: { workerId: string; runIds: readonly string[] } = { workerId: '', runIds: [] },
  ): Promise<RunStateView[]> {
    if (removed.runIds.length > 0) {
      await this.runs.markWorkingCopiesRemoved(
        removed.workerId,
        [...new Set(removed.runIds)],
        this.clock.now(),
      );
    }
    return this.runs.findStates([...new Set(runIds)]);
  }
}
