import { Inject, Injectable } from '@nestjs/common';
import { RUN_START_POINTS, type RunStartPoints } from '../../../../projects/contracts/index.js';
import { runView, type RunView } from '../../run-view.js';
import { RunProjectNotFoundError } from '../../../domain/errors/run-errors.js';
import {
  PREPARED_FOLLOW_UP_REPOSITORY,
  type PreparedFollowUpRepository,
} from '../../../domain/repositories/prepared-follow-up-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';

export interface ListProjectRunsInput {
  projectId: string;
}

export type ListProjectRunsResult = RunView[];

/** Throws {@link RunProjectNotFoundError} for an unknown project. */
@Injectable()
export class ListProjectRunsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_START_POINTS) private readonly projects: RunStartPoints,
    @Inject(PREPARED_FOLLOW_UP_REPOSITORY)
    private readonly preparedFollowUps: PreparedFollowUpRepository,
  ) {}

  async execute(input: ListProjectRunsInput): Promise<ListProjectRunsResult> {
    const startPoint = await this.projects.forProject(input.projectId);
    if (startPoint.status === 'project_not_found') throw new RunProjectNotFoundError();
    const runs = await this.runs.listByProjectNewestFirst(input.projectId);
    const prepared = await this.preparedFollowUps.findRunIdsAmong(runs.map((run) => run.id));
    return runs.map((run) => runView(run, { preparedFollowUp: prepared.has(run.id) }));
  }
}
