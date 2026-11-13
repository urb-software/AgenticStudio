import { Inject, Injectable } from '@nestjs/common';
import { isProjectId } from '../../domain/entities/project.js';
import type { Repository } from '../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';

/**
 * Query: the project's Repository (the web app polls it while `connecting`), or `null` when
 * none is connected. Throws {@link ProjectNotFoundError} for an unknown project.
 */
@Injectable()
export class GetRepositoryHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(projectId: string): Promise<Repository | null> {
    if (!isProjectId(projectId)) throw new ProjectNotFoundError();
    const repository = await this.projects.findRepository(projectId);
    if (repository) return repository;
    if (!(await this.projects.findById(projectId))) throw new ProjectNotFoundError();
    return null;
  }
}
