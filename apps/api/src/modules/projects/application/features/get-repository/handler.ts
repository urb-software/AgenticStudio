import { Inject, Injectable } from '@nestjs/common';
import type { RepositoryConnectionSnapshot } from '../../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';

export interface GetRepositoryInput {
  projectId: string;
}

/** The project's Repository, or `null` when none is connected. */
export type GetRepositoryResult = RepositoryConnectionSnapshot | null;

/**
 * Query: the project's Repository (the web app polls it while `connecting`), or `null` when
 * none is connected. Throws {@link ProjectNotFoundError} for an unknown project.
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
