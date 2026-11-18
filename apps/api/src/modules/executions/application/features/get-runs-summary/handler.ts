import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_REPOSITORY,
  type RunRepository,
  type RunsSummary,
} from '../../../domain/repositories/run-repository.js';

export type GetRunsSummaryResult = RunsSummary;

@Injectable()
export class GetRunsSummaryHandler {
  constructor(@Inject(RUN_REPOSITORY) private readonly runs: RunRepository) {}

  execute(): Promise<GetRunsSummaryResult> {
    return this.runs.summarize();
  }
}
