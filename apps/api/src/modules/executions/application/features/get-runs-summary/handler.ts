import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_REPOSITORY,
  type RunRepository,
  type RunsSummary,
} from '../../../domain/repositories/run-repository.js';

export type GetRunsSummaryResult = RunsSummary;

/**
 * Query (Issue #115): how many Runs are under way (queued, preparing or running) and how many
 * wait for the operator, for the top bar's run indicator. Two counts, not the Runs themselves.
 */
@Injectable()
export class GetRunsSummaryHandler {
  constructor(@Inject(RUN_REPOSITORY) private readonly runs: RunRepository) {}

  execute(): Promise<GetRunsSummaryResult> {
    return this.runs.summarize();
  }
}
