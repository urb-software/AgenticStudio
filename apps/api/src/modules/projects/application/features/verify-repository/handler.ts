import { Inject, Injectable } from '@nestjs/common';
import { isProjectId } from '../../../domain/value-objects/project-id.js';
import {
  RepositoryConnection,
  type RepositoryConnectionSnapshot,
  RepositoryNotVerifiableError,
} from '../../../domain/entities/repository.js';
import {
  PROJECT_REPOSITORY,
  ProjectNotFoundError,
  type ProjectRepository,
} from '../../../domain/repositories/project-repository.js';
import {
  NoRepositoryError,
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

export interface VerifyRepositoryInput {
  projectId: string;
  /** The fingerprint the operator confirmed, when the Repository is `awaiting_host_key`. */
  acceptHostKeyFingerprint?: string;
}

/** The Repository as the verify left it. */
export type VerifyRepositoryResult = RepositoryConnectionSnapshot;

/** How long retrieving a host key may take; the request waits for it. */
export const HOST_KEY_SCAN_TIMEOUT_MS = 30_000;

/**
 * Command: Verify and clone (Issue #62), for an SSH Repository that is `awaiting_key`,
 * `awaiting_host_key`, or `failed` without a Clone (Retry, with the same Deploy key).
 *
 * - A host whose key is trusted (listed in `STUDIO_SSH_KNOWN_HOSTS`, or pinned for this
 *   Repository) is cloned at once: `connecting`, and the background clone is scheduled.
 * - Any other host: Studio retrieves its host key (in the request, time-limited) and the
 *   Repository waits in `awaiting_host_key` for the operator to confirm its fingerprint; a
 *   host that cannot be reached leaves it `failed`.
 * - With `acceptHostKeyFingerprint`: it must equal the pending key's fingerprint exactly
 *   ({@link HostKeyFingerprintMismatchError} otherwise); the key is then pinned and the clone
 *   scheduled, in one conditional write that pins exactly the key the operator saw.
 *
 * As for connect, a clone that cannot be scheduled leaves the Repository `failed` and the
 * queue's error is rethrown. Throws {@link ProjectNotFoundError}, {@link NoRepositoryError},
 * `GitUnsupportedPlatformError`, {@link RepositoryNotVerifiableError},
 * {@link HostKeyFingerprintMismatchError} and the queue's errors.
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
   * → `connecting` (pinning a confirmed key), then schedules the clone. If it cannot be
   * scheduled, the Repository is `failed` again with the failure a Retry replaced (e.g.
   * `auth_failed` and its guidance), else "could not be started", as connect does.
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
