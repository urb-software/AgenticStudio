import { Inject, Injectable } from '@nestjs/common';
import type { RepositoryConnectionSnapshot } from '../../../domain/entities/repository-connection-snapshot.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import { ProjectNotFoundError } from '../../../domain/errors/project-errors.js';

export interface GetRepositoryInput {
  projectId: string;
}

export type GetRepositoryResult = RepositoryConnectionSnapshot | null;

/**
 * `null` when none is connected. Throws {@link ProjectNotFoundError} for an unknown project.
 */
@Injectable()
export class GetRepositoryHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
  ) {}

  async execute(input: GetRepositoryInput): Promise<GetRepositoryResult> {
    const { projectId } = input;
    if (!isProjectId(projectId)) throw new ProjectNotFoundError();
    const repository = await this.repositories.find(projectId);
    if (repository) return repository.snapshot();
    if (!(await this.projects.findById(projectId))) throw new ProjectNotFoundError();
    return null;
  }
}
