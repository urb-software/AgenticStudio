import { Inject, Injectable } from '@nestjs/common';
import type { DefinitionsBlobsResult } from '../../../contracts/index.js';
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

export interface ReadDefinitionsBlobsInput {
  commit: string;
  paths: readonly string[];
  maxBytes: number;
}

export type ReadDefinitionsBlobsResult = DefinitionsBlobsResult;

/**
 * Reads the stored bytes of files of the definitions Project's Clone at a commit, from Git's
 * object store: no checkout and no working-tree change. A path that names no regular file is
 * `missing`.
 */
@Injectable()
export class ReadDefinitionsBlobsHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
  ) {}

  async execute(input: ReadDefinitionsBlobsInput): Promise<ReadDefinitionsBlobsResult> {
    const project = await this.projects.findDefinitions();
    if (!project || !(await this.repositories.find(project.id))) {
      return { status: 'repository_not_ready' };
    }
    try {
      const reads = await this.git.readBlobsAtCommit(
        project.id,
        input.commit,
        input.paths,
        input.maxBytes,
      );
      return {
        status: 'read',
        files: reads.map(({ path, outcome }) =>
          outcome.status === 'found'
            ? { path, status: 'found', bytes: outcome.bytes }
            : { path, status: outcome.status },
        ),
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
