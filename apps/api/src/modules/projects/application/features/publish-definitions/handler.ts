import { Inject, Injectable } from '@nestjs/common';
import type {
  DefinitionsPublishInput,
  DefinitionsPublishResult,
} from '../../../contracts/index.js';
import { NoTrustedHostKeyError } from '../../../domain/errors/repository-connection-errors.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { DEPLOY_KEYS, type DeployKeys } from '../../ports/deploy-keys.js';
import {
  GitCloneMissingError,
  GitCommitMissingError,
  GitNothingToCommitError,
  GitOperationError,
  GitRemoteMovedError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
  GitWriteRefusedError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';

export type PublishDefinitionsInput = DefinitionsPublishInput;
export type PublishDefinitionsResult = DefinitionsPublishResult;

/**
 * Commits and pushes the changes to the definitions Project's Integration branch: a `ready`
 * Repository whose Clone is at the base, and no other Project. Every Git outcome is an answer
 * without Git text in it; after the push the Clone's commit moves on.
 */
@Injectable()
export class PublishDefinitionsHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(DEPLOY_KEYS) private readonly deployKeys: DeployKeys,
  ) {}

  async execute(input: PublishDefinitionsInput): Promise<PublishDefinitionsResult> {
    const project = await this.projects.findDefinitions();
    const repository = project ? await this.repositories.find(project.id) : null;
    if (!project || !repository || repository.state !== 'ready') {
      return { status: 'repository_not_ready' };
    }
    if (repository.headSha !== input.baseCommit) return { status: 'repository_moved' };
    try {
      const ssh = await this.deployKeys.credentials(repository);
      const { commit } = await this.git.publishCommit(
        project.id,
        repository.url,
        {
          branch: repository.integrationBranch,
          baseCommit: input.baseCommit,
          changes: input.changes,
          message: input.message,
          identity: input.identity,
        },
        { ssh },
      );
      // Only from the commit the publish was built on, and only while still `ready`.
      await this.repositories.change(project.id, (stored) => {
        stored.recordPublished({ commit, from: input.baseCommit });
      });
      return { status: 'published', commit };
    } catch (error) {
      if (error instanceof GitUnsupportedPlatformError) return { status: 'unsupported_platform' };
      if (error instanceof GitCloneMissingError) return { status: 'repository_not_ready' };
      if (error instanceof GitRemoteMovedError || error instanceof GitCommitMissingError) {
        return { status: 'repository_moved' };
      }
      if (error instanceof GitWriteRefusedError) return { status: 'write_refused' };
      if (error instanceof GitNothingToCommitError) return { status: 'nothing_to_publish' };
      if (
        error instanceof NoTrustedHostKeyError ||
        error instanceof GitOperationError ||
        error instanceof GitRequestRejectedError
      ) {
        return { status: 'failed' };
      }
      throw error;
    }
  }
}
