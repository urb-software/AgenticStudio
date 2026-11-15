import { Inject, Injectable } from '@nestjs/common';
import type { RunStartPoint, RunStartPoints } from '../../contracts/index.js';
import { isProjectId } from '../../domain/entities/project.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';

/**
 * Query (Issue #96): the commit a Run of a project starts from, for `executions` through the
 * public {@link RunStartPoints} contract. Only a `ready` Repository qualifies: while it is
 * being fetched, its commit is about to change.
 */
@Injectable()
export class GetRunStartPointHandler implements RunStartPoints {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async forProject(projectId: string): Promise<RunStartPoint> {
    if (!isProjectId(projectId) || !(await this.projects.findById(projectId))) {
      return { status: 'project_not_found' };
    }
    const repository = await this.projects.findRepository(projectId);
    if (!repository) return { status: 'no_repository' };
    if (repository.state !== 'ready' || repository.headSha === null) {
      return { status: 'repository_not_ready' };
    }
    return { status: 'ready', startCommit: repository.headSha };
  }
}
