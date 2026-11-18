import { Inject, Injectable } from '@nestjs/common';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import { RepositoryConnection } from '../../../domain/entities/repository-connection.js';
import { type RepositoryConnectionSnapshot } from '../../../domain/entities/repository-connection-snapshot.js';
import {
  RepositoryNotVerifiableError,
  NoRepositoryError,
} from '../../../domain/errors/repository-connection-errors.js';
import {
  PROJECT_REPOSITORY,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  REPOSITORY_CONNECTION_REPOSITORY,
  type RepositoryConnectionRepository,
} from '../../../domain/repositories/repository-connection-repository.js';
import { RepositoryFailure } from '../../../domain/value-objects/repository-failure.js';
import { REPOSITORY_JOBS, type RepositoryJobs } from '../../ports/repository-jobs.js';
import {
  GitOperationError,
  REPOSITORY_GIT,
  type RepositoryGit,
} from '../../ports/repository-git.js';
import { DEPLOY_KEYS, type DeployKeys } from '../../ports/deploy-keys.js';
import { ProjectNotFoundError } from '../../../domain/errors/project-errors.js';

export interface VerifyRepositoryInput {
  projectId: string;
  acceptHostKeyFingerprint?: string;
}

export type VerifyRepositoryResult = RepositoryConnectionSnapshot;

/** How long retrieving a host key may take; the request waits for it. */
export const HOST_KEY_SCAN_TIMEOUT_MS = 30_000;

/**
 * Clones a trusted host at once, otherwise waits for the operator to confirm the host key's
 * fingerprint.
 */
@Injectable()
export class VerifyRepositoryHandler {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(REPOSITORY_CONNECTION_REPOSITORY)
    private readonly repositories: RepositoryConnectionRepository,
    @Inject(REPOSITORY_GIT) private readonly git: RepositoryGit,
    @Inject(REPOSITORY_JOBS) private readonly jobs: RepositoryJobs,
    @Inject(DEPLOY_KEYS) private readonly deployKeys: DeployKeys,
  ) {}

  async execute(input: VerifyRepositoryInput): Promise<VerifyRepositoryResult> {
    const { projectId, acceptHostKeyFingerprint } = input;
    if (!isProjectId(projectId)) throw new ProjectNotFoundError();
    this.git.assertSupported();

    const repository = await this.repositories.find(projectId);
    if (!repository) {
      throw (await this.projects.findById(projectId))
        ? new NoRepositoryError()
        : new ProjectNotFoundError();
    }
    repository.assertVerifiable();

    if (acceptHostKeyFingerprint !== undefined) {
      const pendingHostKey = repository.confirmedHostKey(acceptHostKeyFingerprint);
      return (await this.startClone(repository, { pendingHostKey })).snapshot();
    }

    if (!this.deployKeys.trustedHostKeys(repository).isEmpty) {
      return (await this.startClone(repository, null)).snapshot();
    }

    let hostKey: string;
    try {
      ({ hostKey } = await this.git.scanHostKey(repository.url, {
        timeoutMs: HOST_KEY_SCAN_TIMEOUT_MS,
      }));
    } catch (error) {
      if (!(error instanceof GitOperationError)) throw error;
      const failure = RepositoryFailure.fromGit(error.reason, error.detail);
      await this.repositories.change(projectId, (stored) => {
        stored.failVerification(failure);
      });
      return (await this.current(projectId)).snapshot();
    }
    const awaiting = await this.repositories.change(projectId, (stored) => {
      stored.awaitHostKey(hostKey);
    });
    if (!awaiting) throw new RepositoryNotVerifiableError();
    return awaiting.snapshot();
  }

  /**
   * → `connecting` (pinning a confirmed key), then schedules the clone; if that fails, the
   * Repository is `failed` again, as in connect.
   */
  private async startClone(
    previous: RepositoryConnection,
    confirmed: { pendingHostKey: string } | null,
  ): Promise<RepositoryConnection> {
    const { projectId } = previous;
    // A Repository another request changed since it was read refuses with the domain's error.
    const started = await this.repositories.change(projectId, (stored) => {
      stored.startVerifiedClone(confirmed);
    });
    if (!started) throw new RepositoryNotVerifiableError();
    try {
      await this.jobs.start(projectId, 'clone');
    } catch (error) {
      const failure = RepositoryConnection.failureWhenCloneNotScheduled(previous);
      await this.repositories.change(projectId, (stored) => {
        stored.failClone(failure);
      });
      throw error;
    }
    return started;
  }

  private async current(projectId: string): Promise<RepositoryConnection> {
    const repository = await this.repositories.find(projectId);
    if (!repository) throw new NoRepositoryError();
    return repository;
  }
}
