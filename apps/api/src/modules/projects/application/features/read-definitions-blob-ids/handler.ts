import { Inject, Injectable } from '@nestjs/common';
import type { DefinitionsBlobIdsResult } from '../../../contracts/index.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import {
  GitCloneMissingError,
  GitCommitMissingError,
  GitOperationError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';

export interface ReadDefinitionsBlobIdsInput {
  commit: string;
  paths: readonly string[];
}

export type ReadDefinitionsBlobIdsResult = DefinitionsBlobIdsResult;

/**
 * The Git object name of each file of the definitions Project's Clone at a commit, from Git's
 * object store: no checkout, and no file is read. A path that names no regular file has none.
 */
@Injectable()
export class ReadDefinitionsBlobIdsHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
  ) {}

  async execute(input: ReadDefinitionsBlobIdsInput): Promise<ReadDefinitionsBlobIdsResult> {
    const project = await this.projects.findDefinitions();
    if (!project || !(await this.repositories.find(project.id))) {
      return { status: 'repository_not_ready' };
    }
    try {
      const blobs = await this.git.blobIdsAtCommit(project.id, input.commit, input.paths);
      return {
        status: 'read',
        blobs: blobs.map(({ path, blob, executable }) => ({ path, blob, executable })),
      };
    } catch (error) {
      if (error instanceof GitUnsupportedPlatformError) return { status: 'unsupported_platform' };
      if (error instanceof GitCloneMissingError) return { status: 'repository_not_ready' };
      if (error instanceof GitCommitMissingError) return { status: 'commit_missing' };
      if (error instanceof GitOperationError || error instanceof GitRequestRejectedError) {
        return { status: 'failed' };
      }
      throw error;
    }
  }
}
