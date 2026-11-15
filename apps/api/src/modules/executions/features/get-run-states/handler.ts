import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_REPOSITORY,
  type RunRepository,
  type RunStateView,
} from '../../domain/repositories/run-repository.js';

/**
 * Query (Issue #98): the agent worker asks for the states of the Runs it keeps Working copies
 * for, to apply the retention rules: which are final, and since when. Ids that name no Run
 * are left out, so the worker removes their directories. The shared contract has validated
 * every id as a UUID.
 */
@Injectable()
export class GetRunStatesHandler {
  constructor(@Inject(RUN_REPOSITORY) private readonly runs: RunRepository) {}

  execute(runIds: readonly string[]): Promise<RunStateView[]> {
    return this.runs.findStates([...new Set(runIds)]);
  }
}
