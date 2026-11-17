import { Inject, Injectable } from '@nestjs/common';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import type { RepositoryOperation } from '../../ports/repository-jobs.js';

/**
 * Query: which background operation the Repository's job runs. The Repository's state says it:
 * `connecting` runs the clone, `fetching` runs the fetch. `null` when the project has no
 * Repository or it is in any other state (a job left over from before a restart, or one of a
 * Repository that is now disconnecting): there is then nothing for the job to do.
 */
@Injectable()
export class GetRepositoryOperationHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(projectId: string): Promise<RepositoryOperation | null> {
    const repository = await this.projects.findRepository(projectId);
    if (repository?.state === 'connecting') return 'clone';
    if (repository?.state === 'fetching') return 'fetch';
    return null;
  }
}
