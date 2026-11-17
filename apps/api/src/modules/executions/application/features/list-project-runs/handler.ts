import { Inject, Injectable } from '@nestjs/common';
import { RUN_START_POINTS, type RunStartPoints } from '../../../../projects/contracts/index.js';
import { type Run, RunProjectNotFoundError } from '../../../domain/entities/run.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';

/**
 * Query (Issue #96): a project's Runs, newest first. Throws {@link RunProjectNotFoundError}
 * for an unknown project (asked of `projects` through its public contract).
 */
@Injectable()
export class ListProjectRunsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_START_POINTS) private readonly projects: RunStartPoints,
  ) {}

  async execute(projectId: string): Promise<Run[]> {
    const startPoint = await this.projects.forProject(projectId);
    if (startPoint.status === 'project_not_found') throw new RunProjectNotFoundError();
    return this.runs.listByProjectNewestFirst(projectId);
  }
}
