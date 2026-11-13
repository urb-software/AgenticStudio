import { Inject, Injectable } from '@nestjs/common';
import { isProjectId, type Project } from '../../domain/entities/project.js';
import type { Repository } from '../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../domain/repositories/project-repository.js';

export interface ProjectDetail {
  project: Project;
  repository: Repository | null;
}

/** Query: one project with its Repository, or `null` for an unknown id. */
@Injectable()
export class GetProjectHandler {
  constructor(@Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository) {}

  async execute(projectId: string): Promise<ProjectDetail | null> {
    if (!isProjectId(projectId)) return null;
    const project = await this.projects.findById(projectId);
    if (!project) return null;
    return { project, repository: await this.projects.findRepository(projectId) };
  }
}
