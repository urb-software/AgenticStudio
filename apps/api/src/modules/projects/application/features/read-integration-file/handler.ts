import { Inject, Injectable } from '@nestjs/common';
import {
  INTEGRATION_FILE_MAX_BYTES,
  type IntegrationFileResult,
} from '../../../contracts/index.js';
import { InvalidEnvironmentFilePathError } from '../../../domain/errors/environment-file-errors.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { EnvironmentFilePath } from '../../../domain/value-objects/environment-file-path.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import {
  GitCloneMissingError,
  GitOperationError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';

export interface ReadIntegrationFileInput {
  projectId: string;
  path: string;
}

export type ReadIntegrationFileResult = IntegrationFileResult;

/**
 * Reads at the commit the Clone holds for a `ready` Repository, never from a working tree. The
 * caller has checked the path; it is checked again here, and an unsafe one is `failed`.
 */
@Injectable()
export class ReadIntegrationFileHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
  ) {}

  async execute(input: ReadIntegrationFileInput): Promise<ReadIntegrationFileResult> {
    const { projectId } = input;
    let path: EnvironmentFilePath;
    try {
      path = EnvironmentFilePath.of(input.path);
    } catch (error) {
      if (error instanceof InvalidEnvironmentFilePathError) return { status: 'failed' };
      throw error;
    }
    if (!isProjectId(projectId) || !(await this.projects.findById(projectId))) {
      return { status: 'project_not_found' };
    }
    const repository = await this.repositories.find(projectId);
    if (!repository || repository.state !== 'ready' || repository.headSha === null) {
      return { status: 'repository_not_ready' };
    }
    const commit = repository.headSha;
    try {
      const read = await this.git.readFileAtCommit(
        projectId,
        commit,
        path.value,
        INTEGRATION_FILE_MAX_BYTES,
      );
      return read.status === 'found' ? { status: 'found', text: read.text, commit } : read;
    } catch (error) {
      if (error instanceof GitUnsupportedPlatformError) return { status: 'unsupported_platform' };
      if (error instanceof GitCloneMissingError) return { status: 'repository_not_ready' };
      if (error instanceof GitOperationError || error instanceof GitRequestRejectedError) {
        return { status: 'failed' };
      }
      throw error;
    }
  }
}
