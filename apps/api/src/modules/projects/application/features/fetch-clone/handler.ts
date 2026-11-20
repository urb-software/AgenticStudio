import { Inject, Injectable } from '@nestjs/common';
import { NoTrustedHostKeyError } from '../../../domain/errors/repository-connection-errors.js';
import { RepositoryFailure } from '../../../domain/value-objects/repository-failure.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import {
  GitCloneMissingError,
  GitOperationError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';
import { DEPLOY_KEYS, type DeployKeys } from '../../ports/deploy-keys.js';

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function gitStepFailure(error: unknown): RepositoryFailure | undefined {
  if (error instanceof NoTrustedHostKeyError) {
    return RepositoryFailure.noTrustedHostKey();
  }
  if (error instanceof GitOperationError)
    return RepositoryFailure.fromGit(error.reason, error.detail);
  return undefined;
}

export const CLONE_MISSING_DETAIL =
  "Studio's clone of the repository is missing. Retry to clone it again.";

export interface FetchCloneInput {
  projectId: string;
  signal: AbortSignal;
}

@Injectable()
export class FetchCloneHandler {
  constructor(
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(DEPLOY_KEYS) private readonly deployKeys: DeployKeys,
  ) {}

  /** Runs one fetch. Aborts propagate, so the queue reports them to the unfinished-job recording. */
  async execute(input: FetchCloneInput): Promise<void> {
    const { projectId, signal } = input;
    signal.throwIfAborted();
    const repository = await this.repositories.find(projectId);
    // A job left over from before a restart, whose fetch reconciliation already failed.
    if (repository?.pendingOperation !== 'fetch') return;
    const { url, integrationBranch } = repository;
    try {
      const ssh = await this.deployKeys.credentials(repository);
      const { commit } = await this.git.fetch(projectId, url, integrationBranch, { signal, ssh });
      signal.throwIfAborted();
      const clone = { headSha: commit, fetchedAt: new Date() };
      await this.repositories.change(projectId, (stored) => {
        stored.completeFetch(clone);
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      if (error instanceof GitCloneMissingError) {
        // The database said there was a Clone, but it is gone from disk: record that there is
        // no usable Clone, so the card offers Retry instead of a Fetch that always fails.
        await this.fail(projectId, RepositoryFailure.of('unknown', CLONE_MISSING_DETAIL), {
          cloneKept: false,
        });
        return;
      }
      const failure = gitStepFailure(error);
      if (failure) {
        // `size_limit`: the adapter removed the Clone.
        await this.fail(projectId, failure, { cloneKept: failure.code !== 'size_limit' });
        return;
      }
      // Unexpected (a rejected request, the database): the unfinished-job recording stores `unknown`.
      throw error;
    }
  }

  /** A late write changes nothing: only a Repository still `fetching` takes the failure. */
  private async fail(
    projectId: string,
    failure: RepositoryFailure,
    outcome: { cloneKept: boolean },
  ): Promise<void> {
    await this.repositories.change(projectId, (stored) => {
      stored.failFetch(failure, outcome);
    });
  }
}
