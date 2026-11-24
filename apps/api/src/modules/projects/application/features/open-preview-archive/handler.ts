import { Inject, Injectable } from '@nestjs/common';
import type { PreviewArchiveResult } from '../../../contracts/index.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import {
  GitCloneMissingError,
  GitOperationError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';

export interface OpenPreviewArchiveInput {
  projectId: string;
  commit: string;
  maxBytes: number;
}

export type OpenPreviewArchiveResult = PreviewArchiveResult;

/** Archives one commit of a `ready` Repository from the Clone's object store. */
@Injectable()
export class OpenPreviewArchiveHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
  ) {}

  async execute(input: OpenPreviewArchiveInput): Promise<OpenPreviewArchiveResult> {
    const { projectId, commit, maxBytes } = input;
    if (!isProjectId(projectId) || !(await this.projects.findById(projectId))) {
      return { status: 'repository_not_ready' };
    }
    const repository = await this.repositories.find(projectId);
    if (!repository || repository.state !== 'ready' || repository.headSha === null) {
      return { status: 'repository_not_ready' };
    }
    try {
      const outcome = await this.git.archiveCommit(projectId, commit, maxBytes);
      if (outcome.status !== 'archived') return outcome;
      const { archive } = outcome;
      return {
        status: 'ready',
        sizeBytes: archive.sizeBytes,
        chunks: archive.chunks(),
        close: () => archive.close(),
      };
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
