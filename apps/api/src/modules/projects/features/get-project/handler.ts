import { Inject, Injectable } from '@nestjs/common';
import { isProjectId, type Project } from '../../domain/entities/project.js';
import type { RepositoryConnection } from '../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';

export interface ProjectDetail {
  project: Project;
  repository: RepositoryConnection | null;
}

/**
 * Query: one project with its Repository. Throws {@link ProjectNotFoundError} for an unknown
 * project, like `get-repository`.
 */
@Injectable()
export class GetProjectHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(projectId: string): Promise<ProjectDetail> {
    if (!isProjectId(projectId)) throw new ProjectNotFoundError();
    const project = await this.projects.findById(projectId);
    if (!project) throw new ProjectNotFoundError();
    return { project, repository: await this.projects.findRepository(projectId) };
  }
}
