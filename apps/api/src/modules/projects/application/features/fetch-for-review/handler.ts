import { Inject, Injectable } from '@nestjs/common';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import {
  InvalidReviewedRunBranchError,
  ReviewedRunBranch,
} from '../../../domain/value-objects/reviewed-run-branch.js';
import { NoTrustedHostKeyError } from '../../../domain/errors/repository-connection-errors.js';
import { DEPLOY_KEYS, type DeployKeys } from '../../ports/deploy-keys.js';
import {
  GitCloneMissingError,
  GitOperationError,
  GitRequestRejectedError,
  GitUnsupportedPlatformError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';

export interface FetchForReviewInput {
  projectId: string;
  runId: string;
  runBranch: string;
}

export type FetchForReviewResult =
  | { status: 'ready'; runCommit: string; integrationCommit: string }
  | {
      status: 'repository_not_ready' | 'branch_not_found' | 'unsupported_platform' | 'failed';
      detail?: string;
    };

/**
 * Only a `ready` Repository qualifies, as for a Run start. Every Git failure is an answer;
 * only an unexpected error propagates.
 */
@Injectable()
export class FetchForReviewHandler {
  constructor(
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(DEPLOY_KEYS) private readonly deployKeys: DeployKeys,
  ) {}

  async execute(input: FetchForReviewInput): Promise<FetchForReviewResult> {
    const { projectId, runId, runBranch } = input;
    let branch: ReviewedRunBranch;
    try {
      branch = ReviewedRunBranch.of(runId, runBranch);
    } catch (error) {
      if (error instanceof InvalidReviewedRunBranchError) {
        return { status: 'failed', detail: error.message };
      }
      throw error;
    }
    const repository = isProjectId(projectId) ? await this.repositories.find(projectId) : null;
    if (!repository || repository.state !== 'ready') return { status: 'repository_not_ready' };
    try {
      const ssh = await this.deployKeys.credentials(repository);
      const fetched = await this.git.fetchForReview(
        projectId,
        repository.url,
        repository.integrationBranch,
        runId,
        branch.name,
        { ssh },
      );
      return { status: 'ready', ...fetched };
    } catch (error) {
      if (error instanceof GitUnsupportedPlatformError) return { status: 'unsupported_platform' };
      if (error instanceof GitCloneMissingError) return { status: 'repository_not_ready' };
      if (error instanceof NoTrustedHostKeyError) {
        return { status: 'failed', detail: 'No trusted host key for the Repository.' };
      }
      if (error instanceof GitOperationError) {
        if (error.reason === 'branch_not_found') return { status: 'branch_not_found' };
        return { status: 'failed', detail: error.detail || error.reason };
      }
      if (error instanceof GitRequestRejectedError) {
        return { status: 'failed', detail: error.message };
      }
      throw error;
    }
  }
}
