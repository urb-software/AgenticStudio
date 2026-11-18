import { Inject, Injectable } from '@nestjs/common';
import type { RunSnapshot } from '../../../domain/entities/run-snapshot.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';

export type ListRunsResult = {
  run: RunSnapshot;
  preparedFollowUp: boolean;
}[];

@Injectable()
export class ListRunsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY)
    private readonly preparedFollowUps: PreparedFollowUpRepository,
  ) {}

  async execute(): Promise<ListRunsResult> {
    const runs = await this.runs.listNewestFirst();
    const prepared = await this.preparedFollowUps.findRunIdsAmong(runs.map((run) => run.id));
    return runs.map((run) => ({ run, preparedFollowUp: prepared.has(run.id) }));
  }
}
